// Graph discovery reads only verified manifests; node resolution never trusts a
// graph-provided URL or filesystem path and always rechecks the cloud manifest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { digest } = require('./archive-state');
const graph = require('./archive-graph');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-archive-graph-')));
let serial = 0;
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const dir = path.join(root, String(++serial));
  const context = { memRoot: path.join(dir, 'mem'), claudeRoot: path.join(dir, 'claude'), projectDir: path.join(dir, 'claude', 'projects', '-test'),
    projectId: 'github.com/example/project', store: { github: 'https://account@github.com/example/memory.git' } };
  const entries = [], bytesByRevision = new Map();
  const backend = {
    lists: 0, reads: 0, downloads: 0,
    listSnapshots(projectId) { backend.lists++; assert.equal(projectId, context.projectId); return entries.map(clone); },
    readManifest(descriptor) { backend.reads++; return bytesByRevision.get(descriptor.revision); },
    downloadSnapshot() { backend.downloads++; throw new Error('metadata discovery must not download payloads'); },
  };
  function add(sessionId = 'session-1', createdAt = '2026-10-01T12:00:00.000Z', extraFiles = 1, mutate) {
    const file = name => ({ path: name, bytes: 0, mtimeMs: 1, mode: 384, sha256: digest(''), chunks: [] });
    const manifest = { version: 1, agent: 'claude', projectId: context.projectId, sessionId, createdAt,
      files: [file(`project/${sessionId}.jsonl`), ...Array.from({ length: extraFiles }, (_, i) => file(`project/${sessionId}/tool-results/result-${String(i).padStart(4, '0')}.txt`))] };
    if (mutate) mutate(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest) + '\n'), revision = digest(bytes);
    const descriptor = { projectId: context.projectId, sessionId, revision,
      basePath: `v1/${digest(context.projectId)}/${sessionId}/${revision}`, commit: 'a'.repeat(40) };
    entries.push(descriptor); bytesByRevision.set(revision, bytes);
    return { descriptor, manifest, bytes, id: graph.nodeId(context, sessionId, revision) };
  }
  return { dir, context, entries, bytesByRevision, backend, add };
}

