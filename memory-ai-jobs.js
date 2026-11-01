// Short-lived background summary jobs. Only derived notes enter the AI provider.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { safePath } = require('./archive-state');
const store = require('./memory-store');
const COOLDOWN_MS = 60000;
const MAX_BATCHES = 3;
const STATES = new Set(['idle', 'running', 'created', 'empty', 'disabled', 'capture_paused', 'provider_error', 'invalid_output', 'sources_changed', 'settings_changed', 'already_generated', 'failed']);
const location = context => safePath(store.memoryPath(context), 'ai-job.json');
function jobStatus(context) {
  const file = location(context); let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { version: 1, status: 'idle', remaining: 0, created: 0 }; throw e; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Invalid AI job state');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.version !== 1 || !STATES.has(value.status)
    || Object.keys(value).some(k => !['version','status','remaining','created','lastAttemptAt','syncPending'].includes(k))
    || !Number.isInteger(value.remaining) || value.remaining < 0 || value.remaining > 10000
    || !Number.isInteger(value.created) || value.created < 0 || value.created > MAX_BATCHES
    || value.lastAttemptAt !== undefined && (typeof value.lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(value.lastAttemptAt)))
    || value.syncPending !== undefined && typeof value.syncPending !== 'boolean') throw new Error('Invalid AI job state');
  return value;
}
function writeStatus(context, value) { require('./sync').atomicWrite(location(context), JSON.stringify({ version: 1, ...value }) + '\n'); }
function claim(context) {
  const dir = safePath(store.memoryPath(context)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = safePath(dir, 'ai-job.lock'), token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Publish a complete owner record exclusively. A crash before publication
      // leaves a private temporary file, never an ownerless permanent lock.
      const temporary = safePath(dir, '.ai-job-' + token + '.tmp');
      try {
        fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, token }) + '\n', { flag: 'wx', mode: 0o600 });
        fs.linkSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      return () => {
        const current = JSON.parse(fs.readFileSync(safePath(dir, 'ai-job.lock'), 'utf8'));
        if (current.token !== token) throw new Error('AI job ownership changed');
        fs.unlinkSync(file);
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink < 1 || stat.nlink > 2 || stat.size > 4096) throw new Error('Invalid AI job lock');
      let prior; try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
      if (!Number.isInteger(prior.pid) || prior.pid < 1 || typeof prior.token !== 'string') return null;
      try { process.kill(prior.pid, 0); return null; } catch (error) { if (error.code !== 'ESRCH') return null; }
      // Serialize dead-owner recovery so a second waiter cannot unlink the
      // replacement lock acquired by a live worker in between these checks.
      const guard = safePath(dir, 'ai-job.lock.recover'); let guardFd;
      try { guardFd = fs.openSync(guard, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      try {
        if (fs.readFileSync(file, 'utf8') !== JSON.stringify(prior) + '\n') return null;
        const current = fs.lstatSync(safePath(dir, 'ai-job.lock'));
        if (current.dev !== stat.dev || current.ino !== stat.ino) return null;
        if (current.nlink === 2) {
          // A crash just after publication may leave our temporary hard link.
          // Only remove that exact same-inode sibling for a proven-dead owner.
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(prior.token)) throw new Error('Invalid AI job publication');
          const temporary = safePath(dir, '.ai-job-' + prior.token + '.tmp');
          const sibling = fs.lstatSync(temporary);
          if (!sibling.isFile() || sibling.nlink !== 2 || sibling.dev !== current.dev || sibling.ino !== current.ino) throw new Error('Unrecognized AI job publication');
          fs.unlinkSync(temporary);
        } else if (current.nlink !== 1) throw new Error('Invalid AI job publication');
        fs.unlinkSync(file);
      } finally { fs.closeSync(guardFd); fs.unlinkSync(guard); }
    }
  }
  return null;
}
function scheduleAI(context, deps = {}) {
  if (process.env.MEM_MASTERO_AI_CHILD || process.env.MEM_MASTERO_AI_WORKER) return false;
  const settings = (deps.readAISettings || require('./memory-ai-provider').readAISettings)(context);
  if (!settings.automatic || !settings.summaries || !require('./memory-runtime').readSettings(context).capture) return false;
  if (typeof context.cwd !== 'string' || !path.isAbsolute(context.cwd)) throw new Error('AI worker requires a project cwd');
  const child = (deps.spawn || spawn)(process.execPath, [path.join(__dirname, 'sync.js'), 'memory-worker', context.cwd], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, MEM_MASTERO_AI_WORKER: '1', MEM_MASTERO_INHIBIT: '1' },
  });
  child.on('error', () => {}); child.unref(); return true;
}
async function runAIJob(context, deps = {}) {
  const getSettings = deps.readAISettings || require('./memory-ai-provider').readAISettings;
  const summarize = deps.summarizePending || require('./memory-summary').summarizePending;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const allowed = () => { const s = getSettings(context); return s.automatic && s.summaries; };
  if (!allowed()) return { status: 'disabled', created: 0, remaining: 0 };
  const release = claim(context); if (!release) return { status: 'busy', created: 0, remaining: 0 };
  let created = 0, remaining = 0, syncPending = false, status = 'idle';
  try {
    const previous = jobStatus(context);
    syncPending = previous.syncPending || false;
    if (syncPending && deps.sync) try { await deps.sync(context); syncPending = false; } catch {}
    let lastAttemptAt = previous.lastAttemptAt;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const wait = lastAttemptAt ? Math.min(COOLDOWN_MS, Math.max(0, COOLDOWN_MS - (now() - Date.parse(lastAttemptAt)))) : 0;
      if (wait) await sleep(wait);
      if (!allowed()) { status = 'disabled'; break; }
      if (!require('./memory-runtime').readSettings(context).capture) { status = 'capture_paused'; break; }
      lastAttemptAt = new Date(now()).toISOString();
      writeStatus(context, { status: 'running', created, remaining, lastAttemptAt, syncPending });
      const result = await summarize(context, { limit: 20, automatic: true });
      status = STATES.has(result.status) ? result.status : 'failed';
      created += result.created || 0; remaining = result.remaining || 0;
      if (result.created && deps.sync) try { await deps.sync(context); syncPending = false; } catch { syncPending = true; }
      writeStatus(context, { status, created, remaining, lastAttemptAt, syncPending });
      if (!result.created || !remaining) break;
    }
    writeStatus(context, { status, created, remaining, ...(lastAttemptAt ? { lastAttemptAt } : {}), syncPending });
    return { status, created, remaining, syncPending };
  } catch {
    writeStatus(context, { status: 'failed', created, remaining, lastAttemptAt: new Date(now()).toISOString(), syncPending });
    return { status: 'failed', created, remaining, syncPending };
  } finally { release(); }
}
module.exports = { scheduleAI, runAIJob, jobStatus, COOLDOWN_MS, MAX_BATCHES };
