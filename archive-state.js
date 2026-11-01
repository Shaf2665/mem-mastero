// Machine-local archive bookkeeping. Never put this file in a synced memory store.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function safePath(root, relative = '') {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path escapes its allowed directory');
  // Check ancestors as well: a normal-looking child under a symlink is still unsafe.
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}

function statePath(context) {
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const store = require('./sync').normalizeRemote(context.store.github);
  const key = digest(JSON.stringify([canonical(context.claudeRoot), canonical(context.projectDir), context.projectId, store]));
  return safePath(context.memRoot, path.join('archive-state', key + '.json'));
}

function readState(context) {
  let text;
  try { text = fs.readFileSync(statePath(context), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, sessions: {} }; throw e; }
  let state;
  try { state = JSON.parse(text); } catch { throw new Error('Invalid local archive state; sync stopped to avoid restoring evicted sessions'); }
  if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) throw new Error('Invalid local archive state');
  for (const [id, record] of Object.entries(state.sessions)) {
    if (!SESSION_ID.test(id) || !record || !HASH.test(record.revision)) throw new Error('Invalid local archive session record');
  }
  return state;
}

function writeState(context, state) {
  require('./sync').atomicWrite(statePath(context), JSON.stringify(state, null, 2) + '\n');
}

function excludedFromPull(relative, state) {
  const first = relative.split(/[\\/]/)[0];
  const id = first.endsWith('.jsonl') ? first.slice(0, -6) : first;
  return Object.hasOwn(state.sessions, id);
}

function withArchiveLock(memRoot, fn) {
  const dir = safePath(memRoot, 'locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!require('./sync').withLock(dir, fn, path.join(dir, 'claude-archive.lock'))) throw new Error('Another Claude archive or sync is still running; retry later');
}

module.exports = { SESSION_ID, HASH, digest, safePath, statePath, readState, writeState, excludedFromPull, withArchiveLock };
