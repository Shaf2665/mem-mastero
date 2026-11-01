// Durable project knowledge: immutable records and sticky, content-free tombstones.
// The local index is derived from these files; no database or service is required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digest, safePath } = require('./archive-state');
const KINDS = new Set(['decision', 'bugfix', 'discovery', 'preference', 'constraint', 'progress', 'summary', 'observation']);
const PROVENANCE = new Set(['manual', 'captured', 'imported']);
const ID = /^memory:[a-f0-9]{64}$/;
const FILE = /^[a-f0-9]{64}\.json$/;
const MAX_RECORDS = 10000;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 24 * 1024;
const MAX_COLLECTION_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_BYTES = MAX_COLLECTION_BYTES + 1024 * 1024;

function scope(context) {
  if (!context || typeof context.memRoot !== 'string' || !context.memRoot || typeof context.projectId !== 'string'
    || !context.projectId || context.projectId.length > 4096 || /[\x00-\x1f\x7f]/.test(context.projectId)) throw new Error('Invalid memory context');
  const store = context.store;
  let storeId, localStore;
  if (store && typeof store.github === 'string' && store.github && store.dir === undefined) {
    storeId = require('./sync').normalizeRemote(store.github);
    if (!storeId || storeId.length > 4096 || /[\x00-\x1f\x7f]/.test(storeId)) throw new Error('Invalid memory repository');
    localStore = storeId;
  } else if (store && typeof store.dir === 'string' && store.dir && store.github === undefined) {
    storeId = 'folder';
    localStore = path.resolve(store.dir);
    if (process.platform === 'win32') localStore = localStore.toLowerCase();
  } else throw new Error('Memory needs a configured Git repository or resolved sync folder');
  return { projectId: context.projectId, storeId, key: digest(JSON.stringify([localStore, context.projectId])) };
}

function memoryPath(context) { return safePath(context.memRoot, path.join('knowledge', scope(context).key)); }
function lock(context, fn) {
  const dir = safePath(context.memRoot, 'locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let result;
  if (!require('./sync').withLock(dir, () => { result = fn(); }, path.join(dir, 'memory-' + scope(context).key + '.lock'))) throw new Error('Another memory operation is running; retry later');
  return result;
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return object(value) && Object.keys(value).every(k => keys.includes(k)); }
function normalizedText(value, max, label, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > max * 4) throw new Error(`Invalid memory ${label}`);
  const clean = require('./memory-privacy').redactText(value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')).trim();
  if (Buffer.byteLength(clean) > max) throw new Error(`Memory ${label} exceeds its size limit`);
  return clean;
}
function date(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid memory timestamp');
  return new Date(value).toISOString();
}
function sourceOf(value, provenance) {
  if (value === undefined) value = { agent: provenance === 'manual' ? 'manual' : 'unknown' };
  if (!exactKeys(value, ['agent', 'sessionId', 'eventId', 'archiveNode'])) throw new Error('Invalid memory source');
  if (typeof value.agent !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.agent)) throw new Error('Invalid memory source agent');
  const source = { agent: value.agent };
  for (const key of ['sessionId', 'eventId']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value[key])) throw new Error('Invalid memory source identity');
    source[key] = value[key];
  }
  if (value.archiveNode !== undefined) {
    if (typeof value.archiveNode !== 'string' || !/^archive:[a-f0-9]{64}$/.test(value.archiveNode)) throw new Error('Invalid archive memory reference');
    source.archiveNode = value.archiveNode;
  }
  return source;
}

