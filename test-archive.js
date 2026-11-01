// End-to-end archive transactions use real files/compression and a synthetic remote store.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runArchiveCommand, CHUNK_BYTES } = require('./archive');
const inventory = require('./claude-files');
const { readState, statePath } = require('./archive-state');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-archive-test-')));
let serial = 0;
function put(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function fakeBackend(root) {
  const entries = [];
  const backend = {
    publishes: 0, downloads: 0, afterPublish: null, afterDownload: null,
    publishSnapshot({ projectId, sessionId, revision, dir }) {
      backend.publishes++;
      const target = path.join(root, revision);
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(target, name));
      const descriptor = { projectId, sessionId, revision, basePath: `v1/project/${sessionId}/${revision}`, commit: 'a'.repeat(40) };
      entries.push(descriptor);
      if (backend.afterPublish) backend.afterPublish(target, descriptor);
      return descriptor;
    },
    listSnapshots(projectId, sessionId) { return entries.filter(entry => entry.projectId === projectId && (!sessionId || entry.sessionId === sessionId)); },
    readManifest(descriptor) { return fs.readFileSync(path.join(root, descriptor.revision, 'manifest.json')); },
    downloadSnapshot(descriptor, target) {
      backend.downloads++;
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(path.join(root, descriptor.revision))) fs.copyFileSync(path.join(root, descriptor.revision, name), path.join(target, name));
      if (backend.afterDownload) backend.afterDownload(target, descriptor);
    },
  };
  return backend;
}

function fixture({ large = false } = {}) {
  const root = path.join(tmp, `case-${++serial}`);
  const claudeRoot = path.join(root, 'claude'), memRoot = path.join(root, 'mem');
  const projectDir = path.join(claudeRoot, 'projects', '-original-project');
  const sessionId = 'session-01';
  const context = { claudeRoot, memRoot, projectDir, projectId: 'github.com/example/project', store: { github: 'https://example@github.com/example/memory.git' } };
  const expected = new Map([
    ['projects/-original-project/session-01.jsonl', Buffer.from('{"sessionId":"session-01","text":"original transcript"}\n')],
    ['projects/-original-project/session-01/subagents/agent.jsonl', Buffer.from('{"role":"assistant"}\n')],
    ['projects/-original-project/session-01/tool-results/binary', large ? crypto.randomBytes(CHUNK_BYTES * 2 + 31) : Buffer.from([0, 255, 13, 10, 128, 1])],
    ['projects/-original-project/session-01/tool-results/empty', Buffer.alloc(0)],
    ['projects/-original-project/session-01/mcp-tasks/task.json', Buffer.from('{"result":"done"}\n')],
    ['file-history/session-01/snapshot', Buffer.from('before edit\r\n')],
    ['image-cache/session-01/image', Buffer.from([0, 2, 4, 6])],
    ['uploads/session-01/photo', Buffer.from([9, 8, 7, 0])],
    ['dev-mods/session-01/mod.js', Buffer.from('module.exports = {};\n')],
    ['session-env/session-01/metadata.json', Buffer.from('{}\n')],
    ['session-env/session-01.json', Buffer.from('{"env":true}\n')],
    ['session-env/session-01.env', Buffer.from('SHELL=test\n')],
  ]);
  for (const [relative, bytes] of expected) put(path.join(claudeRoot, relative), bytes);
  const memory = path.join(projectDir, 'memory', 'MEMORY.md');
  put(memory, 'Keep durable memory locally');
  const backend = fakeBackend(path.join(root, 'cloud'));
  const logs = [];
  let busy = false;
  const services = {
    claudeRoot, memRoot, context: () => context, backend, log: message => logs.push(message),
    inventory: { ...inventory, assertClaudeStopped() { if (busy) throw new Error('Claude is still running'); } },
  };
  return {
    root, claudeRoot, memRoot, projectDir, sessionId, context, expected, memory, backend, services, logs,
    setBusy(value) { busy = value; },
    run(command, args = []) { return runArchiveCommand(command, args, services); },
  };
}

function assertOriginals(f, expected = f.expected, claudeRoot = f.claudeRoot) {
  for (const [relative, bytes] of expected) assert.deepStrictEqual(fs.readFileSync(path.join(claudeRoot, relative)), bytes, relative);
}
function assertNoNativeFiles(f) {
  for (const relative of f.expected.keys()) assert(!fs.existsSync(path.join(f.claudeRoot, relative)), `archived file remained: ${relative}`);
  assert.strictEqual(fs.readFileSync(f.memory, 'utf8'), 'Keep durable memory locally');
}
function assertNoTransactions(f) {
  const cache = path.join(f.memRoot, 'archive-cache');
  if (fs.existsSync(cache)) assert.deepStrictEqual(fs.readdirSync(cache), [], 'temporary payload cache is cleared');
}

