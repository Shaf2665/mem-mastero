// Exercise real graph/recall commands and pull exclusions with isolated synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runAccessCommand, parseAccessArgs } = require('./archive-access');
const { stageSnapshot } = require('./archive');
const { discoverSessions } = require('./claude-files');
const { digest, readState, writeState, excludedFromPull } = require('./archive-state');
const { archivePullState } = require('./sync');
const graph = require('./archive-graph');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-access-test-')));
const context = { memRoot: path.join(root, 'mem'), claudeRoot: path.join(root, 'claude'),
  projectDir: path.join(root, 'claude', 'projects', '-test'), projectId: 'github.com/example/project', store: { github: 'https://github.com/example/memory.git' } };
const put = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

try {
  for (const [cmd, args] of [
    ['graph', ['--refresh', '--refresh']], ['graph', ['--offset', '1']], ['graph', ['--query']],
    ['recall', []], ['recall', ['--cleanup', '--file', 'file']], ['recall', ['one', 'two']],
    ['recall', ['one', '--revision', 'bad']], ['recall', ['one', '--offset', '-1']],
    ['recall', ['one', '--limit', '0']], ['recall', ['one', '--limit', '262145']],
    ['recall', ['one', '--offset', '9007199254740992']], ['recall', ['one', '--json', '--json']],
  ]) assert.throws(() => parseAccessArgs(cmd, args), /Usage:/);
  assert.equal(parseAccessArgs('recall', ['one', '--offset', '0', '--limit', '262144']).limit, 262144);
  const native = path.join(context.projectDir, 'one.jsonl');
  const original = Buffer.from('{"sessionId":"one","message":"historical content"}\n');
  put(native, original);
  const cloud = path.join(root, 'cloud'); fs.mkdirSync(cloud);
  const snapshot = stageSnapshot(discoverSessions(context)[0], context, cloud);
  const descriptor = { projectId: context.projectId, sessionId: 'one', revision: snapshot.revision,
    commit: 'a'.repeat(40), basePath: `v1/${digest(context.projectId)}/one/${snapshot.revision}` };
  let downloads = 0, reads = 0, lists = 0;
  const backend = {
    listSnapshots() { lists++; return [descriptor]; },
    readManifest() { reads++; return fs.readFileSync(path.join(cloud, 'manifest.json')); },
    downloadSnapshot(d, dir) { assert.equal(d.revision, descriptor.revision); downloads++; fs.cpSync(cloud, dir, { recursive: true }); },
  };
  const logs = [], services = { ...context, context: () => context, backend, log: text => logs.push(text) };
  const fresh = archivePullState(context, backend);
  assert(excludedFromPull('one.jsonl', fresh), 'fresh machine skips native archived transcript without local eviction state');
  assert(excludedFromPull('one/subagents/a.jsonl', fresh));
  assert(!excludedFromPull('memory/MEMORY.md', fresh));
  assert(!excludedFromPull('other.jsonl', fresh));
  assert.equal(downloads, 0); assert.equal(reads, 0, 'pull needs only catalogue tree metadata');
  assert.deepEqual(readState(context).sessions, {}, 'pull filtering does not overwrite local recovery records');
  assert.throws(() => archivePullState(context, { listSnapshots() { throw Error('offline'); } }), /offline/, 'cloud lookup failure must not fall back to eager restoration');
  for (const d of [{ ...descriptor, projectId: 'another' }, { ...descriptor, sessionId: '../escape' }, { ...descriptor, basePath: 'bad' }, { ...descriptor, commit: 'bad' }]) {
    assert.throws(() => archivePullState(context, { listSnapshots: () => [d] }), /Invalid archive catalogue/);
  }
  const index = runAccessCommand('graph', ['--refresh', '--json'], services);
  assert.equal(downloads, 0);
  assert.equal(index.nodes.filter(n => n.type === 'archive').length, 1);
  assert.equal(JSON.parse(logs.at(-1)).version, 1);
  const offline = { ...services };
  Object.defineProperty(offline, 'backend', { get() { throw Error('cached graph must be offline'); } });
  assert.deepEqual(runAccessCommand('graph', [], offline), index);
  assert.equal(runAccessCommand('graph', ['--query', 'ONE JSONL', '--json'], offline).matches.length, 1);
  assert.equal(runAccessCommand('graph', ['--query', 'missing'], offline).matches.length, 0);
  const node = index.nodes.find(n => n.type === 'archive');
  // A local native restore cannot be overwritten by an old sync copy.
  const pending = { id: 'retained-test-marker', files: [] };
  writeState(context, { version: 1, sessions: { one: { revision: descriptor.revision, pending } } });
  assert.deepEqual(archivePullState(context, backend).sessions.one.pending, pending);
  const beforeLists = lists;
  const recalled = runAccessCommand('recall', [node.id, '--limit', '12', '--json'], services);
  assert.equal(lists, beforeLists, 'known pinned reference does not relist all archives');
  assert.equal(recalled.nodeId, node.id);
  assert.equal(recalled.content, original.subarray(0, 12).toString());
  assert.equal(recalled.nextOffset, 12); assert.equal(recalled.truncated, true);
  assert.equal(recalled.temporaryFilesRemoved, true);
  assert.deepEqual(fs.readFileSync(native), original);
  assert.deepEqual(readState(context).sessions.one.pending, pending, 'recall does not touch native archive recovery');
  const cache = path.join(context.memRoot, 'recall-cache');
  assert.deepEqual(fs.readdirSync(cache), []);
  const tail = runAccessCommand('recall', [node.id, '--offset', '12', '--json'], services);
  assert.equal(tail.content, original.subarray(12).toString()); assert.equal(tail.truncated, false);
  assert.throws(() => runAccessCommand('recall', [node.id], { ...services, log() { throw Error('consumer disconnected'); } }), /consumer disconnected/);
  assert.deepEqual(fs.readdirSync(cache), [], 'output failure cannot strand a downloaded archive');
  const clean = runAccessCommand('recall', ['--cleanup', '--json'], { memRoot: context.memRoot, context() { throw Error('no current project'); }, log() {} });
  assert.equal(clean.removed, 0); assert.equal(clean.skippedLive, 0); assert.deepEqual(clean.retained, []);
  assert.equal(digest(fs.readFileSync(path.join(cloud, 'manifest.json'))), descriptor.revision, 'cloud copy unchanged');
  // The real CLI exposes new commands and supports offline cleanup outside any project.
  const help = spawnSync(process.execPath, [path.join(__dirname, 'sync.js'), 'help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0); assert.match(help.stdout, /graph \[--refresh\]/); assert.match(help.stdout, /recall NODE_OR_SESSION/);
  const cliHome = path.join(root, 'cli-home'); fs.mkdirSync(cliHome);
  const cleanup = spawnSync(process.execPath, [path.join(__dirname, 'sync.js'), 'recall', '--cleanup', '--json'], {
    cwd: root, env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(cleanup.status, 0, cleanup.stderr); assert.equal(JSON.parse(cleanup.stdout).removed, 0);
  console.log('Archive access CLI and fresh-machine suppression tests passed.');
} finally {
  assert.equal(fs.realpathSync.native(root), root);
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(root).startsWith('mm-access-test-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
