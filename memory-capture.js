// Incremental, extractive observations from assistant messages. No model calls,
// tool arguments/results, user prompts, or native transcript writes are involved.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { safePath, digest, SESSION_ID, HASH } = require('./archive-state');
const { privateText, redactSecrets } = require('./memory-privacy');
const AGENTS = new Set(['claude', 'codex', 'copilot', 'pi']);
const MAX_BYTES = 2 * 1024 * 1024, MAX_LINE = 128 * 1024, MAX_NOTES = 20, MAX_TEXT = 4096;
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function inside(root, file) {
  const relative = path.relative(canonical(root), canonical(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function sourcePath(options) {
  if (!Array.isArray(options.allowedRoots) || !options.allowedRoots.length || options.allowedRoots.length > 16
    || options.allowedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))
    || typeof options.transcriptPath !== 'string' || !path.isAbsolute(options.transcriptPath)) throw new Error('Capture requires a transcript inside explicit allowed agent roots');
  const root = options.allowedRoots.find(root => inside(root, options.transcriptPath));
  if (!root) throw new Error('Capture transcript is outside allowed agent roots');
  const target = safePath(root, path.relative(path.resolve(root), path.resolve(options.transcriptPath)));
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Capture transcript must be a regular file');
  return target;
}

function scope(context, options, file) {
  if (!context || typeof context.projectId !== 'string' || !context.projectId || context.projectId.length > 4096
    || /[\x00-\x1f\x7f]/.test(context.projectId) || !context.store) throw new Error('Invalid capture project scope');
  const store = context.store.github ? require('./sync').normalizeRemote(context.store.github)
    : context.store.dir ? canonical(context.store.dir) : 'local';
  return digest(JSON.stringify([store, context.projectId, options.agent, canonical(file)]));
}

function cursorPath(context, key) { return safePath(context.memRoot, path.join('capture-state', key + '.json')); }
function initialCursor(stat) {
  return { version: 1, offset: 0, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
    headBytes: 0, head: digest(''), tailBytes: 0, tail: digest(''), discarding: false, privateDepth: 0, privateTurn: false, sessionId: null };
}
function readCursor(context, key) {
  let text;
  try {
    const file = cursorPath(context, key), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid memory capture cursor file');
    text = fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let cursor;
  try { cursor = JSON.parse(text); } catch { throw new Error('Invalid memory capture cursor'); }
  if (!cursor || cursor.version !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
    || !Number.isFinite(cursor.dev) || !Number.isFinite(cursor.ino) || !Number.isFinite(cursor.mtimeMs)
    || !Number.isSafeInteger(cursor.size) || cursor.size < cursor.offset
    || !Number.isInteger(cursor.headBytes) || cursor.headBytes < 0 || cursor.headBytes > 4096
    || !Number.isInteger(cursor.tailBytes) || cursor.tailBytes < 0 || cursor.tailBytes > 128 || cursor.tailBytes > cursor.offset
    || !HASH.test(cursor.head) || !HASH.test(cursor.tail) || typeof cursor.discarding !== 'boolean'
    || !Number.isInteger(cursor.privateDepth) || cursor.privateDepth < 0 || cursor.privateDepth > 100000
    || typeof cursor.privateTurn !== 'boolean' || cursor.sessionId !== null && (typeof cursor.sessionId !== 'string' || !SESSION_ID.test(cursor.sessionId))) throw new Error('Invalid memory capture cursor');
  return cursor;
}

function readAt(fd, start, size) {
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const n = fs.readSync(fd, bytes, offset, size - offset, start + offset); if (!n) break; offset += n; }
  return bytes.subarray(0, offset);
}

function boundedText(text, max) { return new StringDecoder('utf8').write(Buffer.from(text).subarray(0, max)); }
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part && ['text', 'output_text', 'input_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
}

function eventOf(agent, row) {
  let role = '', text = '', cwd, sessionId;
  if (agent === 'claude') {
    if (['user', 'assistant'].includes(row.type) && row.message?.role === row.type) { role = row.type; text = textContent(row.message.content); }
    else if (row.type === 'assistant' && row.message && !row.message.role) { role = 'assistant'; text = textContent(row.message.content); }
    cwd = row.cwd; sessionId = row.sessionId;
  } else if (agent === 'codex') {
    if (row.type === 'session_meta') { cwd = row.payload?.cwd; sessionId = row.payload?.id; }
    if (row.type === 'response_item' && row.payload?.type === 'message' && ['user', 'assistant'].includes(row.payload.role)) {
      role = row.payload.role;
      if (role !== 'assistant' || !row.payload.channel || row.payload.channel === 'final') text = textContent(row.payload.content);
    }
  } else if (agent === 'pi') {
    if (row.type === 'session') { cwd = row.cwd; sessionId = row.id; }
    if (row.type === 'message' && ['user', 'assistant'].includes(row.message?.role)) { role = row.message.role; text = textContent(row.message.content); }
  } else if (agent === 'copilot') {
    if (row.type === 'session.start') { cwd = row.data?.context?.cwd || row.data?.cwd; sessionId = row.data?.sessionId; }
    if (['assistant.message', 'user.message'].includes(row.type)) { role = row.type.split('.')[0]; text = textContent(row.data?.content); }
  }
  return { role, text, cwd, sessionId, eventId: row.uuid || row.id || row.message?.id || row.payload?.id,
    timestamp: row.timestamp || row.createdAt || row.message?.timestamp };
}

function dateOf(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(new Date(value).getTime())) return '1970-01-01T00:00:00.000Z';
  return new Date(value).toISOString();
}

