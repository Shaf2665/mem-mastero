// Read-only, on-demand access to cold archives. Native Claude files are never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { safePath, HASH } = require('./archive-state');
const { verifyDownload, hashFile } = require('./archive');
const DEFAULT_LIMIT = 64 * 1024;
const MAX_LIMIT = 256 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OWNED_FILE = /^(?:download\/(?:manifest\.json|payload-\d{6}\.gz)|verified\/(?:0|[1-9]\d{0,5})|removing\/[a-f0-9-]{36})$/;
const MAX_LEASE_BYTES = 64 * 1024 * 1024;

function cacheRoot(context) { return safePath(context.memRoot, 'recall-cache'); }
function leasePath(dir) { return safePath(dir, 'lease.json'); }
function writeLease(dir, lease) {
  require('./sync').atomicWrite(leasePath(dir), JSON.stringify(lease) + '\n');
}

function validateLease(lease, name) {
  if (!lease || lease.kind !== 'mem-mastero-recall-v1' || !UUID.test(lease.id)
    || name !== 'recall-' + lease.id || !Number.isSafeInteger(lease.pid) || lease.pid <= 0
    || !Number.isFinite(lease.startedAt) || !Array.isArray(lease.files) || lease.files.length > 400002) throw new Error('Invalid recall ownership lease');
  const seen = new Set();
  for (const file of lease.files) {
    if (!file || !OWNED_FILE.test(file.path) || seen.has(file.path) || !HASH.test(file.sha256)
      || !(Number.isSafeInteger(file.bytes) && file.bytes >= 0 || file.path === 'download/manifest.json' && file.bytes === null)) throw new Error('Invalid recall ownership file');
    seen.add(file.path);
    if (file.path.startsWith('removing/') && (!UUID.test(file.path.slice(9)) || file.detached !== true || !file.identity)
      || !file.path.startsWith('removing/') && file.detached !== undefined) throw new Error('Invalid detached recall file');
    if (file.identity && (!Number.isFinite(file.identity.dev) || !Number.isFinite(file.identity.ino)
      || !Number.isFinite(file.identity.mtimeMs) || !Number.isFinite(file.identity.ctimeMs))) throw new Error('Invalid recall file identity');
  }
  if (!seen.has('download/manifest.json')) throw new Error('Recall lease has no manifest');
  return lease;
}

function readLease(dir) {
  const file = leasePath(dir), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_LEASE_BYTES) throw new Error('Invalid recall lease file');
  let lease;
  try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Unreadable recall ownership lease'); }
  return validateLease(lease, path.basename(dir));
}

function identity(stat) { return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function sameIdentity(a, b) { return ['dev', 'ino', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]); }
function matchesOwned(expected, observed) {
  const keys = expected.detached ? ['dev', 'ino', 'mtimeMs'] : ['dev', 'ino', 'mtimeMs', 'ctimeMs'];
  return observed.sha256 === expected.sha256 && (expected.bytes === null || observed.bytes === expected.bytes)
    && (!expected.identity || keys.every(key => expected.identity[key] === observed.identity[key]));
}
function inspectOwned(dir, relative) {
  const file = safePath(dir, relative), before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1) throw new Error('Recall cache contains a non-file or shared file');
  const sha256 = hashFile(file), after = fs.lstatSync(file);
  if (before.size !== after.size || !sameIdentity(identity(before), identity(after))) throw new Error('Recall cache file changed while checking ownership');
  return { sha256, bytes: after.size, identity: identity(after) };
}

function expectedLease(manifest, descriptor) {
  const files = [{ path: 'download/manifest.json', sha256: descriptor.revision, bytes: null }];
  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i];
    for (const chunk of file.chunks) files.push({ path: 'download/' + chunk.name, sha256: chunk.sha256, bytes: chunk.bytes });
    files.push({ path: 'verified/' + i, sha256: file.sha256, bytes: file.bytes });
  }
  return { kind: 'mem-mastero-recall-v1', id: crypto.randomUUID(), pid: process.pid, startedAt: Date.now(), files };
}

