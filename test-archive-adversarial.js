// Filesystem interleavings around the last irreversible archive operation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { archiveSession, targetPath, recoverPending } = require('./archive');
const { readState, writeState, safePath } = require('./archive-state');
const { discoverSessions } = require('./claude-files');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-archive-adversarial-')));
const claudeRoot = path.join(root, 'claude');
const projectDir = path.join(claudeRoot, 'projects', '-fixture');
const memRoot = path.join(root, 'mem');
const context = { claudeRoot, projectDir, memRoot, projectId: 'github.com/test/project', store: { github: 'https://github.com/test/memory' } };
const sessionId = 'late-writer';
const original = Buffer.from('verified original transcript\n');
const updated = Buffer.from('verified original transcript\nnew data written just before removal\n');

function containsBytes(dir, bytes) {
  if (!fs.existsSync(dir)) return false;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory() && containsBytes(file, bytes)) return true;
    if (stat.isFile() && fs.readFileSync(file).equals(bytes)) return true;
  }
  return false;
}

try {
  if (process.platform === 'darwin') {
    for (const alias of ['/var', '/tmp', '/etc']) {
      assert.doesNotThrow(() => safePath(alias, 'mem-mastero-alias-check'), 'standard macOS system aliases are valid ancestors');
    }
  }
  fs.mkdirSync(projectDir, { recursive: true });
  const linkedChild = path.join(root, 'linked-child');
  fs.symlinkSync(projectDir, linkedChild, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safePath(root, 'linked-child/session.jsonl'), /Refusing symbolic link/);
  const transcript = path.join(projectDir, sessionId + '.jsonl');
  fs.writeFileSync(transcript, original);
  const cloud = path.join(root, 'fake-cloud');
  const backend = {
    publishSnapshot({ dir, revision }) {
      fs.cpSync(dir, cloud, { recursive: true });
      return { projectId: context.projectId, sessionId, revision, commit: 'a'.repeat(40), basePath: 'fake' };
    },
    downloadSnapshot(descriptor, dir) { fs.cpSync(cloud, dir, { recursive: true }); },
  };
  const session = discoverSessions(context)[0];
  const realUnlink = fs.unlinkSync, realRename = fs.renameSync;
  let raced = false;
  function interleave(source) {
    if (!raced && path.resolve(String(source)) === path.resolve(transcript)) {
      raced = true;
      fs.writeFileSync(transcript, updated);
    }
  }
  // Model another process writing after the final preflight hash but immediately
  // before the source is detached. Both direct unlink and quarantine designs run it.
  fs.unlinkSync = (file, ...args) => { interleave(file); return realUnlink(file, ...args); };
  fs.renameSync = (source, target, ...args) => { interleave(source); return realRename(source, target, ...args); };
  let error;
  try { archiveSession(session, context, { discoverSessions, assertClaudeStopped() {}, backend }); }
  catch (caught) { error = caught; }
  finally { fs.unlinkSync = realUnlink; fs.renameSync = realRename; }
  assert(raced, 'test must interleave a real local write at source removal');
  assert(containsBytes(claudeRoot, updated) || containsBytes(memRoot, updated),
    'a local version changed after cloud verification must survive at its source or a documented recovery path');
  assert(error, 'archive must report that the late local change could not be removed safely');

  // Never permit a cloud manifest to address unrelated configuration or Windows ADS.
  for (const relative of [
    '../settings.json', 'project/../settings.json', 'project/late-writer.jsonl:secret',
    'project/late-writer/CON', 'project/late-writer/name.', 'project/late-writer/name ',
    'project/memory/MEMORY.md', 'file-history/another-session/checkpoint',
    'project/late-writer\\outside', '/project/late-writer.jsonl',
  ]) assert.throws(() => targetPath(relative, context, sessionId), /Unsafe|does not belong|escapes/);

  function pendingSession(id, files) {
    const transaction = crypto.randomUUID();
    const quarantine = path.join(claudeRoot, '.mem-mastero-archive-' + transaction);
    fs.mkdirSync(quarantine);
    const state = readState(context);
    state.sessions[id] = { revision: 'a'.repeat(64), pending: { id: transaction, files: files.map(relative => ({ path: relative })) } };
    writeState(context, state);
    return quarantine;
  }

  // A process stopped after moving one of several files. Recovery restores only
  // files already moved; it leaves originals that had not been moved untouched.
  const partialId = 'partial-move';
  const partialDir = pendingSession(partialId, ['project/' + partialId + '.jsonl', 'project/' + partialId + '/tool-results/value.txt']);
  fs.writeFileSync(path.join(partialDir, '0'), 'transcript before interruption');
  const untouched = path.join(projectDir, partialId, 'tool-results', 'value.txt');
  fs.mkdirSync(path.dirname(untouched), { recursive: true });
  fs.writeFileSync(untouched, 'not yet moved');
  recoverPending(context, { assertClaudeStopped() {} }, partialId);
  assert.strictEqual(fs.readFileSync(path.join(projectDir, partialId + '.jsonl'), 'utf8'), 'transcript before interruption');
  assert.strictEqual(fs.readFileSync(untouched, 'utf8'), 'not yet moved');
  assert(!readState(context).sessions[partialId].pending);

  // Recovery itself stopped after hard-link publication, before source unlink.
  // Repeating recovery must finish that operation instead of reporting a false conflict.
  const linkedId = 'recovery-link';
  const linkedDir = pendingSession(linkedId, ['project/' + linkedId + '.jsonl']);
  const saved = path.join(linkedDir, '0'), linkedTarget = path.join(projectDir, linkedId + '.jsonl');
  fs.writeFileSync(saved, 'the same preserved inode');
  fs.linkSync(saved, linkedTarget);
  recoverPending(context, { assertClaudeStopped() {} }, linkedId);
  assert.strictEqual(fs.readFileSync(linkedTarget, 'utf8'), 'the same preserved inode');
  assert(!fs.existsSync(saved));
  assert(!readState(context).sessions[linkedId].pending);

  // A genuinely competing local version must remain separate from the saved original.
  const conflictId = 'recovery-conflict';
  const conflictDir = pendingSession(conflictId, ['project/' + conflictId + '.jsonl']);
  const conflictSaved = path.join(conflictDir, '0'), conflictTarget = path.join(projectDir, conflictId + '.jsonl');
  fs.writeFileSync(conflictSaved, 'quarantined original');
  fs.writeFileSync(conflictTarget, 'new local version');
  assert.throws(() => recoverPending(context, { assertClaudeStopped() {} }, conflictId), /conflict.*both copies kept/i);
  assert.strictEqual(fs.readFileSync(conflictSaved, 'utf8'), 'quarantined original');
  assert.strictEqual(fs.readFileSync(conflictTarget, 'utf8'), 'new local version');
  assert(readState(context).sessions[conflictId].pending);

  // An active Claude process blocks recovery before publishing any files.
  fs.unlinkSync(conflictTarget);
  assert.throws(() => recoverPending(context, { assertClaudeStopped() { throw new Error('Claude still running'); } }, conflictId), /running/);
  assert(!fs.existsSync(conflictTarget));
  assert.strictEqual(fs.readFileSync(conflictSaved, 'utf8'), 'quarantined original');

  console.log('Archive adversarial interleaving tests passed');
} finally {
  const resolved = fs.realpathSync.native(root);
  if (resolved !== root || !path.basename(resolved).startsWith('mm-archive-adversarial-')) throw new Error('Unexpected adversarial test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