try {
  const f = fixture(), old = f.add(), newer = f.add('session-1', '2026-10-12T12:00:00.000Z'), other = f.add('session-2');
  assert.equal(graph.readGraph(f.context), null);
  const built = graph.buildGraph(f.context, f.backend);
  assert.equal(f.backend.lists, 1);
  assert.equal(f.backend.reads, 3);
  assert.equal(f.backend.downloads, 0);
  assert.equal(built.nodes.filter(n => n.type === 'project').length, 1);
  assert.equal(built.nodes.filter(n => n.type === 'session').length, 2);
  assert.equal(built.nodes.filter(n => n.type === 'archive').length, 3);
  assert.equal(built.edges.length, 5);
  assert.equal(built.store, 'github.com/example/memory');
  assert(!JSON.stringify(built).includes('account@'), 'credentials/account prefixes are not stored in graph metadata');
  assert(!JSON.stringify(built).includes('chunks'), 'graph does not duplicate payload/chunk descriptions');
  assert.equal(graph.queryGraph(built)[0].id, newer.id);
  assert.equal(graph.queryGraph(built, 'SESSION-2 result-0000').length, 1);
  assert.equal(graph.queryGraph(built, 'unknown').length, 0);
  assert.throws(() => graph.queryGraph(built, {}), /Invalid.*query/);
  const bounded = fixture();
  for (let i = 0; i < 20; i++) bounded.add('bounded-' + i);
  assert.throws(() => graph.buildGraph(bounded.context, bounded.backend, { maxBytes: 5000 }), /exceeds the local cache limit/);
  assert(bounded.backend.reads > 0 && bounded.backend.reads < 20, 'metadata limit stops before fetching/retaining every manifest');
  assert.equal(bounded.backend.downloads, 0);
  assert.equal(graph.readGraph(bounded.context), null, 'a failed build publishes no partial index');
  assert.throws(() => graph.buildGraph(bounded.context, bounded.backend, { maxBytes: 33 * 1024 * 1024 }), /Invalid.*budget/);
  assert.deepEqual(graph.writeGraph(f.context, built), built);
  assert.deepEqual(graph.readGraph(f.context), built);
  if (process.platform !== 'win32') assert.equal(fs.statSync(graph.graphPath(f.context)).mode & 0o777, 0o600);

  const secondContext = { ...f.context, memRoot: path.join(f.dir, 'second-mem'), claudeRoot: path.join(f.dir, 'second-claude'), projectDir: path.join(f.dir, 'second-claude', 'projects', '-elsewhere'), store: { github: 'git@github.com:example/memory.git' } };
  assert.equal(graph.nodeId(secondContext, 'session-1', old.descriptor.revision), old.id, 'reference survives a machine/path or URL-format change');
  assert.notEqual(graph.nodeId({ ...f.context, store: { github: 'https://github.com/example/other-memory' } }, 'session-1', old.descriptor.revision), old.id);
  assert.notEqual(graph.nodeId({ ...f.context, projectId: 'github.com/example/other-project' }, 'session-1', old.descriptor.revision), old.id);
  assert.throws(() => graph.nodeId(f.context, undefined, old.descriptor.revision), /Invalid.*reference/);
  assert.throws(() => graph.nodeId(f.context, '../escape', old.descriptor.revision), /Invalid.*reference/);

  const listsBefore = f.backend.lists, readsBefore = f.backend.reads;
  const pinned = graph.resolveNode(f.context, f.backend, old.id);
  assert.equal(pinned.descriptor.revision, old.descriptor.revision);
  assert.equal(pinned.nodeId, old.id);
  assert.equal(f.backend.lists, listsBefore, 'known immutable reference does not need to enumerate other archives');
  assert.equal(f.backend.reads, readsBefore + 1, 'cached reference still rechecks its cloud manifest');
  assert.deepEqual(pinned.manifest, old.manifest);
  const newest = f.add('session-1', '2026-10-20T12:00:00.000Z');
  assert.equal(graph.resolveNode(f.context, f.backend, 'session-1').nodeId, newest.id, 'bare session ID refreshes before choosing latest revision');
  assert.equal(graph.resolveNode(f.context, f.backend, 'session-1', { revision: old.descriptor.revision }).nodeId, old.id);
  const missingOnThisMachine = f.add('session-3');
  assert.equal(graph.resolveNode(f.context, f.backend, missingOnThisMachine.id).nodeId, missingOnThisMachine.id, 'a new node is found by metadata-only refresh');
  const readsBeforeMismatch = f.backend.reads;
  assert.throws(() => graph.resolveNode(f.context, f.backend, old.id, { revision: newer.descriptor.revision }), /Revision option conflicts/);
  assert.equal(f.backend.reads, readsBeforeMismatch, 'known reference/revision mismatch is rejected before remote reads');
  assert.throws(() => graph.resolveNode(f.context, f.backend, 'https://attacker.invalid/archive'), /Invalid archive node/);
  assert.throws(() => graph.resolveNode(f.context, f.backend, '../escape'), /Invalid archive node/);
  assert.equal(f.backend.downloads, 0);

  const freshMachine = graph.resolveNode(secondContext, f.backend, other.id);
  assert.equal(freshMachine.nodeId, other.id);
  assert(graph.readGraph(secondContext));

  // A local metadata cache is untrusted input. It cannot select another store,
  // project, arbitrary path, duplicated relationship, or altered archive ID.
  for (const mutate of [
    g => { g.store = 'github.com/example/wrong'; },
    g => { g.projectId = 'github.com/example/wrong'; },
    g => { g.version = 2; },
    g => { g.nodes[0].label = 'unrelated project'; },
    g => { g.edges[0].target = g.edges[0].source; },
    g => { g.edges.push(g.edges[0]); },
    g => { g.nodes.push(g.nodes[0]); },
    g => { g.nodes.find(n => n.type === 'archive').id = 'archive:' + '0'.repeat(64); },
    g => { g.nodes.find(n => n.type === 'archive').descriptor.basePath = '../../escape'; },
    g => { g.nodes.find(n => n.type === 'archive').descriptor.url = 'https://attacker.invalid'; },
    g => { g.nodes.find(n => n.type === 'archive').filePaths[0] = '../settings.json'; },
    g => { g.nodes.find(n => n.type === 'archive').bytes = -1; },
    g => { g.nodes.find(n => n.type === 'archive').files = 1234; },
    g => { g.nodes.find(n => n.type === 'archive').content = 'must never cache transcript content'; },
  ]) {
    const altered = clone(built); mutate(altered);
    fs.writeFileSync(graph.graphPath(f.context), JSON.stringify(altered));
    assert.throws(() => graph.readGraph(f.context), /Invalid|Unsafe|Unexpected|Duplicate/);
    assert.throws(() => graph.writeGraph(f.context, altered), /Invalid|Unsafe|Unexpected|Duplicate/);
  }
  fs.writeFileSync(graph.graphPath(f.context), '{broken');
  assert.throws(() => graph.readGraph(f.context), /Invalid local archive graph JSON/);
  graph.writeGraph(f.context, built);
  const tampered = clone(built);
  tampered.nodes.find(n => n.id === old.id).createdAt = '2027-01-01T00:00:00.000Z';
  graph.writeGraph(f.context, tampered);
  assert.throws(() => graph.resolveNode(f.context, f.backend, old.id), /differs from its verified cloud manifest/);
  graph.writeGraph(f.context, built);
  f.bytesByRevision.set(old.descriptor.revision, Buffer.from('changed cloud manifest'));
  assert.throws(() => graph.resolveNode(f.context, f.backend, old.id), /checksum/);
  f.bytesByRevision.set(old.descriptor.revision, old.bytes);

  const corrupted = fixture();
  corrupted.add('session-path', '2026-10-01T12:00:00.000Z', 0, m => { m.files[0].path = '../settings.json'; });
  assert.throws(() => graph.buildGraph(corrupted.context, corrupted.backend), /Unsafe archive path/);
  const wrongProject = fixture();
  wrongProject.add('session-wrong', '2026-10-01T12:00:00.000Z', 0, m => { m.projectId = 'github.com/other/project'; });
  assert.throws(() => graph.buildGraph(wrongProject.context, wrongProject.backend), /Invalid archive manifest/);
  const duplicate = fixture(); duplicate.add(); duplicate.entries.push(duplicate.entries[0]);
  assert.throws(() => graph.buildGraph(duplicate.context, duplicate.backend), /Duplicate archive graph revision/);
  const wrongDescriptor = fixture(); wrongDescriptor.add(); wrongDescriptor.entries[0].projectId = 'github.com/other/project';
  assert.throws(() => graph.buildGraph(wrongDescriptor.context, wrongDescriptor.backend), /Invalid archive graph descriptor/);

  const large = fixture(); large.add('large', undefined, 180);
  const largeGraph = graph.buildGraph(large.context, large.backend), archive = graph.queryGraph(largeGraph)[0];
  assert.equal(archive.files, 181);
  assert.equal(archive.filePaths.length, 128);
  assert.equal(archive.pathsTruncated, true);
  graph.writeGraph(large.context, largeGraph);
  assert.deepEqual(graph.readGraph(large.context), largeGraph);
  assert.equal(graph.resolveNode(large.context, large.backend, archive.id).manifest.files.length, 181, 'bounded graph metadata never truncates the verified manifest used for recall');

  const empty = fixture(), emptyGraph = graph.buildGraph(empty.context, empty.backend);
  assert.equal(emptyGraph.nodes.length, 1);
  assert.equal(emptyGraph.edges.length, 0);
  assert.deepEqual(graph.queryGraph(emptyGraph), []);
  assert.throws(() => graph.resolveNode(empty.context, empty.backend, 'missing-session'), /No matching archive node/);

  const symlink = fixture(), linkRoot = path.join(symlink.context.memRoot, 'archive-graph'), outside = path.join(symlink.dir, 'outside');
  fs.mkdirSync(symlink.context.memRoot, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => graph.readGraph(symlink.context), /Refusing symbolic link/);
  assert.throws(() => graph.writeGraph(symlink.context, graph.buildGraph(symlink.context, symlink.backend)), /Refusing symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);

  console.log('Archive graph tests passed.');
} finally {
  const resolved = fs.realpathSync.native(root);
  if (resolved !== root || !path.basename(resolved).startsWith('mm-archive-graph-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