try {
  const basic = fixture({ large: true });
  basic.setBusy(true);
  const servicesNoCloud = { ...basic.services };
  Object.defineProperty(servicesNoCloud, 'backend', { get() { throw new Error('dry run must not access cloud'); } });
  const dry = runArchiveCommand('archive', ['--session', basic.sessionId, '--dry-run', '--json'], servicesNoCloud);
  assert(dry.dryRun);
  assert.strictEqual(dry.sessions.length, 1);
  assert.strictEqual(dry.reclaimableBytes, [...basic.expected.values()].reduce((sum, data) => sum + data.length, 0));
  assertOriginals(basic);
  assert(!fs.existsSync(statePath(basic.context)), 'dry run writes no archive state');
  const storageServices = { ...basic.services, context() { throw new Error('storage needs no project or cloud'); } };
  Object.defineProperty(storageServices, 'backend', { get() { throw new Error('storage must not access cloud'); } });
  const storage = runArchiveCommand('storage', ['--json'], storageServices);
  assert(storage.totalBytes >= dry.reclaimableBytes);
  assert.strictEqual(basic.backend.publishes, 0);
  basic.setBusy(false);
  const archived = basic.run('archive', ['--session', basic.sessionId, '--json']);
  assert.strictEqual(archived.archived.length, 1);
  assert.strictEqual(archived.archived[0].removedBytes, dry.reclaimableBytes);
  assert.strictEqual(basic.backend.downloads, 1, 'remote content was independently downloaded before eviction');
  assertNoNativeFiles(basic);
  assertNoTransactions(basic);
  const descriptor = basic.backend.listSnapshots(basic.context.projectId, basic.sessionId)[0];
  const manifest = JSON.parse(basic.backend.readManifest(descriptor));
  const binary = manifest.files.find(file => file.path.endsWith('/binary'));
  assert.strictEqual(binary.chunks.length, 3, 'large binary is split into bounded chunks');
  assert.strictEqual(manifest.files.find(file => file.path.endsWith('/empty')).chunks.length, 0);
  assert(manifest.files.every(file => !file.path.includes('-original-project')), 'cloud paths are portable across machines');
  assert.strictEqual(readState(basic.context).sessions[basic.sessionId].revision, descriptor.revision);
  const list = basic.run('archive', ['--list', '--json']);
  assert.strictEqual(list.archives[0].revision, descriptor.revision);
  const restored = basic.run('restore', [basic.sessionId, '--revision', descriptor.revision, '--json']);
  assert.strictEqual(restored.restoredBytes, dry.reclaimableBytes);
  assert.strictEqual(restored.files, basic.expected.size);
  assertOriginals(basic);
  assertNoTransactions(basic);
  assert.strictEqual(basic.run('restore', [basic.sessionId]).files, 0, 'identical files make restore idempotent');

  // A second machine maps project-relative files into its own encoded project directory.
  const secondRoot = path.join(basic.root, 'second-claude');
  const secondContext = { ...basic.context, claudeRoot: secondRoot, projectDir: path.join(secondRoot, 'projects', '-different-project'), memRoot: path.join(basic.root, 'second-mem') };
  const secondServices = { ...basic.services, claudeRoot: secondRoot, memRoot: secondContext.memRoot, context: () => secondContext };
  runArchiveCommand('restore', [basic.sessionId], secondServices);
  const mapped = new Map([...basic.expected].map(([relative, bytes]) => [relative.replace('projects/-original-project/', 'projects/-different-project/'), bytes]));
  assertOriginals(basic, mapped, secondRoot);
  assert(!fs.existsSync(path.join(secondRoot, 'projects', '-original-project')));

  for (const mode of ['corrupt', 'missing', 'manifest']) {
    const f = fixture();
    f.backend.afterPublish = remote => {
      const name = mode === 'manifest' ? 'manifest.json' : fs.readdirSync(remote).find(name => name.endsWith('.gz'));
      if (mode === 'missing') fs.unlinkSync(path.join(remote, name));
      else fs.appendFileSync(path.join(remote, name), 'corrupt');
    };
    assert.throws(() => f.run('archive', ['--session', f.sessionId]), /checksum|ENOENT/);
    assertOriginals(f);
    assert(!fs.existsSync(statePath(f.context)), 'unverified content never publishes eviction state');
    assertNoTransactions(f);
  }

  const uploadFailure = fixture();
  uploadFailure.backend.publishSnapshot = () => { throw new Error('simulated upload failure'); };
  assert.throws(() => uploadFailure.run('archive', ['--session', uploadFailure.sessionId]), /upload failure/);
  assertOriginals(uploadFailure);
  assert.strictEqual(uploadFailure.backend.downloads, 0);
  assertNoTransactions(uploadFailure);

  const changed = fixture();
  const transcriptRel = 'projects/-original-project/session-01.jsonl';
  const changedBytes = Buffer.from(changed.expected.get(transcriptRel)); changedBytes[0] ^= 1;
  changed.backend.afterDownload = () => {
    const target = path.join(changed.claudeRoot, transcriptRel), before = fs.statSync(target);
    fs.writeFileSync(target, changedBytes);
    fs.utimesSync(target, before.atime, before.mtime);
  };
  assert.throws(() => changed.run('archive', ['--session', changed.sessionId]), /changed/);
  assertOriginals(changed, new Map([...changed.expected].map(([relative, bytes]) => [relative, relative === transcriptRel ? changedBytes : bytes])));
  assertNoTransactions(changed);

  const addition = fixture();
  addition.backend.afterDownload = () => put(path.join(addition.projectDir, addition.sessionId, 'tool-results', 'new'), 'new result');
  assert.throws(() => addition.run('archive', ['--session', addition.sessionId]), /changed/);
  assertOriginals(addition);
  assert.strictEqual(fs.readFileSync(path.join(addition.projectDir, addition.sessionId, 'tool-results', 'new'), 'utf8'), 'new result');

  const active = fixture();
  active.backend.afterDownload = () => active.setBusy(true);
  assert.throws(() => active.run('archive', ['--session', active.sessionId]), /still running/);
  assertOriginals(active);
  assert(!fs.existsSync(statePath(active.context)));

  const stateFailure = fixture();
  const sync = require('./sync'), originalAtomic = sync.atomicWrite;
  sync.atomicWrite = (file, ...args) => {
    if (path.resolve(file) === path.resolve(statePath(stateFailure.context))) throw new Error('simulated state disk full');
    return originalAtomic(file, ...args);
  };
  try { assert.throws(() => stateFailure.run('archive', ['--session', stateFailure.sessionId]), /state disk full/); }
  finally { sync.atomicWrite = originalAtomic; }
  assertOriginals(stateFailure);

  for (const blockRecovery of [false, true]) {
    const partial = fixture();
    const originalUnlink = fs.unlinkSync;
    let isolatedRemovals = 0;
    fs.unlinkSync = (file, ...args) => {
      if (String(file).includes('.mem-mastero-archive-') && ++isolatedRemovals === 2) {
        if (blockRecovery) partial.setBusy(true);
        throw Object.assign(new Error('simulated partial removal failure'), { code: 'EACCES' });
      }
      return originalUnlink(file, ...args);
    };
    try { assert.throws(() => partial.run('archive', ['--session', partial.sessionId]), /partial removal failure/); }
    finally { fs.unlinkSync = originalUnlink; }
    assert.strictEqual(partial.backend.downloads, 1, 'all removal follows successful independent remote verification');
    if (blockRecovery) {
      assert(readState(partial.context).sessions[partial.sessionId].pending, 'interrupted recovery retains its local journal');
      assert(fs.readdirSync(partial.claudeRoot).some(name => name.startsWith('.mem-mastero-archive-')), 'remaining originals survive outside disposable cache');
      partial.setBusy(false);
      const recoveryServices = { ...partial.services };
      Object.defineProperty(recoveryServices, 'backend', { get() { throw new Error('local recovery must not need cloud'); } });
      const recovery = runArchiveCommand('archive', ['--recover'], recoveryServices);
      assert.strictEqual(recovery.recovered, partial.expected.size - 1);
    }
    const remaining = [...partial.expected.keys()].filter(relative => fs.existsSync(path.join(partial.claudeRoot, relative)));
    assert.strictEqual(remaining.length, partial.expected.size - 1, 'remaining originals return without replacing local files');
    for (const relative of remaining) assert.deepStrictEqual(fs.readFileSync(path.join(partial.claudeRoot, relative)), partial.expected.get(relative));
    assert(!readState(partial.context).sessions[partial.sessionId].pending);
    assertNoTransactions(partial);
    const recovered = partial.run('restore', [partial.sessionId]);
    assert.strictEqual(recovered.files, 1, 'verified cloud snapshot recovers the single already removed file');
    assertOriginals(partial);
  }

  const conflict = fixture();
  conflict.run('archive', ['--session', conflict.sessionId]);
  const conflictFile = path.join(conflict.projectDir, conflict.sessionId, 'tool-results', 'binary');
  put(conflictFile, 'existing edited data');
  assert.throws(() => conflict.run('restore', [conflict.sessionId]), /conflict/i);
  assert.strictEqual(fs.readFileSync(conflictFile, 'utf8'), 'existing edited data');
  assert(!fs.existsSync(path.join(conflict.projectDir, `${conflict.sessionId}.jsonl`)), 'restore preflight does not publish any files before detecting conflicts');
  assertNoTransactions(conflict);

  for (const transcriptPresent of [false, true]) {
    for (const extraRelative of [
      'projects/-original-project/session-01/tool-results/unarchived',
      'uploads/session-01/unarchived',
    ]) {
      const extra = fixture();
      extra.run('archive', ['--session', extra.sessionId]);
      if (transcriptPresent) put(path.join(extra.claudeRoot, transcriptRel), extra.expected.get(transcriptRel));
      const extraPath = path.join(extra.claudeRoot, extraRelative);
      put(extraPath, 'new local companion');
      const beforeState = fs.readFileSync(statePath(extra.context));
      assert.throws(() => extra.run('restore', [extra.sessionId]), /extra local session file/i);
      assert.strictEqual(fs.readFileSync(extraPath, 'utf8'), 'new local companion');
      for (const [relative, bytes] of extra.expected) {
        const target = path.join(extra.claudeRoot, relative);
        if (transcriptPresent && relative === transcriptRel) assert.deepStrictEqual(fs.readFileSync(target), bytes);
        else assert(!fs.existsSync(target), 'restore with extra companions publishes no native files');
      }
      assert.deepStrictEqual(fs.readFileSync(statePath(extra.context)), beforeState, 'restore conflict leaves archive state unchanged');
      assertNoTransactions(extra);
    }
  }

  for (const interleavedSibling of [false, true]) {
    const malicious = fixture();
    malicious.run('archive', ['--session', malicious.sessionId]);
    const original = malicious.backend.listSnapshots(malicious.context.projectId, malicious.sessionId)[0];
    const oldDir = path.join(malicious.root, 'cloud', original.revision);
    const staging = path.join(malicious.root, 'malicious-snapshot');
    fs.mkdirSync(staging);
    for (const name of fs.readdirSync(oldDir)) fs.copyFileSync(path.join(oldDir, name), path.join(staging, name));
    const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json')));
    const paths = [`project/${malicious.sessionId}/a`, `project/${malicious.sessionId}/a/b`];
    // Lexical neighbors alone are insufficient: a-b sorts between a and a/b.
    if (interleavedSibling) paths.push(`project/${malicious.sessionId}/a-b`);
    for (const name of paths) manifest.files.push({ path: name, bytes: 0, mtimeMs: Date.now(), mode: 0o600, sha256: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'), chunks: [] });
    const raw = Buffer.from(JSON.stringify(manifest) + '\n');
    fs.writeFileSync(path.join(staging, 'manifest.json'), raw);
    const revision = crypto.createHash('sha256').update(raw).digest('hex');
    malicious.backend.publishSnapshot({ projectId: malicious.context.projectId, sessionId: malicious.sessionId, revision, dir: staging });
    const beforeState = fs.readFileSync(statePath(malicious.context));
    assert.throws(() => malicious.run('restore', [malicious.sessionId, '--revision', revision]), /parent path/i);
    assertNoNativeFiles(malicious);
    assert(!fs.existsSync(path.join(malicious.projectDir, malicious.sessionId, 'a')), 'file/ancestor conflicts are rejected before publishing files');
    assert(!fs.existsSync(path.join(malicious.projectDir, malicious.sessionId, 'a-b')));
    assert.deepStrictEqual(fs.readFileSync(statePath(malicious.context)), beforeState);
  }

  const selection = fixture();
  assert.strictEqual(selection.run('archive', ['--dry-run']).sessions.length, 0, 'recent sessions are excluded by default');
  for (const relative of selection.expected.keys()) fs.utimesSync(path.join(selection.claudeRoot, relative), new Date(0), new Date(0));
  assert.strictEqual(selection.run('archive', ['--older-than', '1', '--dry-run']).sessions.length, 1);
  assert.throws(() => selection.run('archive', ['--older-than', '-1']), /Usage/);
  assert.throws(() => selection.run('archive', ['--session', '../outside']), /Usage/);
  assert.throws(() => selection.run('restore', []), /Usage/);
  assert.throws(() => selection.run('restore', [selection.sessionId, '--revision', 'invalid']), /Usage/);
  assert.throws(() => selection.run('archive', ['--session', 'missing']), /not found/);

  console.log('Archive transactions and recovery tests passed');
} finally {
  const resolved = fs.realpathSync.native(tmp);
  if (resolved !== tmp || !path.basename(resolved).startsWith('mm-archive-test-')) throw new Error('Unexpected test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
