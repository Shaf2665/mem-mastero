// Explicit Claude archive transactions. No hook deletes sessions automatically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { SESSION_ID, HASH, digest, safePath, readState, writeState, withArchiveLock } = require('./archive-state');
const CHUNK_BYTES = 2 * 1024 * 1024;
const ASSET_ROOTS = ['file-history', 'image-cache', 'uploads', 'dev-mods', 'session-env'];
const USAGE = 'Usage: storage [--json] | archive [--session ID | --older-than DAYS] [--dry-run] [--json] | archive --list|--recover [--json] | restore ID [--revision SHA256] [--json]';

function parseArgs(command, args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--json', '--dry-run', '--list', '--recover'].includes(arg)) {
      if (o[arg.slice(2)]) throw new Error(USAGE);
      o[arg.slice(2)] = true;
    } else if (['--session', '--older-than', '--revision'].includes(arg)) {
      if (o[arg.slice(2)] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(USAGE);
      o[arg.slice(2)] = args[++i];
    } else if (command === 'restore' && !o.session && SESSION_ID.test(arg)) o.session = arg;
    else throw new Error(USAGE);
  }
  if (o.session && !SESSION_ID.test(o.session)) throw new Error(USAGE);
  if (command === 'storage' && Object.keys(o).some(k => k !== 'json')) throw new Error(USAGE);
  if (command === 'archive' && (o.revision || (o.session && o['older-than']) || (o.list && Object.keys(o).some(k => !['list', 'json'].includes(k))) || (o.recover && Object.keys(o).some(k => !['recover', 'json'].includes(k))))) throw new Error(USAGE);
  if (command === 'restore' && (!o.session || Object.keys(o).some(k => !['session', 'revision', 'json'].includes(k)) || (o.revision && !HASH.test(o.revision)))) throw new Error(USAGE);
  if (o['older-than'] !== undefined && (!/^\d+$/.test(o['older-than']) || !Number.isSafeInteger(Number(o['older-than'])))) throw new Error(USAGE);
  return o;
}

function hashFile(file) {
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256'), buf = Buffer.alloc(CHUNK_BYTES);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// Archive paths are portable logical names, never source-machine absolute paths.
function logicalPath(file, context, sessionId) {
  const projectRel = path.relative(context.projectDir, file.path);
  if (!projectRel.startsWith('..') && !path.isAbsolute(projectRel)) return 'project/' + projectRel.split(path.sep).join('/');
  return path.relative(context.claudeRoot, file.path).split(path.sep).join('/');
}

function targetPath(relative, context, sessionId) {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\\')) throw new Error('Unsafe archive path');
  const parts = relative.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error('Unsafe archive path');
  }
  if (parts[0] === 'project' && ((parts.length === 2 && parts[1] === sessionId + '.jsonl') || (parts.length > 2 && parts[1] === sessionId))) return safePath(context.projectDir, parts.slice(1).join(path.sep));
  if (ASSET_ROOTS.includes(parts[0]) && ((parts.length >= 2 && parts[1] === sessionId) || (parts[0] === 'session-env' && parts.length === 2 && [sessionId + '.json', sessionId + '.env'].includes(parts[1])))) return safePath(context.claudeRoot, parts.join(path.sep));
  throw new Error('Archive path does not belong to the selected session');
}

function validateManifest(manifest, context, sessionId, revision) {
  if (!manifest || manifest.version !== 1 || manifest.agent !== 'claude' || manifest.projectId !== context.projectId || manifest.sessionId !== sessionId || !SESSION_ID.test(sessionId) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000 || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Invalid archive manifest');
  const paths = new Set(), payloads = new Set();
  let total = 0;
  for (const file of manifest.files) {
    targetPath(file.path, context, sessionId);
    const key = file.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error('Duplicate or case-colliding archive path');
    paths.add(key);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256) || !Number.isFinite(file.mtimeMs) || !Array.isArray(file.chunks)) throw new Error('Invalid archived file');
    let bytes = 0;
    for (const chunk of file.chunks) {
      if (!/^payload-\d{6}\.gz$/.test(chunk.name) || payloads.has(chunk.name) || !HASH.test(chunk.sha256) || !Number.isInteger(chunk.rawBytes) || chunk.rawBytes < 1 || chunk.rawBytes > CHUNK_BYTES || !Number.isInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > CHUNK_BYTES + 65536) throw new Error('Invalid archive chunk');
      payloads.add(chunk.name); bytes += chunk.rawBytes;
    }
    if (bytes !== file.bytes) throw new Error('Archive file size mismatch');
    total += file.bytes;
    if (!Number.isSafeInteger(total)) throw new Error('Archive is too large');
  }
  for (const name of paths) {
    const parts = name.split('/');
    while (parts.pop() && parts.length) if (paths.has(parts.join('/'))) throw new Error('Archive file conflicts with a parent path');
  }
  if (!paths.has(('project/' + sessionId + '.jsonl').toLowerCase())) throw new Error('Archive transcript is missing');
  return manifest;
}

