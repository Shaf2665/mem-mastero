// No installations or network calls: exercise the real updater with mocked agent CLIs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');

function updater(options = {}) {
  const calls = [], output = [], removed = [];
  const lists = {
    claude: [{ id: 'mem-mastero@mem-mastero', scope: 'user' }, { id: 'unrelated@other' }],
    codex: { installed: [{ pluginId: 'mem-mastero@mem-mastero', enabled: true }, { pluginId: 'unrelated@other' }] },
    copilot: [{ name: 'mem-mastero', marketplace: 'mem-mastero' }, { name: 'unrelated', marketplace: 'other' }],
    ...options.lists,
  };
  const tempRoot = path.resolve('update-test-temp'), temp = path.join(tempRoot, 'mem-mastero-update-fixture');
  const home = path.resolve('update-test-home');
  const fakeFs = {
    mkdtempSync: () => temp,
    rmSync: p => removed.push(p),
    readFileSync: p => {
      assert.strictEqual(p, path.join(home, '.pi', 'agent', 'settings.json'), 'updater must not read or rewrite store configuration');
      return JSON.stringify({ packages: ['git:github.com/Shaf2665/mem-mastero', 'git:github.com/other/package', 'git:github.com/Shaf2665/mem-mastero-extra'] });
    },
  };
  const cp = {
    execFileSync: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'config') return options.hooks === false ? '' : path.join(home, '.mem-mastero', 'git-hooks');
      assert.strictEqual(args[0], 'clone');
      if (options.cloneFails) throw new Error('download failed');
      return '';
    },
    spawnSync: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === process.execPath) return { status: options.childStatus || 0 };
      if (args[0] === '--version') return { status: options.absent?.includes(cmd) ? 1 : 0 };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(lists[cmd]) };
      if (options.fail === cmd) return { status: 1, stderr: 'simulated failure' };
      return { status: 0, stdout: '' };
    },
  };
  const context = {
    require: name => name === 'fs' ? fakeFs : name === 'child_process' ? cp : name === 'os' ? { homedir: () => home, tmpdir: () => tempRoot } : require(name),
    process: { env: {}, platform: 'linux', execPath: process.execPath, argv: [], cwd: () => __dirname },
    module: { exports: {} }, __filename: path.join(__dirname, 'sync.js'), __dirname,
    console: { log: text => output.push(text), error: text => output.push(text) },
    refreshed: () => { calls.push(['refreshHookScript']); if (options.refreshFails) throw new Error('disk full'); },
  };
  const script = options.crlf ? source.replace(/\r?\n/g, '\r\n') : source;
  vm.runInNewContext('(function () {\n' + script.replace(/^#![^\n]*\n/, '') + '\nrefreshHookScript = refreshed; module.exports = { update };\n})();', context);
  return { run: context.module.exports.update, calls, output, removed, temp };
}

{
  const t = updater();
  t.run(['--local']);
  assert(t.calls.some(c => c.join(' ') === 'claude plugin update mem-mastero@mem-mastero --scope user'));
  assert(t.calls.some(c => c.join(' ') === 'codex plugin marketplace upgrade mem-mastero'));
  assert(t.calls.some(c => c.join(' ') === 'codex plugin add mem-mastero@mem-mastero'));
  assert(t.calls.some(c => c.join(' ') === 'copilot plugin update mem-mastero@mem-mastero'));
  assert(t.calls.some(c => c.join(' ') === 'pi update git:github.com/Shaf2665/mem-mastero'));
  assert(!t.calls.some(c => c.some(s => /unrelated|other\/package|mem-mastero-extra|--all/.test(s))));
  assert(t.calls.some(c => c[0] === 'refreshHookScript'));
}

{
  const t = updater({ fail: 'claude' });
  assert.throws(() => t.run(['--local']), /Update failed for claude/);
  assert(t.calls.some(c => c[0] === 'codex' && c[1] === 'plugin' && c[2] === 'add'), 'one agent failure must not block other updates');
  assert(t.calls.some(c => c[0] === 'refreshHookScript'), 'hook script still gets the available fixes');
  assert(t.output.some(s => s.includes('simulated failure')));
}

{
  const t = updater({ lists: { claude: [], copilot: [], codex: { installed: [{ pluginId: 'mem-mastero@mem-mastero', enabled: false }] } }, absent: ['pi'], hooks: false });
  t.run(['--local']);
  assert(!t.calls.some(c => c.includes('update') || c.includes('upgrade') || c.includes('add') || c[0] === 'refreshHookScript'));
  assert(t.output.some(s => s.includes('disabled')));
}

{
  const t = updater({ refreshFails: true, absent: ['claude', 'codex', 'copilot', 'pi'] });
  assert.throws(() => t.run(['--local']), /Update failed for Git hooks/);
}

for (const options of [{}, { childStatus: 1 }, { cloneFails: true }]) {
  const t = updater(options);
  if (options.childStatus || options.cloneFails) assert.throws(() => t.run(), /failed/);
  else t.run();
  assert(t.calls.some(c => c[0] === 'git' && c.includes('main') && c.includes('https://github.com/Shaf2665/mem-mastero.git')));
  if (!options.cloneFails) assert(t.calls.some(c => c[0] === process.execPath && c[1] === path.join(t.temp, 'sync.js') && c[3] === '--local'));
  assert.deepStrictEqual(t.removed, [t.temp]);
}

assert.throws(() => updater().run(['--unknown']), /Usage:/);
updater({ crlf: true }).run(['--local']); // Git for Windows may check the script out with CRLF.
const invalid = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'sync.js'), 'update', '--unknown'], { encoding: 'utf8' });
assert.strictEqual(invalid.status, 1, 'CLI reports updater errors with a failing exit code');
assert.match(invalid.stderr, /Usage:/);
for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.github/plugin/plugin.json']) {
  assert.strictEqual(require('./' + manifest).version, require('./package.json').version, 'agent plugin versions stay aligned');
}
console.log('update tests ok');