function payload(context, input, { stored = false } = {}) {
  const s = scope(context);
  if (!exactKeys(input, stored ? ['version', 'id', 'projectId', 'storeId', 'kind', 'title', 'text', 'tags', 'source', 'provenance', 'createdAt', 'nonce']
    : ['kind', 'title', 'text', 'tags', 'source', 'provenance', 'createdAt'])) throw new Error('Unexpected memory fields');
  const provenance = input.provenance || 'manual';
  const kind = input.kind || 'observation';
  if (!PROVENANCE.has(provenance) || !KINDS.has(kind)) throw new Error('Invalid memory kind or provenance');
  const text = normalizedText(input.text, MAX_TEXT_BYTES, 'text');
  if (!text || /^\[REDACTED(?:[^\]]*)\]$/i.test(text)) throw new Error('Memory text is empty after privacy filtering');
  const title = normalizedText(input.title, 512, 'title', true) || text.split('\n')[0].slice(0, 160);
  if (title.includes('\n')) throw new Error('Memory title must be one line');
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 32)) throw new Error('Invalid memory tags');
  const tags = [...new Set((input.tags || []).map(tag => normalizedText(tag, 128, 'tag').toLowerCase()).filter(Boolean))].sort();
  if (tags.some(tag => /\s/.test(tag))) throw new Error('Memory tags must not contain whitespace');
  const source = sourceOf(input.source, provenance);
  const createdAt = date(input.createdAt, provenance === 'manual' ? new Date().toISOString() : '1970-01-01T00:00:00.000Z');
  const result = { version: 1, projectId: s.projectId, storeId: s.storeId, kind, title, text, tags, source, provenance, createdAt };
  if (provenance === 'manual') {
    const nonce = stored ? input.nonce : crypto.randomUUID();
    if (typeof nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(nonce)) throw new Error('Invalid memory note identity');
    result.nonce = nonce;
  } else if (input.nonce !== undefined) throw new Error('Unexpected memory note identity');
  return result;
}

function recordFor(context, input) {
  const body = payload(context, input), record = { ...body, id: 'memory:' + digest(JSON.stringify(body)) };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new Error('Memory record exceeds its size limit');
  return record;
}
function canonicalRecord(context, record) {
  if (!object(record) || record.version !== 1 || !ID.test(record.id || '')) throw new Error('Invalid memory record');
  const body = payload(context, record, { stored: true });
  const expected = { ...body, id: 'memory:' + digest(JSON.stringify(body)) };
  if (!sameValue(record, expected)) throw new Error('Memory record hash, privacy filtering, or scope mismatch');
  return expected;
}
function tombstoneFor(context, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid memory ID');
  const s = scope(context);
  return { version: 1, id, projectId: s.projectId, storeId: s.storeId };
}
function canonicalTombstone(context, value) {
  if (!object(value) || !sameValue(value, tombstoneFor(context, value.id))) throw new Error('Invalid memory tombstone or scope');
  return tombstoneFor(context, value.id);
}
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}
function bytes(value) { return Buffer.from(JSON.stringify(value) + '\n'); }