function stageSnapshot(session, context, dir) {
  let counter = 0;
  const files = [];
  for (const source of session.files) {
    const relative = logicalPath(source, context, session.sessionId);
    const native = targetPath(relative, context, session.sessionId);
    if (path.resolve(native) !== path.resolve(source.path)) throw new Error('Session path mismatch');
    const before = fs.lstatSync(native);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Session is not a regular file');
    const fd = fs.openSync(native, 'r'), hash = crypto.createHash('sha256'), chunks = [];
    let size = 0;
    try {
      const buf = Buffer.alloc(CHUNK_BYTES);
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null))) {
        const raw = buf.subarray(0, n), data = zlib.gzipSync(raw);
        const name = `payload-${String(++counter).padStart(6, '0')}.gz`;
        if (counter > 999999) throw new Error('Session has too many archive chunks');
        fs.writeFileSync(path.join(dir, name), data, { flag: 'wx', mode: 0o600 });
        hash.update(raw); size += n;
        chunks.push({ name, bytes: data.length, rawBytes: n, sha256: digest(data) });
      }
    } finally { fs.closeSync(fd); }
    const after = fs.lstatSync(native);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino) throw new Error('Session changed while being archived; local files kept');
    files.push({ path: relative, bytes: size, mtimeMs: before.mtimeMs, mode: before.mode & 0o777, sha256: hash.digest('hex'), chunks });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { version: 1, agent: 'claude', projectId: context.projectId, sessionId: session.sessionId, createdAt: new Date().toISOString(), files };
  validateManifest(manifest, context, session.sessionId);
  const text = Buffer.from(JSON.stringify(manifest) + '\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), text, { flag: 'wx', mode: 0o600 });
  return { manifest, bytes: text, revision: digest(text) };
}

// Reconstruct and hash every byte, using bounded gzip chunks rather than whole transcripts in RAM.
function verifyDownload(dir, output, context, sessionId, revision) {
  const raw = fs.readFileSync(safePath(dir, 'manifest.json'));
  if (digest(raw) !== revision) throw new Error('Remote archive manifest checksum mismatch');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error('Invalid remote archive JSON'); }
  validateManifest(manifest, context, sessionId, revision);
  if (output) fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i], hash = crypto.createHash('sha256');
    const fd = output ? fs.openSync(path.join(output, String(i)), 'wx', 0o600) : undefined;
    try {
      for (const chunk of file.chunks) {
        const data = fs.readFileSync(safePath(dir, chunk.name));
        if (data.length !== chunk.bytes || digest(data) !== chunk.sha256) throw new Error('Remote archive chunk checksum mismatch');
        const bytes = zlib.gunzipSync(data, { maxOutputLength: CHUNK_BYTES });
        if (bytes.length !== chunk.rawBytes) throw new Error('Remote archive chunk length mismatch');
        hash.update(bytes);
        let offset = 0;
        if (fd !== undefined) while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (hash.digest('hex') !== file.sha256) throw new Error('Remote archive file checksum mismatch');
  }
  return manifest;
}

function assertUnchanged(manifest, context, discoverSessions) {
  const sessions = discoverSessions({ ...context, sessionId: manifest.sessionId });
  const session = sessions.find(s => s.sessionId === manifest.sessionId);
  if (!session || session.files.length !== manifest.files.length) throw new Error('Session files changed; local files kept');
  const files = new Map(session.files.map(f => [logicalPath(f, context, session.sessionId), f]));
  for (const file of manifest.files) {
    const candidate = files.get(file.path), target = targetPath(file.path, context, manifest.sessionId);
    if (!candidate || candidate.size !== file.bytes || hashFile(target) !== file.sha256) throw new Error('Session contents changed; local files kept');
  }
}