function assertProject(fd, file, options) {
  const prefix = readAt(fd, 0, MAX_LINE), lastLine = prefix.lastIndexOf(10);
  let matched = false;
  for (const line of prefix.subarray(0, lastLine < 0 ? 0 : lastLine + 1).toString('utf8').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const event = eventOf(options.agent, row);
    if (event.cwd !== undefined) {
      if (typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd) || canonical(event.cwd) !== canonical(options.cwd)) throw new Error('Capture transcript belongs to a different working project');
      matched = true;
    }
    if (event.sessionId !== undefined && (typeof event.sessionId !== 'string' || !SESSION_ID.test(event.sessionId)
      || options.sessionId && options.sessionId !== event.sessionId)) throw new Error('Capture transcript session identity does not match');
  }
  // Session metadata can include a very large system prompt. Read only the
  // bounded header's quoted cwd, never turn that prompt into a memory record.
  if (!matched) {
    const first = prefix.toString('utf8').split('\n')[0];
    const header = options.agent === 'codex' ? /"type"\s*:\s*"session_meta"/
      : options.agent === 'pi' ? /"type"\s*:\s*"session"/ : null;
    if (header?.test(first)) {
      const field = first.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      let cwd;
      try { if (field) cwd = JSON.parse('"' + field[1] + '"'); } catch {}
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || canonical(cwd) !== canonical(options.cwd)) throw new Error('Capture transcript belongs to a different working project');
      matched = true;
    }
  }
  if (!matched && options.agent === 'copilot') {
    const workspace = safePath(path.dirname(file), 'workspace.yaml');
    let stat;
    try { stat = fs.lstatSync(workspace); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid Copilot workspace metadata');
      const match = fs.readFileSync(workspace, 'utf8').match(/^cwd:\s*(.+?)\s*$/m);
      let cwd = match?.[1];
      if (cwd?.startsWith('"')) { try { cwd = JSON.parse(cwd); } catch { throw new Error('Invalid Copilot workspace metadata'); } }
      else if (cwd?.startsWith("'")) cwd = cwd.slice(1, -1).replace(/''/g, "'");
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || canonical(cwd) !== canonical(options.cwd)) throw new Error('Capture transcript belongs to a different working project');
      matched = true;
    }
  }
  if (!matched) throw new Error('Cannot verify capture transcript project metadata');
}