// Snapshot the files produced by this synchronous stage, including partial/corrupt
// downloads. Later cleanup compares them against this journal instead of accepting
// arbitrary current contents. Unlisted files are never adopted or removed.
function recordStage(dir, lease, prefix, requireExpected = false) {
  const updates = [];
  for (const file of lease.files) {
    if (!file.path.startsWith(prefix) || file.identity) continue;
    try {
      const observed = inspectOwned(dir, file.path);
      // Successful reconstruction verified the incoming chunks, but another
      // writer may have changed an output file after its descriptor was closed.
      // Never adopt those changed bytes as either verified data or disposable cache.
      if (requireExpected && (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes)) throw new Error('Reconstructed recall file changed after verification; retained');
      updates.push([file, observed]);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [file, observed] of updates) Object.assign(file, observed);
  writeLease(dir, lease);
}

function liveProcess(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM and ambiguous errors are live.
}

function removableFiles(dir, lease) {
  const allowed = new Map(lease.files.map(file => [file.path, file])), found = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'lease.json') continue;
    if (!['download', 'verified', 'removing'].includes(name)) throw new Error('Unrecognized recall cache entry; retained');
    const subdir = safePath(dir, name), stat = fs.lstatSync(subdir);
    if (!stat.isDirectory()) throw new Error('Unexpected recall cache directory; retained');
    for (const child of fs.readdirSync(subdir)) {
      const relative = name + '/' + child, expected = allowed.get(relative);
      if (!expected) throw new Error('Unrecognized recall cache file; retained');
      const observed = inspectOwned(dir, relative);
      if (!matchesOwned(expected, observed)) throw new Error('Modified recall cache file; retained');
      found.push({ relative, observed });
    }
  }
  return found;
}

function removeLeaseDirectory(root, dir, lease) {
  const checked = safePath(root, path.basename(dir));
  if (checked !== path.resolve(dir) || path.dirname(checked) !== path.resolve(root)
    || path.basename(dir) !== 'recall-' + lease.id) throw new Error('Unsafe recall cleanup path');
  if (JSON.stringify(readLease(dir)) !== JSON.stringify(lease)) throw new Error('Recall ownership lease changed; retained');
  const files = removableFiles(dir, lease);
  const moves = files.filter(file => !file.relative.startsWith('removing/')).map(file => {
    const detached = { path: 'removing/' + crypto.randomUUID(), ...file.observed, detached: true };
    lease.files.push(detached);
    return { ...file, detached };
  });
  // Journal destinations before detaching. A crash leaves both locations known,
  // while a writer racing the rename has its new bytes retained for inspection.
  if (moves.length) {
    writeLease(dir, lease);
    fs.mkdirSync(safePath(dir, 'removing'), { recursive: true, mode: 0o700 });
    for (const file of moves) {
      const target = safePath(dir, file.detached.path);
      if (fs.existsSync(target)) throw new Error('Recall cleanup destination already exists; retained');
      fs.renameSync(safePath(dir, file.relative), target);
      if (!matchesOwned(file.detached, inspectOwned(dir, file.detached.path))) throw new Error('Recall cache changed during detachment; retained');
    }
  }
  // Re-check the complete namespace after all renames before deleting anything.
  // An unexpected replacement at an original path also fails this check.
  const detached = removableFiles(dir, lease);
  if (detached.some(file => !file.relative.startsWith('removing/'))) throw new Error('Recall cache changed during cleanup; retained');
  for (const file of detached) {
    const current = inspectOwned(dir, file.relative);
    if (current.sha256 !== file.observed.sha256 || current.bytes !== file.observed.bytes
      || !sameIdentity(current.identity, file.observed.identity)) throw new Error('Recall cache changed during cleanup; retained');
    fs.unlinkSync(safePath(dir, file.relative));
  }
  for (const name of ['download', 'verified', 'removing']) {
    try { fs.rmdirSync(safePath(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Do not unlink a replaced/tampered ownership marker.
  const currentLease = readLease(dir);
  if (JSON.stringify(currentLease) !== JSON.stringify(lease)) throw new Error('Recall ownership lease changed; retained');
  fs.unlinkSync(leasePath(dir));
  fs.rmdirSync(checked);
}

function cleanupRecall(context) {
  const root = cacheRoot(context), result = { removed: 0, skippedLive: 0, retained: [] };
  let names;
  try { names = fs.readdirSync(root); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const name of names) {
    try {
      if (!name.startsWith('recall-') || !UUID.test(name.slice(7))) throw new Error('Unrecognized recall cache directory; retained');
      const dir = safePath(root, name);
      if (!fs.lstatSync(dir).isDirectory()) throw new Error('Unexpected recall cache entry; retained');
      const lease = readLease(dir);
      if (liveProcess(lease.pid)) { result.skippedLive++; continue; }
      removeLeaseDirectory(root, dir, lease);
      result.removed++;
    } catch (error) { result.retained.push({ directory: name, reason: error.message }); }
  }
  return result;
}

function boundedInteger(value, fallback, name, max) {
  if (value === undefined) return fallback;
  if (!['string', 'number'].includes(typeof value)) throw new Error(`Invalid recall ${name}`);
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid recall ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new Error(`Invalid recall ${name}`);
  return number;
}

function readPage(file, expected, offset, limit) {
  const size = expected.bytes;
  if (offset > size) throw new Error('Recall offset exceeds the selected file size');
  const data = Buffer.alloc(Math.min(limit, size - offset));
  const chunk = Buffer.alloc(2 * 1024 * 1024), hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    let position = 0;
    // Hash the same bytes from which the output slice is copied. A writer that
    // changes then restores a file between separate checks cannot inject output.
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position + 1), null);
      if (!count) break;
      if (position + count > size) throw new Error('Verified recall file size changed during reading');
      hash.update(chunk.subarray(0, count));
      const from = Math.max(offset, position), to = Math.min(offset + data.length, position + count);
      if (to > from) chunk.copy(data, from - offset, from - position, to - position);
      position += count;
    }
    if (position !== size || hash.digest('hex') !== expected.sha256) throw new Error('Verified recall file checksum changed during reading');
  } finally { fs.closeSync(fd); }
  let encoding = 'utf8', content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error('Binary content');
  } catch { encoding = 'base64'; content = data.toString('base64'); }
  return { encoding, content, nextOffset: offset + data.length, truncated: offset + data.length < size };
}

