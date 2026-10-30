const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');
function fixture({ config = '{}', configError, rules, visibility = true, apiError = false, tokenError = false, cloneOrigin } = {}) {
  const calls = [], writes = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fakeFs = {
    readFileSync(file) {
      if (path.basename(file) === '.mem-mastero.json') {
        if (configError) throw Object.assign(new Error('config read failed'), { code: configError });
        return config;
      }
      if (path.basename(file) === 'mem-mastero.json' && rules !== undefined) return rules;
      throw missing();
    },
    mkdirSync() {},
    existsSync(file) { return cloneOrigin !== undefined && path.basename(file) === '.git'; },
    writeFileSync(...args) { writes.push(args); },
  };
  const child = {
    execFileSync(cmd, args) {
      if (cloneOrigin !== undefined && !args[1].endsWith(path.join('.mem-mastero', 'repo'))) return cloneOrigin + '\n';
      throw new Error('unexpected Git command');
    },
    spawnSync(cmd, args, options) {
      calls.push({ cmd, args, options });
      assert.equal(cmd, 'gh', 'privacy failure must stop before cloning or installing agents');
      if (args[0] === 'auth') return { status: tokenError ? 1 : 0, stdout: tokenError ? '' : 'test-account-token\n' };
      assert.equal(args[0], 'api');
      return apiError ? { status: 1, stderr: 'secret diagnostic must not escape' }
        : { status: 0, stdout: JSON.stringify({ private: visibility }) };
    },
  };
  const sandbox = {
    module: { exports: {} }, __filename: path.join(__dirname, 'sync.js'), __dirname,
    Buffer, URL, console: { log() {}, error() {} },
    process: { env: {}, platform: 'linux', stdin: { isTTY: false }, stdout: { isTTY: false }, argv: [] },
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'os') return { homedir: () => '/test-home' };
      if (name === 'child_process') return child;
      return require(name);
    },
  };
  vm.runInNewContext('(function () {\n' + source.replace(/^#![^\n]*\n/, '')
    + '\nmodule.exports = { readConfig, storesOf, ensurePrivateStore, storeRoot, setup };\n})()', sandbox);
  return { ...sandbox.module.exports, calls, writes };
}

(async () => {
  assert.equal(JSON.stringify(fixture({ configError: 'ENOENT' }).readConfig()), '{}', 'missing config keeps legacy Drive support');
  for (const config of ['{}', '{"dir":"/memory"}', '{"github":"https://github.com/me/memory.git"}', '{"stores":[]}']) {
    assert.equal(JSON.stringify(fixture({ config }).readConfig()), config);
  }
  assert.throws(() => fixture({ config: '{"stores":[' }).readConfig(), /invalid JSON.*sync stopped/);
  assert.throws(() => fixture({ configError: 'EACCES' }).readConfig(), /cannot read.*sync stopped/);
  for (const config of ['null', '[]', '{"stores":{}}', '{"store":[]}', '{"github":false}',
    '{"stores":[{"dir":42}]}', '{"stores":[{"github":"x","dir":"y"}]}',
    '{"stores":[{"for":"github.com/work"}]}', '{"stores":[{"for":[""]}]}']) {
    assert.throws(() => fixture({ config }).readConfig(), /invalid store configuration/);
  }

  for (const url of ['https://github.com/me/memory.git', 'git@github.com:me/memory.git', 'ssh://git@github.com/me/memory.git']) {
    const f = fixture();
    f.ensurePrivateStore({ github: url });
    assert.equal(f.calls[0].args.at(-1), 'repos/me/memory');
    f.ensurePrivateStore({ github: url });
    assert.equal(f.calls.length, 1, 'successful checks are reused only within this process');
    assert.throws(() => fixture({ visibility: false }).ensurePrivateStore({ github: url }), /refusing public memory repository/);
  }
  const selected = fixture();
  selected.ensurePrivateStore({ github: 'https://work-user@github.com/acme/memory.git' });
  assert.equal(selected.calls[0].args.at(-1), 'work-user');
  assert.equal(selected.calls[1].options.env.GH_TOKEN, 'test-account-token');
  assert.throws(() => fixture({ tokenError: true }).ensurePrivateStore({ github: 'https://work-user@github.com/acme/memory.git' }), /sign in to GitHub CLI with the account named/);
  assert.throws(() => fixture({ apiError: true }).ensurePrivateStore({ github: 'https://github.com/me/memory.git' }), /cannot verify.*sync stopped/);
  assert.throws(() => fixture({ visibility: null }).ensurePrivateStore({ github: 'https://github.com/me/memory.git' }), /cannot verify/);
  assert.throws(() => fixture().ensurePrivateStore({ github: 'https://work:secret@github.com/acme/memory.git' }), /must not contain a password or token/);
  assert.throws(() => fixture().ensurePrivateStore({ github: 'https://unknown.example/me/memory.git' }), /cannot verify/);
  for (const account of ['bad"&echo', 'bad%PATH%', '-invalid', 'invalid-']) {
    const f = fixture();
    assert.throws(() => f.ensurePrivateStore({ github: `https://${encodeURIComponent(account)}@github.com/me/memory.git` }), /invalid GitHub account name/);
    assert.equal(f.calls.length, 0, 'invalid decoded account never reaches a shell');
    await assert.rejects(f.setup(['--yes', '--account', account, '--repo', 'me/memory']), /invalid GitHub account name/);
    assert.equal(f.calls.length, 0, 'invalid setup account is rejected before any GitHub command');
  }
  const local = fixture();
  for (const github of [path.resolve('test-memory.git'), './memory.git', 'file:///test-memory.git']) local.ensurePrivateStore({ github });
  assert.equal(local.calls.length, 0, 'local bare repository fixtures need no network');
  for (const clone of [true, false]) {
    const collision = fixture({ cloneOrigin: 'https://github.com/acme_team/memory.git' });
    assert.throws(() => collision.storeRoot({ github: 'https://github.com/acme/team_memory.git' }, { clone }), /origin does not match/);
    assert.equal(collision.writes.length, 0, 'colliding clone names cannot mix stores');
  }
  const matching = fixture({ cloneOrigin: 'git@github.com:acme/memory.git' });
  assert(matching.storeRoot({ github: 'https://github.com/acme/memory.git' }).includes('github.com_acme_memory'), 'equivalent URL forms share the verified clone');

  for (const repo of ['me/memory', 'https://github.com/me/memory.git', 'git@github.com:me/memory.git']) {
    const f = fixture({ visibility: false });
    await assert.rejects(f.setup(['--yes', '--repo', repo]), /refusing public memory repository/);
    assert.equal(f.writes.length, 0, 'public repository never reaches config writes');
  }
  const broken = fixture({ config: '{' });
  await assert.rejects(broken.setup(['--yes', '--repo', 'me/memory']), /invalid JSON/);
  assert.equal(broken.calls.length, 0, 'bad existing config stops setup before external changes');
  for (const rules of ['{', '{}', '{"for":[]}', '{"for":"github.com/work"}']) {
    const f = fixture({ rules });
    await assert.rejects(f.setup(['--yes', '--dir', '/memory']), /invalid or unreadable project rules/);
    assert.equal(f.writes.length, 0, 'bad saved routing is never replaced by catch-all routing');
  }
  console.log('privacy tests ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
