// Real compressed files and a synthetic read-only cloud: no credentials or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { recall, cleanupRecall, DEFAULT_LIMIT, MAX_LIMIT } = require('./archive-recall');
const { stageSnapshot } = require('./archive');
const { discoverSessions } = require('./claude-files');
const { digest } = require('./archive-state');
const { nodeId } = require('./archive-graph');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-recall-test-')));
let serial = 0;
function put(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function fixture(transcript = Buffer.from('{"message":"remember this original conversation"}\n')) {
  const base = path.join(root, String(++serial)), claudeRoot = path.join(base, 'claude');
  const context = { claudeRoot, memRoot: path.join(base, 'mem'), projectDir: path.join(claudeRoot, 'projects', '-example'),
    projectId: 'github.com/example/recall-project', store: { github: 'https://github.com/example/private-memory' } };
  const sessionId = 'recalled-session';
  const native = path.join(context.projectDir, sessionId + '.jsonl');
  put(native, transcript);
  const binary = path.join(context.projectDir, sessionId, 'tool-results', 'binary.dat');
  put(binary, Buffer.from([0, 255, 2, 3, 128]));
  const cloud = path.join(base, 'cloud'); fs.mkdirSync(cloud);
  const snapshot = stageSnapshot(discoverSessions(context)[0], context, cloud);
  const descriptor = { projectId: context.projectId, sessionId, revision: snapshot.revision,
    basePath: `v1/${digest(context.projectId)}/${sessionId}/${snapshot.revision}`, commit: 'a'.repeat(40) };
  const originalCloud = new Map(fs.readdirSync(cloud).map(name => [name, fs.readFileSync(path.join(cloud, name))]));
  const backend = {
    downloads: 0, afterDownload: null, failAfter: null,
    listSnapshots(projectId, id) { return projectId === context.projectId && (!id || id === sessionId) ? [descriptor] : []; },
    readManifest(d) { assert.equal(d.revision, descriptor.revision); return fs.readFileSync(path.join(cloud, 'manifest.json')); },
    publishSnapshot() { throw new Error('Recall must never upload or change the cloud'); },
    downloadSnapshot(d, dir) {
      assert.equal(d.revision, descriptor.revision); backend.downloads++;
      fs.mkdirSync(dir, { recursive: true });
      let count = 0;
      for (const name of fs.readdirSync(cloud)) {
        fs.copyFileSync(path.join(cloud, name), path.join(dir, name));
        if (++count === backend.failAfter) throw new Error('Download interrupted');
      }
      if (backend.afterDownload) backend.afterDownload(dir);
    },
  };
  return { context, backend, cloud, sessionId, native, transcript, descriptor,
    ref: nodeId(context, sessionId, descriptor.revision),
    run(options) { return recall(sessionId, options, context, { backend, assertClaudeStopped() { throw new Error('Claude is running'); } }); },
    assertCloud() {
      assert.deepEqual(fs.readdirSync(cloud), [...originalCloud.keys()]);
      for (const [name, data] of originalCloud) assert.deepEqual(fs.readFileSync(path.join(cloud, name)), data);
    },
    assertClean() { const dir = path.join(context.memRoot, 'recall-cache'); if (fs.existsSync(dir)) assert.deepEqual(fs.readdirSync(dir), []); },
  };
}

function deadPid() {
  for (const pid of [2147483647, 2147483646, 1000000000]) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return pid; }
  }
  throw new Error('Cannot find a nonexistent PID for cleanup test');
}

function leaseFixture(context, options = {}) {
  const id = crypto.randomUUID(), dir = path.join(context.memRoot, 'recall-cache', 'recall-' + id);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('known disposable cache');
  const lease = { kind: 'mem-mastero-recall-v1', id, pid: options.live ? process.pid : deadPid(), startedAt: Date.now() - 60000,
    files: [{ path: 'download/manifest.json', sha256: digest(bytes), bytes: bytes.length }] };
  put(path.join(dir, 'download', 'manifest.json'), bytes);
  put(path.join(dir, 'lease.json'), JSON.stringify(lease));
  return { dir, lease, bytes };
}