function temporaryDirectory(context, fn) {
  const root = safePath(context.memRoot, 'archive-cache');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(root, 'transaction-'));
  fs.chmodSync(dir, 0o700);
  try { return fn(dir); }
  finally {
    const resolved = safePath(root, path.basename(dir));
    if (path.dirname(resolved) !== path.resolve(root) || !path.basename(resolved).startsWith('transaction-')) throw new Error('Unsafe archive cache cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// Interrupted removals keep their remaining originals outside disposable staging. Recovery
// publishes a hard link without replacing anything created since the archive started.
function recoverPending(context, deps, selectedId) {
  deps.assertClaudeStopped(context);
  const state = readState(context);
  let recovered = 0;
  for (const [id, record] of Object.entries(state.sessions)) {
    if ((selectedId && id !== selectedId) || !record.pending) continue;
    const pending = record.pending;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(pending.id) || !Array.isArray(pending.files)) throw new Error('Invalid pending archive recovery record');
    const dir = safePath(context.claudeRoot, '.mem-mastero-archive-' + pending.id);
    const seen = new Set();
    for (let i = 0; i < pending.files.length; i++) {
      const file = pending.files[i], target = targetPath(file.path, context, id);
      if (seen.has(target.toLowerCase())) throw new Error('Invalid duplicate archive recovery path');
      seen.add(target.toLowerCase());
      const saved = safePath(dir, String(i));
      let stat;
      try { stat = fs.lstatSync(saved); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (!stat.isFile()) throw new Error('Unexpected archive quarantine entry');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      try { fs.linkSync(saved, target); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const existing = fs.lstatSync(target);
        // Resume after a crash between link and unlink without mistaking equal bytes
        // in an independent newer file for the same original.
        if (!existing.isFile() || existing.dev !== stat.dev || existing.ino !== stat.ino || !stat.ino) throw new Error(`Archive recovery conflict; both copies kept: ${target} and ${saved}`);
      }
      fs.unlinkSync(saved); recovered++;
    }
    try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    delete record.pending;
    writeState(context, state);
  }
  return { recovered };
}

function archiveSession(session, context, deps) {
  return temporaryDirectory(context, tmp => {
    deps.assertClaudeStopped(context);
    const staging = path.join(tmp, 'upload'); fs.mkdirSync(staging);
    const snapshot = stageSnapshot(session, context, staging);
    const nodeId = require('./archive-graph').nodeId(context, session.sessionId, snapshot.revision);
    const descriptor = deps.backend.publishSnapshot({ projectId: context.projectId, sessionId: session.sessionId, revision: snapshot.revision, dir: staging });
    // Reuse temporary space for readback; never keep two compressed copies plus
    // a reconstructed transcript on the drive we are trying to free.
    for (const name of fs.readdirSync(staging)) fs.unlinkSync(safePath(staging, name));
    fs.rmdirSync(staging);
    const downloaded = path.join(tmp, 'download');
    deps.backend.downloadSnapshot(descriptor, downloaded);
    const verified = verifyDownload(downloaded, null, context, session.sessionId, snapshot.revision);
    assertUnchanged(verified, context, deps.discoverSessions);
    deps.assertClaudeStopped(context);
    const state = readState(context);
    if (state.sessions[session.sessionId]?.pending) throw new Error('An interrupted archive needs recovery first: run archive --recover');
    const pending = { id: crypto.randomUUID(), files: verified.files.map(file => ({ path: file.path })) };
    state.sessions[session.sessionId] = { revision: snapshot.revision, descriptor, archivedAt: verified.createdAt, pending };
    // Journal before removal. A crash leaves the verified remote revision discoverable and blocks eager sync.
    writeState(context, state);
    assertUnchanged(verified, context, deps.discoverSessions);
    deps.assertClaudeStopped(context);
    let removedBytes = 0;
    const quarantine = safePath(context.claudeRoot, '.mem-mastero-archive-' + pending.id);
    fs.mkdirSync(quarantine, { mode: 0o700 });
    try {
      for (let i = 0; i < verified.files.length; i++) fs.renameSync(targetPath(verified.files[i].path, context, session.sessionId), path.join(quarantine, String(i)));
      // A writer racing discovery/rename cannot have its new bytes mistaken for our snapshot.
      for (let i = 0; i < verified.files.length; i++) {
        const file = verified.files[i], isolated = safePath(quarantine, String(i));
        if (fs.lstatSync(isolated).size !== file.bytes || hashFile(isolated) !== file.sha256 || fs.existsSync(targetPath(file.path, context, session.sessionId))) throw new Error('Session changed during removal; originals retained for recovery');
      }
      deps.assertClaudeStopped(context);
      for (let i = 0; i < verified.files.length; i++) {
        const file = verified.files[i], isolated = safePath(quarantine, String(i));
        deps.assertClaudeStopped(context);
        if (fs.lstatSync(isolated).size !== file.bytes || hashFile(isolated) !== file.sha256) throw new Error('Quarantined session changed; remaining originals retained');
        fs.unlinkSync(isolated); removedBytes += file.bytes;
      }
      fs.rmdirSync(quarantine);
      delete state.sessions[session.sessionId].pending;
      writeState(context, state);
    } catch (error) {
      try { recoverPending(context, deps, session.sessionId); }
      catch (recovery) { throw new Error(`${error.message}. Remaining originals are in ${quarantine}. Close Claude and run archive --recover. ${recovery.message}`); }
      throw new Error(`${error.message}. Remaining local files restored; restore ${session.sessionId} recovers any already removed files from the verified cloud archive.`);
    }
    return { sessionId: session.sessionId, revision: snapshot.revision, nodeId, removedBytes, files: verified.files.length };
  });
}

function listArchives(context, backend, sessionId) {
  return backend.listSnapshots(context.projectId, sessionId).map(descriptor => {
    const bytes = backend.readManifest(descriptor);
    if (digest(bytes) !== descriptor.revision) throw new Error('Archive manifest checksum mismatch');
    const manifest = validateManifest(JSON.parse(bytes), context, descriptor.sessionId, descriptor.revision);
    return { ...descriptor, createdAt: manifest.createdAt, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), files: manifest.files.length };
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.revision.localeCompare(b.revision));
}

function assertNoExtraFiles(manifest, context) {
  const id = manifest.sessionId;
  const allowed = new Set(manifest.files.map(file => targetPath(file.path, context, id)));
  const roots = [path.join(context.projectDir, id + '.jsonl'), path.join(context.projectDir, id),
    ...ASSET_ROOTS.map(root => path.join(context.claudeRoot, root, id)),
    ...['json', 'env'].map(ext => path.join(context.claudeRoot, 'session-env', id + '.' + ext))];
  function visit(file) {
    safePath(context.claudeRoot, path.relative(context.claudeRoot, file));
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    else if (!stat.isFile() || !allowed.has(file)) throw new Error(`Restore conflict; extra local session file kept: ${file}`);
  }
  for (const root of roots) visit(root);
}

function restoreSession(sessionId, revision, context, deps) {
  deps.assertClaudeStopped(context);
  if (readState(context).sessions[sessionId]?.pending) recoverPending(context, deps, sessionId);
  const snapshots = listArchives(context, deps.backend, sessionId);
  const descriptor = revision ? snapshots.find(s => s.revision === revision) : snapshots[0];
  if (!descriptor) throw new Error('No matching cloud archive found for this session and project');
  return temporaryDirectory(context, tmp => {
    const downloaded = path.join(tmp, 'download'), verified = path.join(tmp, 'verified');
    deps.backend.downloadSnapshot(descriptor, downloaded);
    const manifest = verifyDownload(downloaded, verified, context, sessionId, descriptor.revision);
    assertNoExtraFiles(manifest, context);
    const targets = manifest.files.map(file => targetPath(file.path, context, sessionId));
    const missing = [];
    for (let i = 0; i < targets.length; i++) {
      try {
        const stat = fs.lstatSync(targets[i]);
        if (!stat.isFile() || stat.size !== manifest.files[i].bytes || hashFile(targets[i]) !== manifest.files[i].sha256) throw new Error(`Restore conflict; existing local file kept: ${targets[i]}`);
      } catch (e) { if (e.code !== 'ENOENT') throw e; missing.push(i); }
    }
    deps.assertClaudeStopped(context);
    const state = readState(context);
    state.sessions[sessionId] = { revision: descriptor.revision, descriptor, archivedAt: manifest.createdAt, restoredAt: new Date().toISOString() };
    writeState(context, state); // Legacy sync must not replace this archive with an older copy.
    let restoredBytes = 0;
    for (const i of missing) {
      const target = targetPath(manifest.files[i].path, context, sessionId);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = safePath(path.dirname(target), `.mem-mastero-${crypto.randomUUID()}.tmp`);
      try {
        try { fs.linkSync(path.join(verified, String(i)), temp); }
        catch (e) {
          if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(e.code)) throw e;
          fs.copyFileSync(path.join(verified, String(i)), temp, fs.constants.COPYFILE_EXCL);
        }
        fs.chmodSync(temp, 0o600);
        // A hard link publishes a complete file atomically and cannot overwrite a racing writer.
        fs.linkSync(temp, target);
        restoredBytes += manifest.files[i].bytes;
      } finally { fs.rmSync(temp, { force: true }); }
    }
    return { sessionId, revision: descriptor.revision, restoredBytes, files: missing.length, transcript: path.join(context.projectDir, sessionId + '.jsonl') };
  });
}

function formatBytes(n) { return `${(n / 1024 / 1024).toFixed(2)} MiB`; }

function runArchiveCommand(command, args, services) {
  const options = parseArgs(command, args);
  const inventory = services.inventory || require('./claude-files');
  const log = services.log || console.log;
  if (command === 'storage') {
    const report = inventory.scanStorage({ claudeRoot: services.claudeRoot, memRoot: services.memRoot });
    if (options.json) log(JSON.stringify(report, null, 2));
    else {
      log('Local storage (logical file bytes; no cloud access):');
      for (const [name, value] of Object.entries(report.categories)) log(`  ${name}: ${formatBytes(value.bytes)} (${value.files} files)`);
      log(`  Total: ${formatBytes(report.totalBytes)}`);
      log('Legacy memory clones and Git history are retained; archive removes verified native session files only.');
      if (report.errors.length) log(`  Incomplete measurement: ${report.errors.length} unreadable paths.`);
    }
    if (report.errors.length) throw new Error('Storage measurement was incomplete; inspect --json errors');
    return report;
  }
  const context = services.context();
  let result;
  withArchiveLock(context.memRoot, () => {
    if (options.recover) {
      result = recoverPending(context, inventory);
    } else if (command === 'archive' && !options.list) {
      const sessions = inventory.discoverSessions({ ...context, sessionId: options.session });
      const cutoff = Date.now() - Number(options['older-than'] ?? 30) * 86400000;
      const candidates = sessions.filter(s => options.session ? s.sessionId === options.session : s.lastModifiedMs < cutoff);
      if (options.session && !candidates.length) throw new Error('Local Claude session not found in this project');
      if (options['dry-run']) {
        result = { dryRun: true, sessions: candidates.map(s => ({ sessionId: s.sessionId, bytes: s.bytes, files: s.files.length })), reclaimableBytes: candidates.reduce((n, s) => n + s.bytes, 0) };
      } else {
        inventory.assertClaudeStopped(context);
        const backend = services.backend || require('./archive-store').createArchiveStore(context.store);
        result = { archived: candidates.map(session => archiveSession(session, context, { ...inventory, backend })) };
      }
    } else {
      const backend = services.backend || require('./archive-store').createArchiveStore(context.store);
      result = options.list ? { archives: listArchives(context, backend) } : restoreSession(options.session, options.revision, context, { ...inventory, backend });
    }
  });
  if (options.json) log(JSON.stringify(result, null, 2));
  else if (result.dryRun) {
    for (const s of result.sessions) log(`  ${s.sessionId}: ${formatBytes(s.bytes)} (${s.files} files)`);
    log(`Dry run: ${result.sessions.length} candidate sessions, ${formatBytes(result.reclaimableBytes)}. No files removed; removal also requires Claude stopped and cloud verification.`);
  } else if (result.archived) {
    for (const s of result.archived) log(`Archived and verified ${s.sessionId}; removed ${formatBytes(s.removedBytes)} of native files. Revision ${s.revision}\nReference: ${s.nodeId}\nRead temporarily with: recall ${s.nodeId} --json`);
    if (!result.archived.length) log('No sessions matched the archive selection.');
  } else if (result.archives) {
    for (const s of result.archives) log(`${s.sessionId}  ${s.createdAt}  ${formatBytes(s.bytes)}  ${s.revision}`);
    if (!result.archives.length) log('No cloud archives for this project.');
  } else if (result.recovered !== undefined) {
    log(`Recovered ${result.recovered} quarantined original files. Use restore ID to recover any files already removed after verification.`);
  } else {
    log(`Restored ${result.sessionId}: ${result.files} files, ${formatBytes(result.restoredBytes)}. Resume with: claude --resume ${result.sessionId}`);
  }
  return result;
}

module.exports = { runArchiveCommand, parseArgs, targetPath, validateManifest, stageSnapshot, verifyDownload, archiveSession, restoreSession, recoverPending, hashFile, CHUNK_BYTES };