function readCollection(context, root) {
  safePath(root);
  const result = { records: new Map(), tombstones: new Map(), bytes: 0 };
  for (const kind of ['records', 'tombstones']) {
    const dir = safePath(root, kind);
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (names.length > MAX_RECORDS) throw new Error('Memory collection exceeds its record limit');
    for (const name of names.sort()) {
      // atomicWrite publishes only after a complete temporary file is ready.
      // Another reader (or a Drive peer) may see that in-progress private name;
      // it is never an active record and must not make reads intermittently fail.
      if (/^\.mem-mastero-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name)) continue;
      if (!FILE.test(name)) throw new Error('Unrecognized memory collection file');
      const file = safePath(dir, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) throw new Error('Invalid memory collection entry');
      result.bytes += stat.size;
      if (result.bytes > MAX_COLLECTION_BYTES) throw new Error('Memory collection exceeds its byte limit');
      let value;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid memory collection JSON'); }
      const record = kind === 'records' ? canonicalRecord(context, value) : canonicalTombstone(context, value);
      if (name !== record.id.slice(7) + '.json') throw new Error('Memory filename does not match its record');
      result[kind].set(record.id, record);
    }
  }
  return result;
}
function combine(a, b) {
  const result = { records: new Map(a.records), tombstones: new Map(a.tombstones) };
  for (const kind of ['tombstones', 'records']) for (const [id, value] of b[kind]) {
    if (result[kind].has(id) && !sameValue(result[kind].get(id), value)) throw new Error('Conflicting immutable memory record');
    result[kind].set(id, value);
  }
  let total = 0;
  for (const kind of ['tombstones', 'records']) {
    if (result[kind].size > MAX_RECORDS) throw new Error('Memory collection exceeds its record limit');
    for (const value of result[kind].values()) total += bytes(value).length;
  }
  if (total > MAX_COLLECTION_BYTES) throw new Error('Memory collection exceeds its byte limit');
  return result;
}
function publish(context, root, kind, value) {
  const dir = safePath(root, kind), file = safePath(dir, value.id.slice(7) + '.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) throw new Error('Invalid memory target');
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    const checked = kind === 'records' ? canonicalRecord(context, existing) : canonicalTombstone(context, existing);
    if (!sameValue(checked, value)) throw new Error('Conflicting immutable memory target');
    return false;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Publish complete bytes atomically; repeated legitimate writers have identical
  // content-addressed records and identical content-free tombstones.
  require('./sync').atomicWrite(safePath(dir, path.basename(file)), bytes(value));
  return true;
}
function active(collection) { return [...collection.records.values()].filter(r => !collection.tombstones.has(r.id)); }
function byTime(a, b) { return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }

function addMemories(context, inputs) {
  if (!Array.isArray(inputs) || inputs.length > MAX_RECORDS) throw new Error('Invalid or oversized memory batch');
  // Normalize the entire batch before acquiring a write lock or publishing any
  // record. Hooks can save several observations with one collection scan.
  scope(context);
  const records = Array.from(inputs, input => recordFor(context, input));
  if (!records.length) return [];
  return lock(context, () => {
    const root = memoryPath(context), local = readCollection(context, root);
    const incoming = new Map(records.filter(record => !local.tombstones.has(record.id)).map(record => [record.id, record]));
    combine(local, { records: incoming, tombstones: new Map() });
    for (const record of incoming.values()) publish(context, root, 'records', record);
    return records.map(record => local.tombstones.has(record.id) ? { ...record, forgotten: true } : record);
  });
}
function addMemory(context, input) { return addMemories(context, [input])[0]; }
function listMemories(context) { return active(readCollection(context, memoryPath(context))).sort(byTime); }
function getMemories(context, ids) {
  if (!Array.isArray(ids) || ids.length > 100) throw new Error('Memory lookup requires at most 100 IDs');
  const checked = Array.from(ids, id => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid memory ID');
    return id;
  });
  scope(context);
  if (!checked.length) return [];
  const local = readCollection(context, memoryPath(context));
  return checked.map(id => local.tombstones.has(id) ? null : local.records.get(id) || null);
}
function getMemory(context, id) { return getMemories(context, [id])[0]; }
function forgetMemory(context, id) {
  const tombstone = tombstoneFor(context, id);
  return lock(context, () => {
    const root = memoryPath(context), local = readCollection(context, root);
    if (!local.records.has(id) && !local.tombstones.has(id)) throw new Error('Memory not found in this project');
    publish(context, root, 'tombstones', tombstone);
    return { id, forgotten: true };
  });
}

function limitOf(value, fallback = 10) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Memory result limit must be between 1 and 100');
  return value;
}
function compact(record, score) {
  return { id: record.id, kind: record.kind, title: record.title, createdAt: record.createdAt, source: record.source,
    provenance: record.provenance, excerpt: record.text.slice(0, 240), ...(score === undefined ? {} : { score }) };
}
function words(text) { return text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) || []; }
function searchMemories(context, query, options = {}) {
  if (typeof query !== 'string' || query.length > 4096) throw new Error('Invalid memory query');
  const limit = limitOf(options.limit), terms = [...new Set(words(query))].slice(0, 128);
  if (options.kind !== undefined && !KINDS.has(options.kind)) throw new Error('Invalid memory kind filter');
  const from = options.from === undefined ? null : date(options.from), to = options.to === undefined ? null : date(options.to);
  if (from && to && from > to) throw new Error('Memory date range ends before it starts');
  const candidates = listMemories(context).filter(r => (!options.kind || r.kind === options.kind) && (!options.agent || r.source.agent === options.agent)
    && (!from || r.createdAt >= from) && (!to || r.createdAt <= to));
  const ranked = candidates.map(r => {
    const title = new Set(words(r.title)), tags = new Set(r.tags.flatMap(words)), body = words(r.text), counts = new Map();
    for (const word of body) counts.set(word, (counts.get(word) || 0) + 1);
    let score = 0, matched = 0;
    for (const term of terms) {
      const n = counts.get(term) || 0, weight = (title.has(term) ? 5 : 0) + (tags.has(term) ? 4 : 0) + Math.min(n, 4);
      if (weight) { score += weight; matched++; }
    }
    if (terms.length && matched === terms.length) score += 10;
    return { record: r, score, matched };
  }).filter(r => !terms.length || r.matched > 0).sort((a, b) => b.score - a.score || byTime(b.record, a.record));
  return ranked.slice(0, limit).map(r => compact(r.record, r.score));
}
function timelineMemories(context, options = {}) {
  const limit = limitOf(options.limit), records = listMemories(context);
  if (!options.id) return records.slice(-limit).map(r => compact(r));
  if (!ID.test(options.id)) throw new Error('Invalid memory ID');
  const anchor = records.findIndex(r => r.id === options.id);
  if (anchor < 0) throw new Error('Timeline anchor is not active in this project');
  let start = Math.max(0, anchor - Math.floor((limit - 1) / 2));
  start = Math.max(0, Math.min(start, records.length - limit));
  return records.slice(start, start + limit).map(r => compact(r));
}