try {
  const f = fixture();
  const result = f.run();
  assert.equal(result.content, f.transcript.toString());
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.nodeId, f.ref);
  assert.equal(result.sessionId, f.sessionId);
  assert.equal(result.revision, f.descriptor.revision);
  assert.equal(result.offset, 0);
  assert.equal(result.nextOffset, f.transcript.length);
  assert.equal(result.totalBytes, f.transcript.length);
  assert.equal(result.truncated, false);
  assert.equal(result.temporaryFilesRemoved, true);
  assert.equal(f.backend.downloads, 1);
  assert.deepEqual(fs.readFileSync(f.native), f.transcript, 'recall never mutates native Claude sessions, even while Claude is active');
  assert(!fs.existsSync(path.join(f.context.memRoot, 'archive-state')), 'recall does not change native eviction state');
  f.assertClean(); f.assertCloud();
  assert.equal(recall(f.ref, {}, f.context, { backend: f.backend }).content, result.content, 'immutable graph reference resolves the same verified revision');
  assert.throws(() => { f.run(); throw new Error('Output consumer failed'); }, /Output consumer failed/);
  f.assertClean();

  const large = fixture(Buffer.from('x'.repeat(MAX_LIMIT + 100)));
  const page = large.run();
  assert.equal(Buffer.byteLength(page.content), DEFAULT_LIMIT);
  assert.equal(page.nextOffset, DEFAULT_LIMIT); assert(page.truncated);
  const last = large.run({ offset: MAX_LIMIT, limit: 100 });
  assert.equal(last.content, 'x'.repeat(100)); assert(!last.truncated);
  const end = large.run({ offset: MAX_LIMIT + 100, limit: 1 });
  assert.equal(end.content, ''); assert(!end.truncated);
  const downloads = large.backend.downloads;
  for (const options of [{ offset: -1 }, { offset: '1x' }, { offset: 1.5 }, { limit: 0 }, { limit: MAX_LIMIT + 1 }, { limit: Infinity }, { offset: '9007199254740992' }, { offset: null }, { limit: true }]) {
    assert.throws(() => large.run(options), /recall|Recall/);
  }
  assert.equal(large.backend.downloads, downloads, 'invalid pagination must not download payloads');
  assert.throws(() => large.run({ offset: MAX_LIMIT + 101 }), /exceeds/);
  assert.equal(large.backend.downloads, downloads);
  large.assertClean(); large.assertCloud();

  const utf = fixture(Buffer.from('a€b'));
  assert.equal(utf.run().content, 'a€b');
  const split = utf.run({ offset: 2, limit: 1 });
  assert.equal(split.encoding, 'base64');
  assert.deepEqual(Buffer.from(split.content, 'base64'), Buffer.from('a€b').subarray(2, 3));
  const binary = utf.run({ file: 'project/' + utf.sessionId + '/tool-results/binary.dat' });
  assert.equal(binary.encoding, 'base64');
  assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0, 255, 2, 3, 128]));
  assert.throws(() => utf.run({ file: '../settings.json' }), /not part/);
  utf.assertClean(); utf.assertCloud();

  for (const mode of ['chunk', 'manifest', 'missing', 'interrupted']) {
    const bad = fixture();
    if (mode === 'interrupted') bad.backend.failAfter = 1;
    else bad.backend.afterDownload = dir => {
      const chunk = fs.readdirSync(dir).find(name => name.endsWith('.gz'));
      if (mode === 'missing') fs.unlinkSync(path.join(dir, chunk));
      else fs.appendFileSync(path.join(dir, mode === 'manifest' ? 'manifest.json' : chunk), 'bad');
    };
    assert.throws(() => bad.run(), /checksum|ENOENT|Download interrupted/);
    bad.assertClean(); bad.assertCloud();
    assert.deepEqual(fs.readFileSync(bad.native), bad.transcript);
  }

  const companion = fixture();
  companion.backend.afterDownload = dir => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
    const chunk = manifest.files.find(file => file.path.endsWith('binary.dat')).chunks[0].name;
    fs.appendFileSync(path.join(dir, chunk), 'corrupt unselected companion');
  };
  assert.throws(() => companion.run(), /checksum/, 'unselected companion files must also be verified before transcript exposure');
  companion.assertClean();

  // A completed reconstruction must not adopt a late writer's bytes as verified
  // output or as disposable cache merely because the chunk stream was valid.
  const closedOutput = fixture();
  const originalOpen = fs.openSync, originalClose = fs.closeSync;
  const writtenDescriptors = new Map();
  let changedAfterClose;
  fs.openSync = function (file, flags, ...args) {
    const fd = originalOpen.call(fs, file, flags, ...args);
    if (String(file).startsWith(closedOutput.context.memRoot) && String(file).endsWith(path.join('verified', '0')) && flags === 'wx') writtenDescriptors.set(fd, file);
    return fd;
  };
  fs.closeSync = function (fd) {
    const file = writtenDescriptors.get(fd); writtenDescriptors.delete(fd);
    const result = originalClose.call(fs, fd);
    if (file && !changedAfterClose) {
      changedAfterClose = file;
      fs.writeFileSync(file, 'unverified bytes written after reconstruction closed');
    }
    return result;
  };
  try { assert.throws(() => closedOutput.run(), /changed after verification; retained/); }
  finally { fs.openSync = originalOpen; fs.closeSync = originalClose; }
  assert(changedAfterClose);
  assert.equal(fs.readFileSync(changedAfterClose, 'utf8'), 'unverified bytes written after reconstruction closed');
  closedOutput.assertCloud();

  // Bind the actual returned page to the cloud checksum in the same streaming
  // pass, even if a writer restores original file bytes before cleanup checks.
  const readRace = fixture();
  const readManifest = JSON.parse(fs.readFileSync(path.join(readRace.cloud, 'manifest.json')));
  const selectedIndex = readManifest.files.findIndex(file => file.path === 'project/' + readRace.sessionId + '.jsonl');
  const realRead = fs.readSync;
  let selectedOpens = 0, readingDescriptor, readingFile, racedRead = false;
  fs.openSync = function (file, flags, ...args) {
    const fd = originalOpen.call(fs, file, flags, ...args);
    if (flags === 'r' && String(file).startsWith(readRace.context.memRoot) && String(file).endsWith(path.join('verified', String(selectedIndex)))) {
      if (++selectedOpens === 2) { readingDescriptor = fd; readingFile = file; }
    }
    return fd;
  };
  fs.readSync = function (fd, ...args) {
    if (fd === readingDescriptor && !racedRead) {
      racedRead = true;
      const altered = Buffer.from(readRace.transcript); altered[0] ^= 1;
      fs.writeFileSync(readingFile, altered);
      try { return realRead.call(fs, fd, ...args); }
      finally { fs.writeFileSync(readingFile, readRace.transcript); }
    }
    return realRead.call(fs, fd, ...args);
  };
  try { assert.throws(() => readRace.run(), /checksum changed during reading/); }
  finally { fs.openSync = originalOpen; fs.readSync = realRead; }
  assert(racedRead, 'test must race the selected output read after ownership capture');
  readRace.assertCloud();

  const changed = fixture();
  const decode = TextDecoder.prototype.decode;
  let modified;
  TextDecoder.prototype.decode = function (...args) {
    const cache = path.join(changed.context.memRoot, 'recall-cache');
    const dir = path.join(cache, fs.readdirSync(cache)[0]);
    modified = path.join(dir, 'verified', '0');
    fs.writeFileSync(modified, 'new local bytes that must survive');
    return decode.apply(this, args);
  };
  try { assert.throws(() => changed.run(), /Modified recall cache file; retained/); }
  finally { TextDecoder.prototype.decode = decode; }
  assert.equal(fs.readFileSync(modified, 'utf8'), 'new local bytes that must survive');
  changed.assertCloud();

  const unknown = fixture();
  let userFile;
  unknown.backend.afterDownload = dir => { userFile = path.join(dir, 'user-note.txt'); fs.writeFileSync(userFile, 'keep this note'); };
  assert.throws(() => unknown.run(), /Unrecognized recall cache file; retained/);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'keep this note');
  unknown.assertCloud();

  const late = fixture(), realRename = fs.renameSync;
  let lateTarget;
  fs.renameSync = function (source, target, ...args) {
    if (String(source).startsWith(late.context.memRoot) && String(source).endsWith(path.join('verified', '0'))) {
      fs.writeFileSync(source, 'new bytes written immediately before detachment');
      lateTarget = target;
    }
    return realRename.call(fs, source, target, ...args);
  };
  try { assert.throws(() => late.run(), /changed during detachment; retained/); }
  finally { fs.renameSync = realRename; }
  assert(lateTarget, 'test must interleave at the actual detachment');
  assert.equal(fs.readFileSync(lateTarget, 'utf8'), 'new bytes written immediately before detachment');
  late.assertCloud();

  // Interrupted cleanup is itself resumable after its former process is gone.
  const interruptedCleanup = fixture();
  let detachedOnce = false;
  fs.renameSync = function (source, target, ...args) {
    const result = realRename.call(fs, source, target, ...args);
    if (!detachedOnce && String(source).startsWith(interruptedCleanup.context.memRoot) && String(target).includes(path.sep + 'removing' + path.sep)) {
      detachedOnce = true;
      throw new Error('Simulated process stop after detachment');
    }
    return result;
  };
  try { assert.throws(() => interruptedCleanup.run(), /Simulated process stop/); }
  finally { fs.renameSync = realRename; }
  assert(detachedOnce);
  const abandonedRoot = path.join(interruptedCleanup.context.memRoot, 'recall-cache');
  const abandoned = path.join(abandonedRoot, fs.readdirSync(abandonedRoot)[0]);
  const abandonedLeasePath = path.join(abandoned, 'lease.json');
  const abandonedLease = JSON.parse(fs.readFileSync(abandonedLeasePath));
  abandonedLease.pid = deadPid(); fs.writeFileSync(abandonedLeasePath, JSON.stringify(abandonedLease));
  assert.equal(cleanupRecall(interruptedCleanup.context).removed, 1);
  interruptedCleanup.assertClean(); interruptedCleanup.assertCloud();

  const cleanContext = { memRoot: path.join(root, 'cleanup') };
  assert.deepEqual(cleanupRecall(cleanContext), { removed: 0, skippedLive: 0, retained: [] });
  const stale = leaseFixture(cleanContext), live = leaseFixture(cleanContext, { live: true });
  const mutated = leaseFixture(cleanContext), malformed = leaseFixture(cleanContext), added = leaseFixture(cleanContext);
  fs.writeFileSync(path.join(mutated.dir, 'download', 'manifest.json'), 'changed cache content');
  fs.writeFileSync(path.join(malformed.dir, 'lease.json'), '{}');
  put(path.join(added.dir, 'download', 'notes.txt'), 'keep unknown user file');
  const cleanup = cleanupRecall(cleanContext);
  assert.equal(cleanup.removed, 1); assert.equal(cleanup.skippedLive, 1); assert.equal(cleanup.retained.length, 3);
  assert(!fs.existsSync(stale.dir)); assert(fs.existsSync(live.dir));
  assert(fs.existsSync(mutated.dir)); assert(fs.existsSync(malformed.dir)); assert(fs.existsSync(added.dir));

  const linkContext = { memRoot: path.join(root, 'links') }, outside = path.join(root, 'outside');
  fs.mkdirSync(outside); put(path.join(outside, 'keep.txt'), 'never touch outside cache');
  const linked = leaseFixture(linkContext);
  const linkedDir = path.join(linked.dir, 'verified');
  fs.symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(cleanupRecall(linkContext).retained.length, 1);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'never touch outside cache');
  const linkedRoot = { memRoot: path.join(root, 'linked-root') };
  fs.mkdirSync(linkedRoot.memRoot);
  fs.symlinkSync(outside, path.join(linkedRoot.memRoot, 'recall-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupRecall(linkedRoot), /Refusing symbolic link/);

  console.log('Archive on-demand recall and cache safety tests passed.');
} finally {
  const resolved = fs.realpathSync.native(root);
  assert.equal(resolved, root);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mm-recall-test-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
