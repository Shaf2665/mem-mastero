// A small, metadata-only graph over immutable Claude archives. This is an index,
// never an authority to delete files or fetch an arbitrary URL from a graph node.
const fs = require('fs');
const path = require('path');
const { SESSION_ID, HASH, digest, safePath } = require('./archive-state');
const NODE_ID = /^archive:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_ARCHIVES = 10000;
const MAX_PATHS = 128;
const MAX_GRAPH_BYTES = 32 * 1024 * 1024;

function scope(context) {
  if (!context || typeof context.projectId !== 'string' || !context.projectId || context.projectId.length > 4096 || /[\x00-\x1f\x7f]/.test(context.projectId)) throw new Error('Invalid archive graph project');
  require('./archive-store').repositoryOf(context.store);
  return { store: require('./sync').normalizeRemote(context.store.github), projectId: context.projectId };
}

function nodeId(context, sessionId, revision) {
  const s = scope(context);
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof revision !== 'string' || !HASH.test(revision)) throw new Error('Invalid archive graph reference');
  return 'archive:' + digest(JSON.stringify([s.store, s.projectId, sessionId, revision]));
}

function projectNodeId(context) {
  const s = scope(context);
  return 'project:' + digest(JSON.stringify([s.store, s.projectId]));
}

function sessionNodeId(context, sessionId) {
  return 'session:' + digest(JSON.stringify([projectNodeId(context), sessionId]));
}

function graphPath(context) {
  const s = scope(context);
  return safePath(context.memRoot, path.join('archive-graph', digest(JSON.stringify([s.store, s.projectId])) + '.json'));
}

function descriptorFor(context, descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || descriptor.projectId !== context.projectId || typeof descriptor.sessionId !== 'string' || !SESSION_ID.test(descriptor.sessionId)
    || typeof descriptor.revision !== 'string' || !HASH.test(descriptor.revision) || typeof descriptor.commit !== 'string' || !COMMIT.test(descriptor.commit)
    || descriptor.basePath !== `v1/${digest(context.projectId)}/${descriptor.sessionId}/${descriptor.revision}`) throw new Error('Invalid archive graph descriptor');
  // Ignore additional server fields rather than persisting possible URLs or absolute paths.
  const { projectId, sessionId, revision, basePath, commit } = descriptor;
  return { projectId, sessionId, revision, basePath, commit };
}

function readVerifiedManifest(context, backend, descriptor) {
  const bytes = backend.readManifest(descriptor);
  if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > 8 * 1024 * 1024 || digest(bytes) !== descriptor.revision) throw new Error('Archive graph manifest checksum mismatch or size limit exceeded');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw new Error('Invalid archive graph manifest JSON'); }
  return require('./archive').validateManifest(manifest, context, descriptor.sessionId, descriptor.revision);
}

function archiveNode(context, descriptor, manifest) {
  const paths = manifest.files.map(f => f.path).sort();
  return {
    id: nodeId(context, descriptor.sessionId, descriptor.revision), type: 'archive', agent: 'claude',
    label: `Claude archive ${descriptor.sessionId}`, sessionId: descriptor.sessionId, revision: descriptor.revision,
    createdAt: manifest.createdAt, bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0), files: paths.length,
    filePaths: paths.slice(0, MAX_PATHS), pathsTruncated: paths.length > MAX_PATHS, descriptor,
  };
}

function assembleGraph(context, archives, generatedAt = new Date().toISOString()) {
  const s = scope(context), projectId = projectNodeId(context);
  const nodes = [{ id: projectId, type: 'project', label: s.projectId }], edges = [], sessions = new Set();
  for (const archive of [...archives].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.revision.localeCompare(b.revision))) {
    const sessionId = sessionNodeId(context, archive.sessionId);
    if (!sessions.has(sessionId)) {
      nodes.push({ id: sessionId, type: 'session', label: archive.sessionId, sessionId: archive.sessionId, agent: 'claude' });
      edges.push({ source: projectId, target: sessionId, type: 'HAS_SESSION' });
      sessions.add(sessionId);
    }
    nodes.push(archive);
    edges.push({ source: sessionId, target: archive.id, type: 'HAS_REVISION' });
  }
  return { version: 1, store: s.store, projectId: s.projectId, generatedAt, nodes, edges };
}

