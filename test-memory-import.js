const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importClaudeMem } = require('./memory-import');
const store = require('./memory-store');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-memory-import-')));
const context = { memRoot: path.join(root, 'mem'), projectId: 'github.com/example/target', store: { github: 'https://github.com/example/memory.git' } };
const copy = value => JSON.parse(JSON.stringify(value));
const when = '2026-10-30T12:00:00.000Z';
const observation = (id, extra = {}) => ({ id, project: 'source', type: 'decision', memory_session_id: 'session-1', created_at: when,
  title: 'Queue retries', narrative: 'Use bounded exponential backoff.', facts: JSON.stringify(['Retry only transient failures.']), ...extra });
try {
  const exported = {
    exportedAt: when, project: 'misleading-top-level-scope',
    sessions: [{ content_session_id: 'conversation-1', memory_session_id: 'session-1', project: 'source' },
      { content_session_id: 'other-conversation', memory_session_id: 'session-2', project: 'other' }],
    observations: [observation(1), observation(2, { project: 'other', memory_session_id: 'session-2', narrative: 'OTHER PROJECT MUST NOT IMPORT' }),
      observation(3, { project: undefined, narrative: 'Infer project from verified exported session mapping.' })],
    summaries: [{ id: 4, memory_session_id: 'session-1', created_at_epoch: Date.parse(when), learned: 'Retries must remain bounded.', completed: 'Added retry tests.' }],
    prompts: [{ project: 'source', prompt_text: 'RAW PROMPT MUST NOT IMPORT', content_session_id: 'conversation-1' }],
  };
  assert.throws(() => importClaudeMem(context, exported), /explicit sourceProject/);
  assert.throws(() => importClaudeMem(context, exported, { sourceProject: '', dryRun: true }), /explicit sourceProject/);
  const preview = importClaudeMem(context, exported, { sourceProject: 'source', dryRun: true });
  assert.equal(preview.wouldImport, 3); assert.equal(preview.imported, 0); assert.equal(preview.skipped, 1);
  assert(!fs.existsSync(context.memRoot), 'preview performs no filesystem writes, including locks or index files');
  const imported = importClaudeMem(context, exported, { sourceProject: 'source' });
  assert.equal(imported.imported, 3); assert.equal(imported.rejected, 0);
  const records = store.listMemories(context);
  assert.equal(records.length, 3);
  assert(records.every(row => row.projectId === context.projectId && row.source.agent === 'claude-mem' && row.provenance === 'imported'));
  assert(!JSON.stringify(records).includes('RAW PROMPT'));
  assert(!JSON.stringify(records).includes('OTHER PROJECT'));
  assert.equal(records.find(row => row.kind === 'summary').createdAt, when);

  const repeated = importClaudeMem(context, exported, { sourceProject: 'source' });
  assert.equal(repeated.imported, 0); assert.equal(repeated.skipped, 4); assert.equal(repeated.reasons.duplicate, 3);
  const legacy = copy(exported);
  for (const name of ['sessions', 'observations', 'summaries']) for (const row of legacy[name]) {
    if (row.memory_session_id !== undefined) { row.sdk_session_id = row.memory_session_id; delete row.memory_session_id; }
    if (row.content_session_id !== undefined) { row.claude_session_id = row.content_session_id; delete row.content_session_id; }
  }
  legacy.observations[0].facts = ['Retry only transient failures.'];
  assert.equal(importClaudeMem(context, legacy, { sourceProject: 'source' }).reasons.duplicate, 3, 'legacy aliases and array facts retain stable identities');
  store.forgetMemory(context, records[0].id);
  const afterForget = importClaudeMem(context, exported, { sourceProject: 'source' });
  assert.equal(afterForget.imported, 0); assert.equal(afterForget.reasons.forgotten, 1);
  assert.equal(store.getMemory(context, records[0].id), null, 're-import cannot resurrect a forgotten record');

  const unscoped = { project: 'source', observations: [observation(5, { project: undefined, memory_session_id: undefined })] };
  assert.equal(importClaudeMem(context, unscoped, { sourceProject: 'source' }).reasons.unmapped_project, 1, 'top-level project never authorizes unscoped rows');
  const conflicts = copy(exported);
  conflicts.observations = [observation(6, { project: 'source', memory_session_id: 'session-2' })]; conflicts.summaries = [];
  assert.equal(importClaudeMem(context, conflicts, { sourceProject: 'source' }).reasons.conflicting_project, 1);
  conflicts.sessions.push({ memory_session_id: 'session-2', project: 'source' });
  assert.equal(importClaudeMem(context, conflicts, { sourceProject: 'source' }).reasons.conflicting_project, 1, 'ambiguous parent mappings fail closed');

  const privateExport = { observations: [observation(7, { title: '<private>HIDDEN TITLE</private> Safe title',
    narrative: 'Useful knowledge. <private>HIDDEN FACT</private> api_key=SUPERSECRET', facts: ['Nonsecret fact'] }),
    observation(8, { title: '', narrative: '<private>ALL PRIVATE</private>', facts: [] })] };
  const privateResult = importClaudeMem(context, privateExport, { sourceProject: 'source' });
  assert.equal(privateResult.imported, 1); assert.equal(privateResult.reasons.empty_after_privacy, 1);
  const serialized = JSON.stringify(store.exportMemories(context));
  for (const secret of ['HIDDEN TITLE', 'HIDDEN FACT', 'SUPERSECRET', 'ALL PRIVATE']) assert(!serialized.includes(secret));
  assert(!JSON.stringify(privateResult).includes('SUPERSECRET'), 'reports expose fixed reason codes, never raw record text');

  const invalid = { observations: [observation(9, { facts: '{invalid' }), observation(10, { created_at: 'not-a-date' }),
    observation(11, { narrative: 'x'.repeat(20000) }), observation(12, { id: {} }), observation(13, { narrative: 'Valid partial import.' })] };
  const partial = importClaudeMem(context, invalid, { sourceProject: 'source' });
  assert.equal(partial.imported, 1); assert.equal(partial.rejected, 4);
  assert.throws(() => importClaudeMem(context, { observations: {} }, { sourceProject: 'source' }), /Invalid/);
  assert.throws(() => importClaudeMem(context, { observations: Array(10001).fill(null) }, { sourceProject: 'source' }), /oversized/);
  const corrupt = store.exportMemories(context); assert(corrupt.records.length > 0);
  const recordPath = path.join(store.memoryPath(context), 'records', corrupt.records[0].id.slice(7) + '.json');
  fs.writeFileSync(recordPath, '{}');
  assert.throws(() => importClaudeMem(context, exported, { sourceProject: 'source', dryRun: true }), /Invalid memory/);
  console.log('Claude-Mem import tests passed');
} finally {
  const resolved = fs.realpathSync.native(root);
  if (resolved !== root || !path.basename(resolved).startsWith('mm-memory-import-')) throw new Error('Unexpected cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