function exportMemories(context) {
  const local = readCollection(context, memoryPath(context)), s = scope(context);
  const exported = { version: 1, projectId: s.projectId, storeId: s.storeId, records: active(local).sort(byTime), tombstones: [...local.tombstones.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  if (Buffer.byteLength(JSON.stringify(exported)) > MAX_EXPORT_BYTES) throw new Error('Memory export exceeds its size limit');
  return exported;
}
function importMemories(context, data) {
  const s = scope(context);
  if (!exactKeys(data, ['version', 'projectId', 'storeId', 'records', 'tombstones']) || data.version !== 1 || data.projectId !== s.projectId || data.storeId !== s.storeId
    || !Array.isArray(data.records) || !Array.isArray(data.tombstones) || data.records.length > MAX_RECORDS || data.tombstones.length > MAX_RECORDS
    || Buffer.byteLength(JSON.stringify(data)) > MAX_EXPORT_BYTES) throw new Error('Invalid memory export or project/store mismatch');
  const incoming = { records: new Map(), tombstones: new Map() };
  for (const [kind, validate] of [['records', canonicalRecord], ['tombstones', canonicalTombstone]]) for (const value of data[kind]) {
    const checked = validate(context, value);
    if (incoming[kind].has(checked.id)) throw new Error('Duplicate imported memory ID');
    incoming[kind].set(checked.id, checked);
  }
  return lock(context, () => {
    const root = memoryPath(context), local = readCollection(context, root);
    combine(local, incoming);
    let imported = 0, forgotten = 0;
    for (const value of incoming.tombstones.values()) if (publish(context, root, 'tombstones', value)) forgotten++;
    for (const value of incoming.records.values()) if (publish(context, root, 'records', value)) imported++;
    return { imported, forgotten };
  });
}

function syncMemories(context, remoteDir, { mode = 'both' } = {}) {
  if (!['both', 'push', 'pull'].includes(mode) || typeof remoteDir !== 'string' || !path.isAbsolute(remoteDir)) throw new Error('Invalid memory sync target or mode');
  return lock(context, () => {
    const root = memoryPath(context), remote = safePath(remoteDir);
    if (path.resolve(root) === path.resolve(remote)) throw new Error('Memory sync target must differ from the local knowledge directory');
    const local = readCollection(context, root), cloud = readCollection(context, remote), merged = combine(local, cloud);
    let pushed = 0, pulled = 0;
    // Tombstones precede records on both sides, so stale peers cannot resurrect a
    // forgotten fact in active search/context even after an interrupted sync.
    for (const kind of ['tombstones', 'records']) {
      if (mode !== 'pull') for (const value of local[kind].values()) if (publish(context, remote, kind, value)) pushed++;
      if (mode !== 'push') for (const value of cloud[kind].values()) if (publish(context, root, kind, value)) pulled++;
    }
    return { pushed, pulled, records: active(merged).length, forgotten: merged.tombstones.size };
  });
}

module.exports = { addMemory, addMemories, listMemories, getMemory, getMemories, searchMemories, timelineMemories, forgetMemory, exportMemories, importMemories, syncMemories,
  previewMemory: recordFor, memoryPath, scope, KINDS, MAX_RECORDS, MAX_TEXT_BYTES, MAX_EXPORT_BYTES };
