const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jobs = require('./memory-ai-jobs');
const store = require('./memory-store');
const runtime = require('./memory-runtime');
const provider = require('./memory-ai-provider');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ai-jobs-')));
const context = { cwd: root, memRoot: path.join(root, 'memory'), projectId: 'github.com/example/jobs', store: { dir: path.join(root, 'drive') } };
const settings = { version: 1, semantic: true, summaries: true, automatic: true, provider: { type: 'codex' } };
(async () => {
  assert.equal(jobs.jobStatus(context).status, 'idle');
  let launches = 0;
  const spawn = (command, args, options) => {
    launches++; assert.equal(command, process.execPath); assert.equal(args[1], 'memory-worker'); assert.equal(args[2], root);
    assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'ignore'); assert.equal(options.env.MEM_MASTERO_AI_WORKER, '1');
    return { on() {}, unref() {} };
  };
  assert.equal(jobs.scheduleAI(context, { readAISettings: () => ({ ...settings, automatic: false }), spawn }), false);
  assert.equal(jobs.scheduleAI(context, { readAISettings: () => settings, spawn }), true);
  assert.equal(launches, 1);
  const priorChild = process.env.MEM_MASTERO_AI_CHILD;
  process.env.MEM_MASTERO_AI_CHILD = '1';
  try { assert.equal(jobs.scheduleAI(context, { readAISettings: () => settings, spawn }), false); }
  finally { if (priorChild === undefined) delete process.env.MEM_MASTERO_AI_CHILD; else process.env.MEM_MASTERO_AI_CHILD = priorChild; }
  runtime.updateSettings(context, { capture: false });
  assert.equal(jobs.scheduleAI(context, { readAISettings: () => settings, spawn }), false);
  assert.equal((await jobs.runAIJob(context, { readAISettings: () => settings })).status, 'capture_paused');
  runtime.updateSettings(context, { capture: true });

  let current = Date.now(), calls = 0, syncs = 0, waits = 0;
  const deps = { readAISettings: () => settings, now: () => current, sleep: async ms => { waits++; assert(ms <= jobs.COOLDOWN_MS); current += ms; },
    summarizePending: async (_context, options) => {
      calls++; assert.equal(options.automatic, true); assert.equal(options.limit, 20);
      assert.equal((await jobs.runAIJob(context, { readAISettings: () => settings })).status, 'busy', 'a live owner is never displaced');
      return { created: 1, status: 'created', remaining: 100 };
    }, sync: async () => { syncs++; throw new Error('private network error should not enter job status'); } };
  const report = await jobs.runAIJob(context, deps);
  assert.equal(calls, jobs.MAX_BATCHES); assert.equal(waits, jobs.MAX_BATCHES - 1); assert.equal(syncs, jobs.MAX_BATCHES);
  assert.equal(report.syncPending, true); assert.equal(report.created, jobs.MAX_BATCHES);
  assert(!JSON.stringify(jobs.jobStatus(context)).includes('private network'));
  assert(!fs.existsSync(path.join(store.memoryPath(context), 'ai-job.lock')));
  let attempt = 0;
  const failed = await jobs.runAIJob(context, { ...deps, summarizePending: async () => { attempt++; return { created: 0, remaining: 1, status: 'provider_error' }; } });
  assert.equal(failed.status, 'provider_error'); assert.equal(attempt, 1, 'automatic provider errors do not retry in a tight loop');
  assert.equal(failed.syncPending, true, 'a failed retry cannot clear an outstanding upload');
  let retriedSync = 0;
  const synced = await jobs.runAIJob(context, { ...deps, sync: async () => { retriedSync++; }, summarizePending: async () => ({ created: 0, remaining: 0, status: 'empty' }) });
  assert.equal(retriedSync, 1, 'an empty follow-up still retries the pending upload');
  assert.equal(synced.syncPending, false);
  assert.equal((await jobs.runAIJob(context, { ...deps, summarizePending: async () => { throw new Error('sensitive response'); } })).status, 'failed');
  assert(!JSON.stringify(jobs.jobStatus(context)).includes('sensitive'));

  // A completed fixture process supplies a certainly dead PID for recovery.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(dead.status, 0);
  const lock = path.join(store.memoryPath(context), 'ai-job.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: dead.pid, token: 'dead-owner' }) + '\n');
  const recovered = await jobs.runAIJob(context, { ...deps, summarizePending: async () => ({ created: 0, remaining: 0, status: 'empty' }) });
  assert.equal(recovered.status, 'empty'); assert(!fs.existsSync(lock));
  const token = require('node:crypto').randomUUID(), interrupted = path.join(store.memoryPath(context), '.ai-job-' + token + '.tmp');
  fs.writeFileSync(interrupted, JSON.stringify({ pid: dead.pid, token }) + '\n'); fs.linkSync(interrupted, lock);
  assert.equal(fs.statSync(lock).nlink, 2);
  const published = await jobs.runAIJob(context, { ...deps, summarizePending: async () => ({ created: 0, remaining: 0, status: 'empty' }) });
  assert.equal(published.status, 'empty'); assert(!fs.existsSync(lock)); assert(!fs.existsSync(interrupted), 'interrupted publication removes only its proven sibling');
  fs.writeFileSync(lock, 'malformed lock');
  assert.equal((await jobs.runAIJob(context, deps)).status, 'busy', 'unknown lock ownership is preserved'); fs.unlinkSync(lock);

  // The actual dispatcher does not recurse when launched by an AI client.
  const child = spawnSync(process.execPath, [path.join(__dirname, 'sync.js'), 'claude', 'push'], {
    cwd: root, env: { ...process.env, MEM_MASTERO_AI_CHILD: '1' }, input: '{}', encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  provider.configureAI(context, { provider: { type: 'codex' }, summaries: true, automatic: true });
  assert.equal(provider.readAISettings(context).automatic, true);
  console.log('AI background job, concurrency, retry, recursion and privacy tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = fs.realpathSync.native(root);
  assert.equal(resolved, root); assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mm-ai-jobs-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