function recall(reference, options = {}, context, deps = {}) {
  const offset = boundedInteger(options.offset, 0, 'offset', Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(options.limit, DEFAULT_LIMIT, 'limit', MAX_LIMIT);
  if (!limit) throw new Error('Recall limit must be positive');
  const backend = deps.backend || require('./archive-store').createArchiveStore(context.store);
  const { descriptor, manifest, nodeId } = require('./archive-graph').resolveNode(context, backend, reference, { revision: options.revision });
  const selected = options.file === undefined ? 'project/' + descriptor.sessionId + '.jsonl' : options.file;
  if (typeof selected !== 'string') throw new Error('Invalid recall file');
  const index = manifest.files.findIndex(file => file.path === selected);
  if (index < 0) throw new Error('Recall file is not part of the selected archive');
  if (offset > manifest.files[index].bytes) throw new Error('Recall offset exceeds the selected file size');
  const root = cacheRoot(context);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lease = expectedLease(manifest, descriptor), dir = safePath(root, 'recall-' + lease.id);
  fs.mkdirSync(dir, { mode: 0o700 });
  try { writeLease(dir, lease); }
  catch (error) { try { fs.rmdirSync(dir); } catch {} throw error; }
  let result, failure;
  try {
    const downloaded = safePath(dir, 'download'), verified = safePath(dir, 'verified');
    try { backend.downloadSnapshot(descriptor, downloaded); }
    finally { recordStage(dir, lease, 'download/'); }
    let checked, reconstructed = false;
    try { checked = verifyDownload(downloaded, verified, context, descriptor.sessionId, descriptor.revision); reconstructed = true; }
    finally { recordStage(dir, lease, 'verified/', reconstructed); }
    if (JSON.stringify(checked) !== JSON.stringify(manifest)) throw new Error('Recall manifest changed after resolution');
    const page = readPage(safePath(verified, String(index)), checked.files[index], offset, limit);
    result = { nodeId, sessionId: descriptor.sessionId, revision: descriptor.revision, file: selected,
      offset, ...page, totalBytes: checked.files[index].bytes, temporaryFilesRemoved: true };
  } catch (error) { failure = error; }
  try { removeLeaseDirectory(root, dir, lease); }
  catch (cleanup) {
    throw new Error(`${failure ? failure.message + '. ' : ''}Recall cache could not be safely removed; retained at ${dir}: ${cleanup.message}`);
  }
  if (failure) throw failure;
  return result;
}

module.exports = { recall, cleanupRecall, DEFAULT_LIMIT, MAX_LIMIT };
