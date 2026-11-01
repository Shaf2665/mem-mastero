const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { withLock } = require('./sync');

// Filesystem errors are not lock contention: fail immediately instead of spinning forever.
const open = fs.openSync;
try {
  for (const code of ['EACCES', 'ENOSPC', 'ENOENT']) {
    let attempts = 0;
    fs.openSync = () => { attempts++; throw Object.assign(new Error(code), { code }); };
    assert.throws(() => withLock('unused', () => assert.fail('must not enter the lock')), { code });
    assert.strictEqual(attempts, 1);
  }
} finally { fs.openSync = open; }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-recovery-'));
try {
  const lock = path.join(temp, 'store.lock');
  const now = Date.now(), old = new Date(now - 180000);
  fs.writeFileSync(lock, String(process.pid));
  fs.utimesSync(lock, old, old);
  const realNow = Date.now;
  let ticks = 0;
  Date.now = () => now + [0, 1, 2, 30001][Math.min(ticks++, 3)];
  try { assert.strictEqual(withLock(temp, () => assert.fail('live owner must keep the lock'), lock), false); }
  finally { Date.now = realNow; }
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid));
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, old, old);
  let ran = false;
  assert(withLock(temp, () => { ran = true; }, lock), 'stale legacy lock can be recovered');
  assert(ran && !fs.existsSync(lock), 'custom local store lock is released');

  // A competing waiter replaces the dead lock just before this waiter acquires the recovery guard.
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, old, old);
  let replaced = false;
  ticks = 0;
  Date.now = () => now + [0, 1, 2, 3, 30001][Math.min(ticks++, 4)];
  fs.openSync = (file, ...args) => {
    if (String(file) === lock + '.recover' && !replaced) {
      replaced = true;
      fs.writeFileSync(lock, String(process.pid));
      fs.utimesSync(lock, old, old);
    }
    return open(file, ...args);
  };
  try {
    assert.strictEqual(withLock(temp, () => assert.fail('replacement owner must keep the lock'), lock), false);
  } finally { fs.openSync = open; Date.now = realNow; }
  assert(replaced);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid), 'serialized recovery rechecks the replacement owner');
  assert(!fs.existsSync(lock + '.recover'), 'recovery guard is released');

  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, old, old);
  fs.writeFileSync(lock + '.recover', '');
  fs.utimesSync(lock + '.recover', old, old);
  assert.throws(() => withLock(temp, () => assert.fail('stale recovery guard is never stolen'), lock), /stale lock recovery guard.*stop all mem-mastero/);
  assert(fs.existsSync(lock) && fs.existsSync(lock + '.recover'), 'stale recovery guard requires explicit cleanup');
} finally {
  const resolved = fs.realpathSync.native(temp);
  assert.strictEqual(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
  assert(path.basename(resolved).startsWith('mem-recovery-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Exercise the real push dispatcher with unchanged files and a pending local commit.
let uploads = 0, commits = 0, networkPushes = 0, errors = 0, cleared = 0;
let pushUrls = ['https://github.com/example/private-memory.git', 'https://github.com/example/public-memory.git'];
let failUpload = false;
const mockGit = (dir, ...args) => {
  if (args[0] === 'symbolic-ref') return 'main';
  if (args[0] === 'remote') return args.includes('--push') ? pushUrls.join('\n') : 'https://github.com/example/private-memory.git';
  if (args[0] === 'push') { networkPushes++; if (failUpload) throw new Error('offline'); }
  return '';
};
const moduleFixture = { exports: {} };
const source = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8').replace(/^#![^\n]*\n/, '');
vm.runInNewContext('(function () {\n' + source + `
  readConfig = () => ({});
  repoId = () => 'github.com/example/project';
  pickStore = () => ({ github: 'https://github.com/example/private-memory.git' });
  storeRoot = () => '/isolated-memory';
  resolveMemoryContext = () => { throw new Error('No local knowledge in this fixture'); };
  exactEol = () => {};
  withLock = (dir, fn) => { fn(); return true; };
  commit = () => recordCommit();
  AGENTS.fixture = { local: () => '/isolated-agent', remote: () => ['fixture'], push: () => [] };
  run(['fixture'], 'push', { cwd: '/isolated-project' });
  ensurePrivateStore = checkPrivacy;
  atomicWrite = recordError;
  module.exports.pullPush = pullPush;
})()`, {
  module: moduleFixture, __filename: path.join(__dirname, 'sync.js'), console, Buffer,
  process: { ...process, env: {}, stdout: { isTTY: false } },
  recordCommit: () => { commits++; },
  checkPrivacy: store => { if (store.github.includes('public-memory')) throw new Error('public memory store'); },
  recordError: () => { errors++; },
  require: name => name === './memory-store' ? { syncMemories: () => ({ pushed: 0, pulled: 0 }) }
    : name === 'fs' ? { ...fs, rmSync: () => { cleared++; } } : name === 'child_process' ? {
    ...require(name), execFileSync: (cmd, args) => mockGit(args[1], ...args.slice(8)),
    spawn: () => { uploads++; return { unref() {} }; },
  } : require(name),
});
assert.strictEqual(commits, 1);
assert.strictEqual(uploads, 1, 'unchanged pushes retry pending uploads');
assert.throws(() => moduleFixture.exports.pullPush('/isolated-memory'), /public memory store/);
assert.strictEqual(networkPushes, 0, 'every push URL is checked before sending any data');
pushUrls = [pushUrls[0]];
failUpload = true;
assert.throws(() => moduleFixture.exports.pullPush('/isolated-memory'), /offline/);
assert.strictEqual(errors, 2, 'background failures leave a status record');
failUpload = false;
moduleFixture.exports.pullPush('/isolated-memory');
assert.strictEqual(cleared, 1, 'successful retry clears the failure record');
console.log('recovery tests ok');
