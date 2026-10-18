// node test.js — machine A -> Drive -> machine B (different local folder names), then nothing left to copy
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncDir, normalizeRemote } = require('./sync');

for (const u of ['git@github.com:o/R.git', 'https://github.com/o/r', 'https://user@github.com/o/r.git/', 'ssh://git@github.com:22/o/r.git']) {
  assert.strictEqual(normalizeRemote(u), 'github.com/o/r', u);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mastero-'));
const A = path.join(tmp, 'D--Work-repo'), B = path.join(tmp, 'C--Users-x-repo'), drive = path.join(tmp, 'drive');
fs.mkdirSync(path.join(A, 'memory'), { recursive: true });
fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), '- fact');
fs.writeFileSync(path.join(A, 's1.jsonl'), '{}');

assert.strictEqual(syncDir(A, drive).length, 2);       // A pushes
assert.strictEqual(syncDir(drive, B).length, 2);       // B pulls
assert.strictEqual(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8'), '- fact');
assert(Math.abs(fs.statSync(path.join(B, 's1.jsonl')).mtimeMs - fs.statSync(path.join(A, 's1.jsonl')).mtimeMs) < 1000); // mtime carried over
for (const [s, d] of [[A, drive], [drive, A], [B, drive], [drive, B]]) assert.strictEqual(syncDir(s, d).length, 0); // no ping-pong

// B edits memory later -> flows back to A
const later = new Date(Date.now() + 10000);
fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), '- fact\n- new');
fs.utimesSync(path.join(B, 'memory', 'MEMORY.md'), later, later);
assert.deepStrictEqual(syncDir(B, drive), [path.join('memory', 'MEMORY.md')]);
syncDir(drive, A);
assert.strictEqual(fs.readFileSync(path.join(A, 'memory', 'MEMORY.md'), 'utf8'), '- fact\n- new');

fs.rmSync(tmp, { recursive: true });

// End to end through the hook entry point: Codex + Copilot on machines A and B, Drive-style folder in between.
const { execFileSync } = require('child_process');
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mastero-agents-'));
const hub = path.join(t, 'hub');
const machine = m => {
  const h = path.join(t, m), repo = path.join(h, 'code', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:me/demo.git']);
  const env = { ...process.env, USERPROFILE: h, HOME: h, MEM_MASTERO_DIR: hub, CODEX_HOME: path.join(h, '.codex'), COPILOT_HOME: path.join(h, '.copilot'), CLAUDE_CONFIG_DIR: path.join(h, '.claude') };
  const run = (agent, mode, input = {}) => execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), agent, mode], { env, input: JSON.stringify({ cwd: repo, ...input }), encoding: 'utf8' });
  return { h, repo, env, run, codex: path.join(env.CODEX_HOME, 'sessions'), copilot: path.join(env.COPILOT_HOME, 'session-state') };
};
const MA = machine('A'), MB = machine('B');
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const day = path.join('2026', '10', '18');

put(path.join(MA.codex, day, 'rollout-mine.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: MA.repo, base_instructions: { text: 'x'.repeat(50000) } } }) + '\n');
put(path.join(MA.codex, day, 'rollout-other.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: t } }) + '\n');
put(path.join(MA.copilot, 'sid-1', 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { context: { cwd: MA.repo } } }) + '\n');
put(path.join(MA.copilot, 'sid-1', 'plan.md'), 'plan');

assert.match(MA.run('codex', 'start'), /pushed 1 file/);
assert.match(MA.run('copilot', 'start'), /pushed 2 file/);
assert(!walkHas(path.join(hub, 'projects'), 'rollout'), 'Claude area must not hold Codex files');

assert.match(MB.run('codex', 'start'), /pulled 1, pushed 0/);
assert(fs.existsSync(path.join(MB.codex, day, 'rollout-mine.jsonl')) && !fs.existsSync(path.join(MB.codex, day, 'rollout-other.jsonl')));
assert.match(MB.run('copilot', 'start'), /pulled 2, pushed 0/);
assert.strictEqual(fs.readFileSync(path.join(MB.copilot, 'sid-1', 'plan.md'), 'utf8'), 'plan');
assert.match(MB.run('claude', 'start'), /pulled 0, pushed 0/);
assert(!walkHas(path.join(MB.h, '.claude'), '.'), 'Claude must not pull Codex/Copilot files');

// Per-turn / session-end pushes from B reach A on its next start.
const later2 = new Date(Date.now() + 10000);
const bRollout = path.join(MB.codex, day, 'rollout-mine.jsonl');
fs.appendFileSync(bRollout, '{"turn":2}\n'); fs.utimesSync(bRollout, later2, later2);
MB.run('codex', 'push', { transcript_path: bRollout });
put(path.join(MB.copilot, 'sid-1', 'plan.md'), 'plan v2'); fs.utimesSync(path.join(MB.copilot, 'sid-1', 'plan.md'), later2, later2);
MB.run('copilot', 'push', { sessionId: 'sid-1' });
MA.run('codex', 'start'); MA.run('copilot', 'start');
assert.match(fs.readFileSync(path.join(MA.codex, day, 'rollout-mine.jsonl'), 'utf8'), /turn":2/);
assert.strictEqual(fs.readFileSync(path.join(MA.copilot, 'sid-1', 'plan.md'), 'utf8'), 'plan v2');

function walkList(d) { return fs.readdirSync(d, { recursive: true }).filter(f => fs.statSync(path.join(d, f)).isFile()); }
function walkHas(d, s) { try { return walkList(d).some(f => f.includes(s)); } catch { return false; } }

fs.rmSync(t, { recursive: true });
console.log('ok');