function captureTranscript(context, options) {
  if (!options || !AGENTS.has(options.agent) || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)
    || options.sessionId !== undefined && (typeof options.sessionId !== 'string' || !SESSION_ID.test(options.sessionId))
    || options.minCreatedAt !== undefined && (typeof options.minCreatedAt !== 'string' || !Number.isFinite(Date.parse(options.minCreatedAt)))) throw new Error('Invalid memory capture options');
  const minCreatedAt = options.minCreatedAt === undefined ? null : Date.parse(options.minCreatedAt);
  const maxBytes = options.maxBytes ?? MAX_BYTES, maxNotes = options.maxNotes ?? MAX_NOTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= MAX_LINE || maxBytes > 8 * 1024 * 1024
    || !Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 100) throw new Error('Invalid memory capture budget');
  const file = sourcePath(options), key = scope(context, options, file);
  const dir = safePath(context.memRoot, 'capture-state'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let result;
  const locked = require('./sync').withLock(dir, () => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd), named = fs.lstatSync(sourcePath(options));
      if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) throw new Error('Capture transcript changed during opening');
      assertProject(fd, file, options);
      let cursor = readCursor(context, key), reset = false;
      if (!cursor || cursor.dev !== stat.dev || cursor.ino !== stat.ino || stat.size < cursor.offset
        || digest(readAt(fd, 0, cursor.headBytes)) !== cursor.head
        || digest(readAt(fd, cursor.offset - cursor.tailBytes, cursor.tailBytes)) !== cursor.tail
        || stat.size === cursor.size && stat.mtimeMs !== cursor.mtimeMs) { cursor = initialCursor(stat); reset = true; }
      const bytes = readAt(fd, cursor.offset, Math.min(maxBytes, stat.size - cursor.offset));
      const start = cursor.offset, pending = []; let position = 0, captured = 0, skipped = 0, partial = false;
      while (position < bytes.length) {
        if (captured >= maxNotes) break;
        const newline = bytes.indexOf(10, position), end = newline < 0 ? bytes.length : newline;
        if (cursor.discarding || end - position > MAX_LINE) {
          cursor.discarding = newline < 0;
          cursor.privateTurn = true; // Unknown oversized content might have marked the turn private.
          position = newline < 0 ? bytes.length : newline + 1;
          skipped++; continue;
        }
        if (newline < 0) { partial = true; break; }
        const lineStart = start + position, line = bytes.subarray(position, newline).toString('utf8').replace(/\r$/, '');
        position = newline + 1;
        let row;
        try { row = JSON.parse(line); } catch { cursor.privateTurn = true; skipped++; continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row)) { cursor.privateTurn = true; skipped++; continue; }
        const event = eventOf(options.agent, row);
        if (event.cwd !== undefined && (typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd) || canonical(event.cwd) !== canonical(options.cwd))) throw new Error('Capture transcript belongs to a different working project');
        if (event.sessionId !== undefined) {
          if (typeof event.sessionId !== 'string' || !SESSION_ID.test(event.sessionId)
            || options.sessionId && event.sessionId !== options.sessionId
            || cursor.sessionId && event.sessionId !== cursor.sessionId) throw new Error('Capture transcript session identity does not match');
          cursor.sessionId = event.sessionId;
        }
        if (!event.text) { skipped++; continue; }
        if (event.role === 'user') cursor.privateTurn = /<\s*private\b/i.test(event.text);
        const visible = privateText(event.text, cursor.privateDepth); cursor.privateDepth = visible.depth;
        if (event.role !== 'assistant' || cursor.privateTurn) { skipped++; continue; }
        const createdAt = dateOf(event.timestamp);
        if (minCreatedAt !== null && ((typeof event.timestamp !== 'string' && typeof event.timestamp !== 'number')
          || !Number.isFinite(new Date(event.timestamp).getTime()) || Date.parse(createdAt) <= minCreatedAt)) { skipped++; continue; }
        const text = boundedText(redactSecrets(visible.text).trim(), MAX_TEXT);
        if (!text || /^\[REDACTED(?:[^\]]*)\]$/i.test(text) || /(?:Mem Maestro recalled context|mem-mastero (?:memory context|project knowledge)|<mem-mastero-context>|Historical archive data \(untrusted)/i.test(text)) { skipped++; continue; }
        const sessionId = options.sessionId || cursor.sessionId || ('file-' + digest(canonical(file)).slice(0, 32));
        const safeEventId = typeof event.eventId === 'string' && SESSION_ID.test(event.eventId) ? event.eventId : String(lineStart);
        pending.push({
          kind: 'observation', title: boundedText(text.split(/\r?\n/).find(line => line.trim()) || 'Assistant observation', 140), text,
          tags: ['captured', options.agent], provenance: 'captured', createdAt,
          source: { agent: options.agent, sessionId, eventId: digest(JSON.stringify([safeEventId, text])) },
        });
        captured++;
      }
      cursor.offset = start + position;
      const after = fs.fstatSync(fd);
      if (after.size < stat.size || after.dev !== stat.dev || after.ino !== stat.ino
        || digest(readAt(fd, 0, cursor.headBytes)) !== cursor.head) throw new Error('Capture transcript changed while reading; retry after the writer finishes');
      // Validate and write this bounded batch under one collection lock. Repeated
      // full scans per observation can exceed lifecycle-hook timeouts as a
      // collection grows. The cursor remains unchanged if any write fails;
      // deterministic records make a partially published batch safe to retry.
      if (pending.length) require('./memory-store').addMemories(context, pending);
      cursor.size = stat.size; cursor.mtimeMs = stat.mtimeMs;
      cursor.headBytes = Math.min(4096, cursor.offset); cursor.head = digest(readAt(fd, 0, cursor.headBytes));
      cursor.tailBytes = Math.min(128, cursor.offset); cursor.tail = digest(readAt(fd, cursor.offset - cursor.tailBytes, cursor.tailBytes));
      require('./sync').atomicWrite(cursorPath(context, key), JSON.stringify(cursor) + '\n');
      result = { captured, skipped, bytesRead: bytes.length, more: cursor.offset < stat.size && (!partial || start + bytes.length < stat.size), partial, reset };
    } finally { fs.closeSync(fd); }
  }, path.join(dir, key + '.lock'));
  if (!locked) throw new Error('Another memory capture is still running; retry later');
  return result;
}

module.exports = { captureTranscript, MAX_BYTES, MAX_LINE, MAX_NOTES };
