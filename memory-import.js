// Read-only migration source: Claude-Mem's portable JSON export. Never opens its
// live database and never imports raw prompts or tool input/output payloads.
// https://docs.claude-mem.ai/usage/export-import
'use strict';
const { createHash } = require('node:crypto');
const { redactText } = require('./memory-privacy');
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 10000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
function identity(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value)) return value.trim();
  throw new Error('malformed_record');
}
function project(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('malformed_project');
  return value;
}
function aliases(row) {
  return [...new Set(['memory_session_id', 'sdk_session_id', 'content_session_id', 'claude_session_id']
    .filter(key => row[key] !== undefined && row[key] !== null).map(key => identity(row[key])))];
}
function sessionIdentity(row) {
  const values = aliases(row);
  return values[0];
}
function scalar(row, key) {
  if (row[key] === undefined || row[key] === null) return '';
  if (typeof row[key] !== 'string' || Buffer.byteLength(row[key]) > 64 * 1024) throw new Error('malformed_record');
  return row[key].trim();
}
function facts(row) {
  let value = row.facts;
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new Error('malformed_record'); } }
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || Buffer.byteLength(item) > 64 * 1024)) throw new Error('malformed_record');
  return value.join('\n');
}
function timestamp(row) {
  const value = row.created_at !== undefined ? row.created_at : row.created_at_epoch;
  if (!((typeof value === 'string' && value.length <= 64 && value.trim()) || (typeof value === 'number' && Number.isSafeInteger(value)))) throw new Error('malformed_timestamp');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('malformed_timestamp');
  return parsed.toISOString();
}
function inputFor(row, collection, sourceProject, sessionId) {
  const sourceId = identity(row.id), createdAt = timestamp(row);
  let kind, title, fields;
  if (collection === 'observations') {
    const type = scalar(row, 'type').toLowerCase();
    if (!type) throw new Error('malformed_record');
    kind = ({ decision: 'decision', bugfix: 'bugfix', discovery: 'discovery', preference: 'preference', constraint: 'constraint',
      progress: 'progress', feature: 'progress', refactor: 'progress', change: 'progress', observation: 'observation' })[type] || 'observation';
    title = scalar(row, 'title');
    fields = [['Title', title], ['Subtitle', scalar(row, 'subtitle')], ['Narrative', scalar(row, 'narrative')], ['Facts', facts(row)]];
  } else {
    kind = 'summary';
    title = 'Imported Claude-Mem session summary';
    fields = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'].map(key => [key.replace(/_/g, ' '), scalar(row, key)]);
  }
  // Redact before deriving identity or writing. An open private tag in one
  // field also hides following fields until a closing tag is encountered.
  const text = redactText(fields.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n\n'));
  if (!text || !fields.some(([, value]) => redactText(value))) throw new Error('empty_after_privacy');
  const source = { agent: 'claude-mem', eventId: 'cmem:' + hash([collection, sourceProject, sourceId, sessionId || null]) };
  if (sessionId) source.sessionId = 'cmem:' + hash([sourceProject, sessionId]);
  return { kind, title: redactText(title) || (kind === 'summary' ? title : 'Imported Claude-Mem observation'), text,
    createdAt, source, provenance: 'imported' };
}

function importClaudeMem(context, data, { sourceProject, dryRun = false } = {}) {
  // Explicit source scope is mandatory even when the export contains only one
  // project. It maps that named source project into the current target context.
  try { project(sourceProject); } catch { throw new Error('Claude-Mem import requires an explicit sourceProject'); }
  if (typeof dryRun !== 'boolean' || !object(data)) throw new Error('Invalid Claude-Mem import options or export');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(data)); } catch { throw new Error('Invalid Claude-Mem export'); }
  if (bytes > MAX_IMPORT_BYTES) throw new Error('Claude-Mem export exceeds the 64 MiB import limit');
  for (const name of ['observations', 'summaries', 'sessions']) {
    if (data[name] !== undefined && (!Array.isArray(data[name]) || data[name].length > MAX_ROWS)) throw new Error('Invalid or oversized Claude-Mem export collection');
  }
  if (!Array.isArray(data.observations) && !Array.isArray(data.summaries)) throw new Error('Claude-Mem export must contain observations or summaries');
  if ((data.observations || []).length + (data.summaries || []).length > MAX_ROWS) throw new Error('Claude-Mem export exceeds its record limit');
  const api = require('./memory-store');
  const existing = api.exportMemories(context);
  const seen = new Set(existing.records.map(record => record.id)), forgotten = new Set(existing.tombstones.map(record => record.id));
  const sessionProjects = new Map();
  for (const row of data.sessions || []) {
    if (!object(row)) continue;
    let keys, scope;
    try { keys = aliases(row); scope = project(row.project); } catch { continue; }
    for (const key of keys) {
      if (sessionProjects.has(key) && sessionProjects.get(key) !== scope) sessionProjects.set(key, null);
      else sessionProjects.set(key, scope);
    }
  }
  const report = { dryRun, imported: 0, wouldImport: 0, skipped: 0, rejected: 0, reasons: {} };
  const note = (status, reason) => { report[status]++; report.reasons[reason] = (report.reasons[reason] || 0) + 1; };
  const pending = [];
  for (const collection of ['observations', 'summaries']) for (const row of data[collection] || []) {
    try {
      if (!object(row)) throw new Error('malformed_record');
      const keys = aliases(row), mapped = keys.filter(key => sessionProjects.has(key)).map(key => sessionProjects.get(key));
      if (mapped.includes(null) || new Set(mapped).size > 1) throw new Error('conflicting_project');
      const explicit = own(row, 'project') && row.project !== null && row.project !== undefined ? project(row.project) : undefined;
      if (explicit !== undefined && mapped.length && explicit !== mapped[0]) throw new Error('conflicting_project');
      const scope = explicit === undefined ? mapped[0] : explicit;
      if (scope === undefined) throw new Error('unmapped_project');
      if (scope !== sourceProject) { note('skipped', 'different_project'); continue; }
      const input = inputFor(row, collection, sourceProject, sessionIdentity(row));
      const preview = api.previewMemory(context, input);
      if (forgotten.has(preview.id)) { note('skipped', 'forgotten'); continue; }
      if (seen.has(preview.id)) { note('skipped', 'duplicate'); continue; }
      seen.add(preview.id); pending.push(preview); report.wouldImport++;
    } catch (error) {
      const allowed = ['malformed_record', 'malformed_project', 'malformed_timestamp', 'conflicting_project', 'unmapped_project', 'empty_after_privacy'];
      note('rejected', allowed.includes(error.message) ? error.message : 'invalid_memory');
    }
  }
  // All accepted rows have been normalized and validated before any mutation.
  // Publish one preflighted batch under the store lock. Re-reading the growing
  // collection for each individual note would make large imports quadratic.
  if (!dryRun && pending.length) {
    let writeResult;
    try {
      writeResult = api.importMemories(context, { version: 1, projectId: existing.projectId, storeId: existing.storeId, records: pending, tombstones: [] });
    } catch { /* A failed filesystem publish can leave a verified partial batch. */ }
    const after = api.exportMemories(context), active = new Set(after.records.map(row => row.id)), dead = new Set(after.tombstones.map(row => row.id));
    const hidden = pending.filter(row => dead.has(row.id)).length;
    const present = pending.filter(row => active.has(row.id)).length;
    report.imported = writeResult ? Math.min(writeResult.imported, present) : present;
    for (let i = 0; i < hidden; i++) note('skipped', 'forgotten');
    for (let i = report.imported + hidden; i < pending.length; i++) {
      note(writeResult ? 'skipped' : 'rejected', writeResult ? 'duplicate' : 'write_failed');
    }
  }
  return report;
}

module.exports = { importClaudeMem, MAX_IMPORT_BYTES };