function graphItemBytes(value) {
  const text = JSON.stringify(value, null, 2);
  // Four spaces of array-item indentation per line, plus separators. The small
  // overestimate also covers expansion of an initially empty edges array.
  return Buffer.byteLength(text) + text.split('\n').length * 4 + 4;
}

function buildGraph(context, backend, options = {}) {
  scope(context);
  const maxBytes = options.maxBytes === undefined ? MAX_GRAPH_BYTES : options.maxBytes;
  // Callers may choose a smaller budget, never relax the hard cache limit.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GRAPH_BYTES) throw new Error('Invalid archive graph metadata budget');
  const descriptors = backend.listSnapshots(context.projectId);
  if (!Array.isArray(descriptors) || descriptors.length > MAX_ARCHIVES) throw new Error('Archive graph listing is too large or invalid');
  const seen = new Set(), sessions = new Set(), archives = [];
  const generatedAt = new Date().toISOString(), project = projectNodeId(context);
  let budget = Buffer.byteLength(JSON.stringify(assembleGraph(context, [], generatedAt), null, 2) + '\n');
  if (budget > maxBytes) throw new Error('Archive graph metadata exceeds the local cache limit');
  for (const raw of descriptors) {
    const descriptor = descriptorFor(context, raw), id = nodeId(context, descriptor.sessionId, descriptor.revision);
    if (seen.has(id)) throw new Error('Duplicate archive graph revision');
    seen.add(id);
    const archive = archiveNode(context, descriptor, readVerifiedManifest(context, backend, descriptor));
    const session = sessionNodeId(context, descriptor.sessionId);
    budget += graphItemBytes(archive) + graphItemBytes({ source: session, target: archive.id, type: 'HAS_REVISION' });
    if (!sessions.has(session)) {
      budget += graphItemBytes({ id: session, type: 'session', label: descriptor.sessionId, sessionId: descriptor.sessionId, agent: 'claude' })
        + graphItemBytes({ source: project, target: session, type: 'HAS_SESSION' });
      sessions.add(session);
    }
    // Stop while the index is still bounded, before fetching the next manifest.
    if (budget > maxBytes) throw new Error('Archive graph metadata exceeds the local cache limit');
    archives.push(archive);
  }
  const graph = assembleGraph(context, archives, generatedAt);
  validateGraph(context, graph);
  return graph;
}

function isDate(value) {
  return typeof value === 'string' && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value) && Number.isFinite(Date.parse(value));
}

function validateGraph(context, graph) {
  const s = scope(context);
  if (!graph || graph.version !== 1 || graph.store !== s.store || graph.projectId !== s.projectId || !isDate(graph.generatedAt)
    || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > MAX_ARCHIVES * 2 + 1 || graph.edges.length > MAX_ARCHIVES * 2) throw new Error('Invalid local archive graph; refresh the graph to rebuild its metadata');
  const archives = graph.nodes.filter(n => n?.type === 'archive');
  const seen = new Set();
  for (const n of archives) {
    const descriptor = descriptorFor(context, n.descriptor);
    if (n.id !== nodeId(context, descriptor.sessionId, descriptor.revision) || seen.has(n.id)
      || n.sessionId !== descriptor.sessionId || n.revision !== descriptor.revision || n.agent !== 'claude' || n.label !== `Claude archive ${n.sessionId}`
      || !isDate(n.createdAt) || !Number.isSafeInteger(n.bytes) || n.bytes < 0 || !Number.isSafeInteger(n.files) || n.files < 1 || n.files > 100000
      || !Array.isArray(n.filePaths) || n.filePaths.length !== Math.min(n.files, MAX_PATHS) || n.pathsTruncated !== (n.files > MAX_PATHS)) throw new Error('Invalid local archive graph revision');
    seen.add(n.id);
    const names = new Set();
    for (const name of n.filePaths) {
      require('./archive').targetPath(name, context, n.sessionId);
      if (names.has(name.toLowerCase())) throw new Error('Duplicate local archive graph file path');
      names.add(name.toLowerCase());
    }
    if (JSON.stringify(n.filePaths) !== JSON.stringify([...n.filePaths].sort())) throw new Error('Unordered local archive graph file paths');
    // Unknown fields are not copied into the canonical representation below.
    const expected = { id: n.id, type: 'archive', agent: 'claude', label: n.label, sessionId: n.sessionId, revision: n.revision,
      createdAt: n.createdAt, bytes: n.bytes, files: n.files, filePaths: n.filePaths, pathsTruncated: n.pathsTruncated, descriptor };
    if (!sameValue(n, expected)) throw new Error('Unexpected local archive graph metadata');
  }
  if (!sameValue(graph, assembleGraph(context, archives, graph.generatedAt))) throw new Error('Invalid local archive graph nodes or relationships');
  if (Buffer.byteLength(JSON.stringify(graph, null, 2) + '\n') > MAX_GRAPH_BYTES) throw new Error('Archive graph metadata exceeds the local cache limit');
  return graph;
}

