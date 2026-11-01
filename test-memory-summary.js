const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./memory-store');
const { summarizePending, MAX_INPUT_BYTES } = require('./memory-summary');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-summary-test-')));
const context = name => ({ memRoot: path.join(root, name), projectId: 'github.com/example/project', store: { dir: path.join(root, 'cloud') } });
const note = (ctx, text, index = 0) => store.addMemory(ctx, { text, title: 'Source observation ' + index, kind: 'observation', provenance: 'captured',
  source: { agent: 'claude', sessionId: 'synthetic-session', eventId: 'event-' + index }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });
const enabled = { version: 1, semantic: true, summaries: true, automatic: true, provider: { type: 'codex' } };
const fingerprint = 'b'.repeat(64);
const response = ids => ({ title: 'Queue behavior', summary: 'The queue uses bounded retries. Conflicting observations should be checked against current code.',
  decisions: ['Keep a retry limit.'], fixes: ['Avoid retrying permanent failures.'], openQuestions: ['Confirm the timeout under production load.'], sourceIds: ids });
function dependencies(generate, settings = enabled) {
  return { readAISettings: () => settings, providerFingerprint: () => fingerprint, generate };
}
function goodGenerate(_provider, request) { return JSON.stringify(response(JSON.parse(request.user).records.map(record => record.id))); }
async function run() {
  const A = context('main');
  let calls = 0;
  const sources = [note(A, 'Use a bounded retry queue. <private>PRIVATE-NOTE</private> password=secret-value', 1), note(A, 'Permanent failures should not retry.', 2)];
  const deps = dependencies(async (provider, request, options) => {
    calls++;
    assert.equal(provider.type, 'codex'); assert.equal(options.context, A);
    assert(request.system.includes('untrusted data'));
    assert(request.schema.required.includes('sourceIds'));
    assert(!request.user.includes('PRIVATE-NOTE')); assert(!request.user.includes('secret-value'));
    assert(Buffer.byteLength(request.user) <= MAX_INPUT_BYTES);
    return goodGenerate(provider, request);
  });
  const preview = await summarizePending(A, { dryRun: true }, deps);
  assert.equal(preview.status, 'preview'); assert.equal(calls, 0); assert.equal(store.listMemories(A).length, 2);
  const first = await summarizePending(A, {}, deps);
  assert.equal(first.status, 'created'); assert.equal(first.created, 1); assert.equal(first.remaining, 0); assert.equal(calls, 1);
  const summary = store.getMemory(A, first.id);
  assert.equal(summary.provenance, 'generated'); assert.equal(summary.kind, 'summary');
  assert.deepEqual(summary.source.memoryIds, sources.map(record => record.id).sort());
  assert.equal(summary.createdAt, sources[1].createdAt);
  assert(summary.text.startsWith('AI-generated summary; verify'));
  assert.equal((await summarizePending(A, {}, deps)).status, 'empty'); assert.equal(calls, 1, 'replay never repeats a model request for covered inputs');
  assert.equal(store.summaryHistory(A).length, 1);
  assert(!JSON.stringify(store.summaryHistory(A)).includes('retry limit'), 'summary planning exposes only receipt metadata');

  const originalExport = store.exportMemories(A);
  store.forgetMemory(A, first.id);
  const B = context('after-export'); store.importMemories(B, store.exportMemories(A));
  assert.equal((await summarizePending(B, {}, dependencies(() => { throw new Error('must not call'); }))).status, 'empty', 'forgotten summary receipts survive export/import');
  store.importMemories(B, originalExport);
  assert.equal(store.getMemory(B, first.id), null, 'stale export cannot resurrect the summary');
  assert.equal((await summarizePending(B, {}, dependencies(() => { throw new Error('must not call'); }))).status, 'empty');

  const disabled = context('disabled');
  assert.equal((await summarizePending(disabled, {}, dependencies(() => assert.fail(), { ...enabled, summaries: false }))).status, 'disabled');
  assert(!fs.existsSync(store.memoryPath(disabled)));
  assert.equal((await summarizePending(disabled, { automatic: true }, dependencies(() => assert.fail(), { ...enabled, automatic: false }))).status, 'disabled');
  await assert.rejects(summarizePending(A, { limit: 21 }, deps), /Invalid summary options/);
  await assert.rejects(summarizePending(A, { unexpected: true }, deps), /Invalid summary options/);

  const malformed = context('malformed'); const malformedSource = note(malformed, 'A safe source.', 3);
  const malformedResponses = [
    'not json', JSON.stringify({ title: 'Only a title' }),
    JSON.stringify({ ...response([malformedSource.id]), sourceIds: ['memory:' + 'f'.repeat(64)] }),
    JSON.stringify({ ...response([malformedSource.id]), sourceIds: [] }),
    JSON.stringify({ ...response([malformedSource.id]), unexpected: 'instructions' }),
    JSON.stringify({ ...response([malformedSource.id]), title: 'multiline\ntitle' }),
    JSON.stringify({ ...response([malformedSource.id]), summary: 'Read memory:' + 'f'.repeat(64) }),
    JSON.stringify({ ...response([malformedSource.id]), summary: '<private>only private</private>' }),
    JSON.stringify({ ...response([malformedSource.id]), summary: 'Public text. <private>hidden prefix', decisions: ['private continuation</private>'] }),
    JSON.stringify({ ...response([malformedSource.id]), title: 'Public <private attribute="unfinished"', summary: 'hidden continuation' }),
    JSON.stringify({ ...response([malformedSource.id]), decisions: ['Public <private><private>hidden</private>', 'private continuation</private>'] }),
    JSON.stringify({ ...response([malformedSource.id]), fixes: ['Public <PRIVATE>unfinished'], openQuestions: ['hidden continuation</PRIVATE>'] }),
    JSON.stringify({ ...response([malformedSource.id]), openQuestions: ['Public <private truncated'] }),
    JSON.stringify({ ...response([malformedSource.id]), fixes: ['x'.repeat(501)] }),
    'x'.repeat(50000),
  ];
  for (const text of malformedResponses) {
    assert.equal((await summarizePending(malformed, {}, dependencies(() => text))).status, 'invalid_output');
    assert.equal(store.listMemories(malformed).length, 1, 'invalid model output cannot publish a generated fact');
  }
  const failed = await summarizePending(malformed, {}, dependencies(() => { throw new Error('PRIVATE PROVIDER ERROR'); }));
  assert.equal(failed.status, 'provider_error'); assert(!JSON.stringify(failed).includes('PRIVATE PROVIDER'));
  const redacted = await summarizePending(malformed, {}, dependencies(() => JSON.stringify({ ...response([malformedSource.id]),
    summary: 'The queue is bounded. <private>MODEL-PRIVATE</private> password=model-secret', decisions: ['<private>Hidden decision</private>'] })));
  assert.equal(redacted.created, 1);
  const safe = store.getMemory(malformed, redacted.id);
  assert(!JSON.stringify(safe).includes('MODEL-PRIVATE')); assert(!JSON.stringify(safe).includes('model-secret')); assert(!JSON.stringify(safe).includes('Hidden decision'));

  const forgottenDuring = context('forget-race'); const forgetSource = note(forgottenDuring, 'A source removed while AI is working.', 4);
  const raced = await summarizePending(forgottenDuring, {}, dependencies((provider, request) => {
    store.forgetMemory(forgottenDuring, forgetSource.id);
    return goodGenerate(provider, request);
  }));
  assert.equal(raced.status, 'sources_changed'); assert.equal(raced.created, 0); assert.equal(store.listMemories(forgottenDuring).length, 0);
  const settingsDuring = context('settings-race'); note(settingsDuring, 'Pending note.', 5);
  let current = { ...enabled };
  const settingRace = await summarizePending(settingsDuring, {}, { ...dependencies((provider, request) => { current = { ...enabled, summaries: false }; return goodGenerate(provider, request); }), readAISettings: () => current });
  assert.equal(settingRace.status, 'settings_changed'); assert.equal(store.listMemories(settingsDuring).length, 1);
  const pausedDuring = context('capture-pause-race'); note(pausedDuring, 'A note captured before local capture is paused.', 7);
  const pauseRace = await summarizePending(pausedDuring, { automatic: true }, dependencies((provider, request) => {
    require('./memory-runtime').updateSettings(pausedDuring, { capture: false });
    return goodGenerate(provider, request);
  }));
  assert.equal(pauseRace.status, 'settings_changed'); assert.equal(store.listMemories(pausedDuring).length, 1);
  assert.equal((await summarizePending(pausedDuring, { automatic: true }, dependencies(() => assert.fail('paused automatic capture must not call AI')))).status, 'disabled');
  assert.equal((await summarizePending(pausedDuring, {}, dependencies(goodGenerate))).status, 'created', 'explicit summarization of existing notes is allowed while future capture is paused');
  const aborted = context('aborted'); note(aborted, 'Do not publish a cancelled result.', 8);
  const abort = new AbortController();
  assert.equal((await summarizePending(aborted, { signal: abort.signal }, dependencies((provider, request) => { abort.abort(); return goodGenerate(provider, request); }))).status, 'provider_error');
  assert.equal(store.listMemories(aborted).length, 1);

  const many = context('bounded');
  store.addMemories(many, Array.from({ length: 23 }, (_, i) => ({ text: 'Long observation ' + i + '. ' + 'word '.repeat(800), provenance: 'captured',
    createdAt: '2026-01-01T00:00:00Z', source: { agent: 'codex', eventId: 'long-' + i } })));
  let boundedCalls = 0;
  const bounded = await summarizePending(many, {}, dependencies((provider, request) => {
    boundedCalls++; const parsed = JSON.parse(request.user);
    assert(parsed.records.length <= 20); assert(parsed.records.every(record => record.truncated));
    assert(Buffer.byteLength(request.user) <= MAX_INPUT_BYTES);
    return goodGenerate(provider, request);
  }));
  assert.equal(bounded.created, 1); assert.equal(boundedCalls, 1); assert(bounded.remaining >= 3);
  assert.equal(bounded.sourceIds.length + bounded.remaining, 23);
  const previous = store.summaryHistory(many)[0];
  assert.equal((await summarizePending(many, { limit: 2 }, dependencies(goodGenerate))).sourceIds.length, 2);
  assert.deepEqual(store.summaryHistory(many).find(row => row.id === previous.id), previous);

  const parallel = context('parallel'); note(parallel, 'Two workers see the same immutable inputs.', 6);
  const results = await Promise.all([summarizePending(parallel, {}, dependencies(async (provider, request) => goodGenerate(provider, request))),
    summarizePending(parallel, {}, dependencies(async (provider, request) => JSON.stringify({ ...JSON.parse(goodGenerate(provider, request)), summary: 'Different wording from the second worker.' })))]);
  assert.equal(results.reduce((sum, row) => sum + row.created, 0), 1, 'publication dedupes two nondeterministic concurrent providers');
  assert.equal(store.listMemories(parallel).filter(record => record.provenance === 'generated').length, 1);
  console.log('AI summary provenance, privacy, bounds, replay and source-deletion tests passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert.equal(fs.realpathSync.native(root), root);
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(root).startsWith('mm-summary-test-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
