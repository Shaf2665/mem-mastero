const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const memory = require('./memory-store');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-knowledge-store-')));
const context = (name, store = { github: 'https://github.com/example/private-memory.git' }, projectId = 'github.com/example/project') => ({ memRoot: path.join(root, name), store, projectId });
const A = context('A'), B = context('B');
const remote = path.join(root, 'remote', 'project');
const observation = (text, extra = {}) => ({ kind: 'observation', title: 'Captured finding', text, tags: ['architecture'],
  provenance: 'captured', source: { agent: 'claude', sessionId: 'session-1', eventId: 'event-1' }, createdAt: '2026-10-01T12:00:00Z', ...extra });
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const recordPath = (c, id) => path.join(memory.memoryPath(c), 'records', id.slice(7) + '.json');

try {
  assert.deepEqual(memory.listMemories(A), []);
  const note = memory.addMemory(A, observation('Use a bounded queue for background operations.'));
  assert.match(note.id, /^memory:[a-f0-9]{64}$/);
  assert.equal(note.createdAt, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(memory.previewMemory(A, observation(note.text)), note);
  assert.deepEqual(memory.addMemory(A, observation(note.text)), note, 'captured replay deduplicates');
  assert.equal(memory.listMemories(A).length, 1);
  assert.deepEqual(memory.getMemory(A, note.id), note);
  const batchContext = context('batch');
  assert.deepEqual(memory.addMemories(batchContext, []), []);
  assert(!fs.existsSync(memory.memoryPath(batchContext)), 'an empty batch publishes nothing');
  assert.throws(() => memory.addMemories(batchContext, [observation('Valid first row'), { text: '<private>private second row</private>' }]), /empty after privacy/);
  assert(!fs.existsSync(memory.memoryPath(batchContext)), 'validate every input before publishing the first record');
  assert.throws(() => memory.addMemories(batchContext, {}), /batch/);
  assert.throws(() => memory.addMemories(batchContext, Array(2)), /Unexpected memory fields/);
  assert.throws(() => memory.addMemories(batchContext, Array(memory.MAX_RECORDS + 1)), /batch/);
  const repeatedInput = observation('Repeated batch row');
  const batch = memory.addMemories(batchContext, [repeatedInput, repeatedInput, { text: 'Intentional manual row' }, { text: 'Intentional manual row' }]);
  assert.equal(batch.length, 4);
  assert.equal(batch[0].id, batch[1].id, 'stable duplicates produce corresponding ordered results');
  assert.notEqual(batch[2].id, batch[3].id, 'manual additions retain independent identities inside a batch');
  assert.equal(memory.listMemories(batchContext).length, 3);
  memory.forgetMemory(batchContext, batch[0].id);
  const replayBatch = memory.addMemories(batchContext, [repeatedInput, observation('A new active row')]);
  assert.equal(replayBatch[0].forgotten, true);
  assert.equal(replayBatch[1].forgotten, undefined);
  assert.equal(memory.getMemory(batchContext, batch[0].id), null, 'batch replay respects sticky tombstones');
  // Regression for hook latency: adding many observations must not re-read the
  // growing collection once for each observation.
  const bulkContext = context('batch-scan');
  memory.addMemories(bulkContext, Array.from({ length: 30 }, (_, i) => observation('Existing observation ' + i)));
  const bulkDir = path.join(memory.memoryPath(bulkContext), 'records'), realRead = fs.readFileSync;
  let collectionReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (typeof file === 'string' && path.dirname(file) === bulkDir) collectionReads++;
    return realRead(file, ...args);
  };
  try { memory.addMemories(bulkContext, Array.from({ length: 20 }, (_, i) => observation('New observation ' + i))); }
  finally { fs.readFileSync = realRead; }
  assert.equal(collectionReads, 30, 'a batch validates existing records only once');
  assert.equal(memory.listMemories(bulkContext).length, 50);
  const wanted = memory.listMemories(bulkContext).slice(0, 20).map(record => record.id);
  collectionReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (typeof file === 'string' && path.dirname(file) === bulkDir) collectionReads++;
    return realRead(file, ...args);
  };
  let selected;
  try { selected = memory.getMemories(bulkContext, wanted); }
  finally { fs.readFileSync = realRead; }
  assert.deepEqual(selected.map(record => record.id), wanted, 'bulk lookup preserves the requested order');
  assert.equal(collectionReads, 50, 'twenty selected memories require only one collection scan');
  assert.deepEqual(memory.getMemories(batchContext, [batch[0].id, batch[2].id, 'memory:' + 'f'.repeat(64), batch[2].id]), [null, batch[2], null, batch[2]],
    'lookup distinguishes active notes from forgotten and unknown IDs without dropping positions');
  assert.deepEqual(memory.getMemories(batchContext, []), []);
  assert.throws(() => memory.getMemories(batchContext, Array(101).fill(batch[2].id)), /at most 100/);
  assert.throws(() => memory.getMemories(batchContext, Array(2)), /Invalid memory ID/);
  assert.throws(() => memory.getMemories(batchContext, [batch[2].id, '../escape']), /Invalid memory ID/);
  const defaultTime = memory.addMemory(A, observation('No event clock', { createdAt: undefined, source: { agent: 'codex', sessionId: 's-2' } }));
  assert.equal(defaultTime.createdAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(memory.addMemory(A, observation(defaultTime.text, { createdAt: undefined, source: { agent: 'codex', sessionId: 's-2' } })), defaultTime);
  const manual = memory.addMemory(A, { kind: 'decision', title: 'Queue architecture', text: 'Use a durable queue.', tags: ['Queue', 'queue'], source: { agent: 'manual' } });
  const anotherManual = memory.addMemory(A, { kind: 'decision', title: 'Queue architecture', text: 'Use a durable queue.', tags: ['queue'] });
  assert.notEqual(manual.id, anotherManual.id, 'explicit repeated notes have independent identities');
  assert.deepEqual(manual.tags, ['queue']);
  assert([manual.id, anotherManual.id].includes(memory.searchMemories(A, 'queue architecture')[0].id), 'title/tag matches outrank a body-only match');
  const ranked = memory.searchMemories(A, 'queue architecture', { kind: 'decision' });
  assert.equal(ranked.length, 2); assert(ranked[0].score > 0);
  assert(!Object.hasOwn(ranked[0], 'text'), 'search uses compact excerpts, not full records');
  assert.equal(memory.searchMemories(A, 'background', { agent: 'claude', from: '2026-01-01', to: '2026-12-31' })[0].id, note.id);
  assert.deepEqual(memory.searchMemories(A, 'unfindable'), []);
  const long = memory.addMemory(A, observation('word '.repeat(500) + 'tailneedle', { title: 'Long observation', source: { agent: 'claude', sessionId: 's-3' } }));
  assert.equal(memory.searchMemories(A, 'tailneedle')[0].id, long.id, 'all bounded note text is searchable');
  const timeline = memory.timelineMemories(A, { id: note.id, limit: 3 });
  assert.equal(timeline.length, 3); assert(timeline.some(r => r.id === note.id));
  assert(timeline.every((r, i) => !i || timeline[i - 1].createdAt <= r.createdAt));
  assert.throws(() => memory.searchMemories(A, 'x', { limit: 101 }), /limit/);
  assert.throws(() => memory.searchMemories(A, 'x', { kind: 'unknown' }), /kind/);
  assert.throws(() => memory.searchMemories(A, 'x', { from: '2027-01-01', to: '2026-01-01' }), /date range/);
  assert.throws(() => memory.timelineMemories(A, { id: 'memory:' + 'f'.repeat(64) }), /not active/);
  assert.throws(() => memory.getMemory(A, '../escape'), /Invalid memory ID/);
  assert.throws(() => memory.addMemory(A, { text: 'x', surprise: true }), /Unexpected memory fields/);
  assert.throws(() => memory.addMemory(A, { text: 'x', source: { agent: 'manual', file: '/secret' } }), /source/);
  assert.throws(() => memory.addMemory(A, { text: 'x'.repeat(memory.MAX_TEXT_BYTES + 1) }), /size limit/);
  assert.throws(() => memory.addMemory(A, { text: '<private>Never save me</private>' }), /empty after privacy/);
  const filtered = memory.addMemory(A, { title: 'Authentication setup', text: 'Keep this. <private>private-value</private> password=unsafe-value token ghp_abcdefghijklmnopqrstuvwxyz1234567890' });
  assert(!JSON.stringify(filtered).includes('private-value')); assert(!filtered.text.includes('unsafe-value')); assert(!filtered.text.includes('ghp_'));
  assert(filtered.text.includes('[REDACTED]'));
  const beforeConcurrent = memory.listMemories(A).length, realRename = fs.renameSync;
  let observedPending = false;
  fs.renameSync = (source, target, ...args) => {
    if (path.dirname(String(target)) === path.join(memory.memoryPath(A), 'records')) {
      observedPending = true;
      assert.equal(memory.listMemories(A).length, beforeConcurrent, 'readers ignore a recognized in-progress atomic-write temporary file');
    }
    return realRename(source, target, ...args);
  };
  try { memory.addMemory(A, observation('Concurrent publication remains a complete record.', { source: { agent: 'codex', sessionId: 'concurrent' } })); }
  finally { fs.renameSync = realRename; }
  assert(observedPending);
  if (process.platform !== 'win32') assert.equal(fs.statSync(recordPath(A, note.id)).mode & 0o777, 0o600);

  assert.equal(memory.syncMemories(A, remote, { mode: 'push' }).pushed, memory.listMemories(A).length);
  assert(memory.syncMemories(B, remote, { mode: 'pull' }).pulled > 0);
  assert.deepEqual(memory.listMemories(B), memory.listMemories(A));
  const untouchedB = memory.exportMemories(B);
  assert.equal(memory.syncMemories(B, remote).pushed, 0);
  memory.forgetMemory(A, note.id);
  assert.equal(memory.getMemory(A, note.id), null);
  assert.equal(memory.addMemory(A, observation(note.text)).forgotten, true, 'capture replay cannot resurrect a forgotten note');
  assert.equal(memory.searchMemories(A, 'background').length, 0);
  assert.equal(memory.exportMemories(A).records.some(r => r.id === note.id), false, 'exports omit forgotten content');
  assert.equal(memory.exportMemories(A).tombstones.length, 1);
  memory.syncMemories(A, remote);
  memory.syncMemories(B, remote);
  assert.equal(memory.getMemory(B, note.id), null, 'remote tombstones dominate stale peer records');
  const C = context('C'); memory.syncMemories(C, remote);
  assert.equal(memory.getMemory(C, note.id), null, 'a fresh machine also honors tombstones');
  memory.importMemories(A, untouchedB);
  assert.equal(memory.getMemory(A, note.id), null, 'stale exports cannot resurrect forgotten memory');
  assert.throws(() => memory.forgetMemory(A, 'memory:' + 'f'.repeat(64)), /not found/);
  const transferred = memory.exportMemories(A), D = context('D');
  assert(memory.importMemories(D, transferred).imported > 0);
  assert.deepEqual(memory.listMemories(D), memory.listMemories(A));
  assert.equal(memory.importMemories(D, transferred).imported, 0, 'import replay is idempotent');
  assert.throws(() => memory.importMemories(context('wrong-project', A.store, 'github.com/other/project'), transferred), /mismatch/);
  assert.throws(() => memory.importMemories(context('wrong-store', { github: 'https://github.com/other/memory.git' }), transferred), /mismatch/);
  const corrupt = structuredClone(transferred); corrupt.records[0].text += ' tampered';
  assert.throws(() => memory.importMemories(context('invalid-import'), corrupt), /hash|privacy|scope/);
  assert(!fs.existsSync(memory.memoryPath(context('invalid-import'))), 'invalid imports do not write partial records');
  const duplicate = structuredClone(transferred); duplicate.records.push(duplicate.records[0]);
  assert.throws(() => memory.importMemories(A, duplicate), /Duplicate imported/);

  // Folder records are portable while local caches stay separated by physical store.
  const FA = context('folder-A', { dir: path.join(root, 'drive-A') }), FB = context('folder-B', { dir: path.join(root, 'drive-B') });
  const folderNote = memory.addMemory(FA, observation('Folder-backed portable knowledge.'));
  assert.equal(folderNote.storeId, 'folder');
  assert(!JSON.stringify(folderNote).includes('drive-A'));
  assert.notEqual(memory.scope(FA).key, memory.scope(FB).key);
  memory.importMemories(FB, memory.exportMemories(FA));
  assert.equal(memory.getMemory(FB, folderNote.id).id, folderNote.id);
  assert.notEqual(memory.memoryPath({ ...FA, store: FB.store }), memory.memoryPath(FA), 'two stores in one local home remain isolated');
  assert.throws(() => memory.addMemory({ ...A, store: {} }, observation('missing target')), /configured/);

  // Validate whole remote input before publishing any new local records.
  const badRemote = path.join(root, 'bad-remote'); fs.cpSync(remote, badRemote, { recursive: true });
  const corruptPath = path.join(badRemote, 'records', manual.id.slice(7) + '.json');
  const changed = JSON.parse(fs.readFileSync(corruptPath, 'utf8')); changed.title = 'Unexpected edited record'; put(corruptPath, changed);
  const emptyPeer = context('clean-peer');
  assert.throws(() => memory.syncMemories(emptyPeer, badRemote), /hash|privacy|scope/);
  assert(!fs.existsSync(memory.memoryPath(emptyPeer)), 'corrupt sync cannot partly populate local knowledge');
  assert.throws(() => memory.syncMemories(context('wrong-remote', { github: 'https://github.com/other/store' }), remote), /scope/);
  const badLocal = context('bad-local'); memory.importMemories(badLocal, transferred);
  put(recordPath(badLocal, transferred.records[0].id), '{broken');
  assert.throws(() => memory.listMemories(badLocal), /Invalid memory collection JSON/);
  assert.throws(() => memory.syncMemories(badLocal, path.join(root, 'clean-remote')), /Invalid memory collection JSON/);
  assert(!fs.existsSync(path.join(root, 'clean-remote')));

  const linked = context('linked'), outside = path.join(root, 'outside');
  fs.mkdirSync(outside); put(path.join(outside, 'preserve.txt'), 'untouched');
  fs.mkdirSync(path.dirname(memory.memoryPath(linked)), { recursive: true });
  fs.symlinkSync(outside, memory.memoryPath(linked), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => memory.addMemory(linked, observation('unsafe')), /symbolic link/);
  assert.throws(() => memory.listMemories(linked), /symbolic link/);
  const linkedRemote = path.join(root, 'linked-remote');
  fs.symlinkSync(outside, linkedRemote, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => memory.syncMemories(A, linkedRemote), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'preserve.txt'), 'utf8'), 'untouched');
  const hardlinked = context('hardlinked'); memory.importMemories(hardlinked, transferred);
  const original = recordPath(hardlinked, transferred.records[0].id);
  fs.linkSync(original, path.join(root, 'record-hardlink.json'));
  assert.throws(() => memory.listMemories(hardlinked), /Invalid memory collection entry/);
  console.log('Durable memory store, search, sync, privacy, and forgetting tests passed.');
} finally {
  assert.equal(fs.realpathSync.native(root), root);
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(root).startsWith('mm-knowledge-store-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