// Object property order is immaterial; array order is part of the deterministic graph.
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}

function readGraph(context) {
  const file = graphPath(context);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GRAPH_BYTES) throw new Error('Invalid local archive graph cache file');
  let graph;
  try { graph = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid local archive graph JSON; refresh the graph to rebuild its metadata'); }
  return validateGraph(context, graph);
}

function writeGraph(context, graph) {
  validateGraph(context, graph);
  const file = graphPath(context);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  require('./sync').atomicWrite(file, JSON.stringify(graph, null, 2) + '\n');
  fs.chmodSync(file, 0o600);
  return graph;
}

// Queries are literal, case-insensitive metadata searches, not semantic extraction.
function queryGraph(graph, query = '') {
  if (typeof query !== 'string' || query.length > 4096) throw new Error('Invalid archive graph query');
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return graph.nodes.filter(n => n.type === 'archive').filter(n => {
    const text = [graph.projectId, n.id, n.label, n.sessionId, n.revision, n.createdAt, ...n.filePaths].join('\n').toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.revision.localeCompare(b.revision));
}

function resolveNode(context, backend, reference, options = {}) {
  if (typeof reference !== 'string' || (!NODE_ID.test(reference) && !SESSION_ID.test(reference))
    || (options.revision !== undefined && !HASH.test(options.revision))) throw new Error('Invalid archive node reference or revision');
  let graph = readGraph(context), refreshed = false;
  // A bare session ID means its latest cloud revision. Only an immutable node ID
  // can intentionally resolve an older revision from cached metadata.
  if (!graph || !NODE_ID.test(reference)) {
    graph = writeGraph(context, buildGraph(context, backend));
    refreshed = true;
  }
  const find = () => queryGraph(graph).find(n => NODE_ID.test(reference) ? n.id === reference
    : n.sessionId === reference && (options.revision === undefined || n.revision === options.revision));
  let node = find();
  // Refresh once when a supplied reference is newer than this machine's index. A
  // known pinned node remains usable even when later revisions have been archived.
  if (!node && !refreshed) {
    graph = writeGraph(context, buildGraph(context, backend));
    node = find();
  }
  if (!node) throw new Error('No matching archive node for this project and memory repository');
  if (options.revision !== undefined && node.revision !== options.revision) throw new Error('Revision option conflicts with the pinned archive node');
  const descriptor = descriptorFor(context, node.descriptor);
  const manifest = readVerifiedManifest(context, backend, descriptor);
  // A cached timestamp/label/size is not trusted to stand in for cloud evidence.
  if (!sameValue(node, archiveNode(context, descriptor, manifest))) throw new Error('Archive graph metadata differs from its verified cloud manifest; refresh the graph');
  return { descriptor, manifest, nodeId: node.id };
}

module.exports = { nodeId, buildGraph, readGraph, writeGraph, queryGraph, resolveNode, graphPath, validateGraph, NODE_ID };
