// node test.js — machine A -> Drive -> machine B (different local folder names), then nothing left to copy
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncDir, normalizeRemote, matches, pickStore } = require('./sync');

// Store routing: first matching rule-based store, else the catch-all, else not synced.
assert(matches('dev.azure.com/acme/*', 'dev.azure.com/acme/web/_git/app'));
assert(matches('github.com/acme', 'github.com/acme/api') && !matches('github.com/acme', 'github.com/acmecorp/api'));
{
  const work = { github: 'w', for: ['dev.azure.com/acme/*', 'github.com/acme'] }, me = { github: 'p' };
  assert.strictEqual(pickStore({ stores: [work, me] }, 'github.com/acme/api'), work);
  assert.strictEqual(pickStore({ stores: [work, me] }, 'github.com/me/hobby'), me);
  assert.strictEqual(pickStore({ stores: [work] }, 'github.com/me/hobby'), null, 'work-only laptop skips personal projects');
  assert.deepStrictEqual(pickStore({ github: 'legacy' }, 'x/y/z'), { github: 'legacy' }, 'v0.7 config still works');
}

for (const u of ['git@github.com:o/R.git', 'https://github.com/o/r', 'https://user@github.com/o/r.git/', 'ssh://git@github.com:22/o/r.git']) {
  assert.strictEqual(normalizeRemote(u), 'github.com/o/r', u);
}
// Azure Repos: every URL form of one repo maps to the same project
for (const u of ['https://Org@dev.azure.com/Org/Proj/_git/Repo', 'git@ssh.dev.azure.com:v3/Org/Proj/Repo', 'https://org.visualstudio.com/Proj/_git/Repo',
  'https://org.visualstudio.com/DefaultCollection/Proj/_git/Repo', 'org@vs-ssh.visualstudio.com:v3/org/Proj/Repo']) {
  assert.strictEqual(normalizeRemote(u), 'dev.azure.com/org/proj/_git/repo', u);
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
  const env = { ...process.env, USERPROFILE: h, HOME: h, MEM_MASTERO_DIR: hub, CODEX_HOME: path.join(h, '.codex'), COPILOT_HOME: path.join(h, '.copilot'), CLAUDE_CONFIG_DIR: path.join(h, '.claude'), PI_CODING_AGENT_DIR: path.join(h, '.pi', 'agent') };
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
// Current Copilot CLI: cwd lives in workspace.yaml; inuse.<pid>.lock/.hold are machine-local and never synced.
put(path.join(MA.copilot, 'sid-2', 'workspace.yaml'), `id: sid-2
cwd: ${MA.repo}
branch: main
`);
put(path.join(MA.copilot, 'sid-2', 'inuse.4242.lock'), '4242');
put(path.join(MA.copilot, 'sid-2', 'inuse.4242.hold'), '');

assert.match(MA.run('codex', 'start'), /pushed 1 file/);
assert.match(MA.run('copilot', 'start'), /pushed 3 file/);
assert(!walkHas(hub, 'inuse.'), 'lock files stay on their machine');
assert(!walkHas(path.join(hub, 'projects'), 'rollout'), 'Claude area must not hold Codex files');

assert.match(MB.run('codex', 'start'), /pulled 1, pushed 0/);
assert(fs.existsSync(path.join(MB.codex, day, 'rollout-mine.jsonl')) && !fs.existsSync(path.join(MB.codex, day, 'rollout-other.jsonl')));
assert.match(MB.run('copilot', 'start'), /pulled 3, pushed 0/);
assert(fs.existsSync(path.join(MB.copilot, 'sid-2', 'workspace.yaml')), 'session found via workspace.yaml cwd');
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

// Pi: per-cwd session folders whose names differ per machine; the extension drives sync.js.
const piDir = m => path.join(m.h, '.pi', 'agent', 'sessions', '--' + m.repo.replace(/^[\\/]+/, '').replace(/[\\/:]/g, '-') + '--');
put(path.join(piDir(MA), '2026-10-18_s1.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: MA.repo }) + '\n');
assert.match(MA.run('pi', 'start'), /pushed 1 file/);
(async () => {
  Object.assign(process.env, MB.env);
  const ext = (await import('./pi/index.js')).default;
  const handlers = {}, notes = [];
  ext({ on: (e, h) => { handlers[e] = h; } });
  assert.deepStrictEqual(Object.keys(handlers).sort(), ['agent_end', 'session_shutdown', 'session_start']);
  const ctx = { cwd: MB.repo, ui: { notify: m => notes.push(m) }, sessionManager: { getSessionDir: () => piDir(MB), getSessionFile: () => undefined } };
  await handlers.session_start({}, ctx);
  assert.match(notes[0], /pi github\.com\/me\/demo .*pulled 1/);
  assert(fs.existsSync(path.join(piDir(MB), '2026-10-18_s1.jsonl')), 'Pi session pulled into this machine\'s cwd folder');

  // Big sessions: stored as line-aligned parts in the synced folder, rebuilt byte-for-byte on pull.
  for (const m of [MA, MB]) m.env.MEM_MASTERO_PART_BYTES = '100';
  const claudeDir = m => path.join(m.h, '.claude', 'projects', m.repo.replace(/[^a-zA-Z0-9]/g, '-'));
  const big = Array.from({ length: 20 }, (_, i) => JSON.stringify({ turn: i, text: 'hello world' })).join('\n') + '\n';
  put(path.join(claudeDir(MA), 'big.jsonl'), big);
  MA.run('claude', 'start');
  const pd = path.join(hub, 'projects', 'github.com', 'me', 'demo', 'big.jsonl.parts');
  const man = JSON.parse(fs.readFileSync(path.join(pd, 'manifest.json'), 'utf8'));
  assert(man.parts.length > 1 && !fs.existsSync(pd.slice(0, -6)), 'stored as parts only');
  for (const p of man.parts) {
    const s = fs.readFileSync(path.join(pd, p), 'utf8');
    assert(s.length <= 100 && s.endsWith('\n'), 'parts are line-aligned and under the limit');
    s.trim().split('\n').forEach(l => JSON.parse(l)); // each part is valid JSONL on its own
  }
  assert.match(MB.run('claude', 'start'), /pulled 1/);
  assert.strictEqual(fs.readFileSync(path.join(claudeDir(MB), 'big.jsonl'), 'utf8'), big);
  assert.match(MA.run('claude', 'start'), /pulled 0, pushed 0/);
  assert.match(MB.run('claude', 'start'), /pulled 0, pushed 0/);

  // Half-synced parts (one missing) are never rebuilt into a corrupt session.
  fs.rmSync(path.join(claudeDir(MB), 'big.jsonl'));
  fs.rmSync(path.join(pd, man.parts[1]));
  MB.run('claude', 'pull');
  assert(!fs.existsSync(path.join(claudeDir(MB), 'big.jsonl')), 'incomplete parts are skipped');
  fs.rmSync(t, { recursive: true });

  await gitHooksTest();
  setupTest();
  console.log('ok');
})();

// Git hooks: `git clone` / `git push` / `git pull` sync memory on two isolated "machines" (own home + global git config).
async function gitHooksTest() {
  const g = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mastero-git-'))); // long path, as git reports it
  const origin = path.join(g, 'origin.git'), hub2 = path.join(g, 'hub');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  const box = (name, memoryRepo) => {
    const h = path.join(g, name);
    fs.mkdirSync(h, { recursive: true });
    if (memoryRepo) fs.writeFileSync(path.join(h, '.mem-mastero.json'), JSON.stringify({ github: memoryRepo }));
    const env = { ...process.env, USERPROFILE: h, HOME: h, GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig'), MEM_MASTERO_DIR: hub2, CLAUDE_CONFIG_DIR: path.join(h, '.claude'), CODEX_HOME: path.join(h, '.codex'), COPILOT_HOME: path.join(h, '.copilot'), PI_CODING_AGENT_DIR: path.join(h, '.pi', 'agent') };
    delete env.MEM_MASTERO_INHIBIT; delete env.MEM_MASTERO_PART_BYTES;
    if (memoryRepo) delete env.MEM_MASTERO_DIR;
    const sh = (args, cwd = h) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['core.autocrlf', 'false'], ['init.defaultBranch', 'main']]) sh(['config', '--global', k, v]);
    const out = execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), 'install-git-hooks'], { env, encoding: 'utf8' });
    assert.match(out, /git hooks installed/);
    const repo = path.join(h, 'work', 'app');
    const mem = () => path.join(h, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
    return { h, env, sh, repo, mem };
  };
  const waitFor = async (f, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (f()) return true; return false; };
  const A = box('A'), B = box('B');

  A.sh(['clone', '-q', origin, A.repo]);
  // The repo's own hooks keep running under mem-mastero's global hooks path.
  fs.writeFileSync(path.join(A.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho ran > "$(git rev-parse --git-dir)/own-hook-ran"\n', { mode: 0o755 });
  put(A.mem(), '- fact from A\n');
  fs.writeFileSync(path.join(A.repo, 'f.txt'), '1');
  A.sh(['add', '.'], A.repo); A.sh(['commit', '-qm', 'one'], A.repo);
  assert(fs.existsSync(path.join(A.repo, '.git', 'own-hook-ran')), 'repo\'s own pre-commit hook still runs');
  A.sh(['push', '-q', 'origin', 'HEAD'], A.repo);
  const hubMem = path.join(hub2, 'projects', ...normalizeRemote(origin).split('/'), 'memory', 'MEMORY.md');
  assert(await waitFor(() => fs.existsSync(hubMem)), 'git push uploads memory (background)');

  B.sh(['clone', '-q', origin, B.repo]);
  assert.strictEqual(fs.readFileSync(B.mem(), 'utf8'), '- fact from A\n', 'git clone downloads memory');

  const later3 = new Date(Date.now() + 10000);
  put(A.mem(), '- fact from A\n- newer fact\n'); fs.utimesSync(A.mem(), later3, later3);
  fs.writeFileSync(path.join(A.repo, 'f.txt'), '2');
  A.sh(['commit', '-qam', 'two'], A.repo); A.sh(['push', '-q'], A.repo);
  assert(await waitFor(() => fs.readFileSync(hubMem, 'utf8').includes('newer')), 'second push uploads the update');
  B.sh(['pull', '-q', '--no-rebase'], B.repo);
  assert.match(fs.readFileSync(B.mem(), 'utf8'), /newer fact/, 'git pull downloads memory');

  // GitHub backend: git sets GIT_DIR etc. for hooks; the memory commit must land in the memory repo,
  // never in the repo being pushed (this once leaked memory into a public repo).
  const memRepo = path.join(g, 'memory.git');
  execFileSync('git', ['init', '-q', '--bare', memRepo]);
  const C = box('C', memRepo);
  C.sh(['clone', '-q', origin, C.repo]);
  put(C.mem(), '- fact from C\n');
  fs.writeFileSync(path.join(C.repo, 'f.txt'), '3');
  C.sh(['commit', '-qam', 'three'], C.repo); C.sh(['push', '-q'], C.repo);
  const memFiles = () => { try { return execFileSync('git', ['--git-dir', memRepo, 'log', '--all', '--name-only', '--format='], { encoding: 'utf8' }); } catch { return ''; } };
  assert(await waitFor(() => memFiles().includes('MEMORY.md')), 'memory pushed to the memory repo');
  const authors = execFileSync('git', ['--git-dir', origin, 'log', '--all', '--format=%an'], { encoding: 'utf8' });
  assert(!authors.includes('mem-mastero'), 'no mem-mastero commit in the project repo');
  assert(!execFileSync('git', ['--git-dir', origin, 'log', '--all', '--name-only', '--format='], { encoding: 'utf8' }).includes('MEMORY.md'), 'no memory files in the project repo');
  execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), 'uninstall-git-hooks'], { env: C.env });

  execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), 'uninstall-git-hooks'], { env: A.env });
  assert.throws(() => execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { env: A.env, stdio: 'ignore' }), 'uninstall unsets hooksPath');
  fs.rmSync(g, { recursive: true, force: true });
}


// setup: two memory repos (work + personal) on machine A; machine B reconnects to the work one with no other input.
function setupTest() {
  const g = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mastero-setup-')));
  const bare = n => { const p = path.join(g, n + '.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', p]); return p; };
  const W = bare('work-memory'), P = bare('personal-memory');
  const machine = name => {
    const h = path.join(g, name); fs.mkdirSync(h);
    const env = { ...process.env, USERPROFILE: h, HOME: h, GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig'), CLAUDE_CONFIG_DIR: path.join(h, '.claude'),
      CODEX_HOME: path.join(h, '.codex'), COPILOT_HOME: path.join(h, '.copilot'), PI_CODING_AGENT_DIR: path.join(h, '.pi', 'agent') };
    for (const k of ['MEM_MASTERO_DIR', 'MEM_MASTERO_INHIBIT', 'MEM_MASTERO_PART_BYTES']) delete env[k];
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['init.defaultBranch', 'main'], ['core.autocrlf', 'true']]) execFileSync('git', ['config', '--global', k, v], { env });
    const setup = (...args) => execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), 'setup', '--yes', '--no-agents', '--no-hooks', ...args], { env, encoding: 'utf8' });
    const project = (dir, origin) => {
      const r = path.join(h, dir); execFileSync('git', ['init', '-q', r], { env }); execFileSync('git', ['-C', r, 'remote', 'add', 'origin', origin], { env });
      const mem = path.join(h, '.claude', 'projects', r.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
      return { r, mem, sync: () => execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), 'claude', 'start'], { env, input: JSON.stringify({ cwd: r }), encoding: 'utf8' }) };
    };
    return { h, env, setup, project };
  };
  const files = repo => { try { return execFileSync('git', ['--git-dir', repo, 'log', '--all', '--name-only', '--format='], { encoding: 'utf8' }); } catch { return ''; } };

  const A = machine('A');
  assert.match(A.setup('--repo', W, '--for', 'dev.azure.com/acme/*'), /dev\.azure\.com\/acme\/\*/);
  const out = A.setup('--repo', P);
  assert.match(out, /all other projects/);
  const cfgA = JSON.parse(fs.readFileSync(path.join(A.h, '.mem-mastero.json'), 'utf8'));
  assert.deepStrictEqual(cfgA.stores.map(s => !!s.for), [true, false], 'rule-based store first, catch-all last');

  const work = A.project('work-app', 'https://acme@dev.azure.com/acme/shop/_git/app'), hobby = A.project('hobby', 'git@github.com:me/hobby.git');
  put(work.mem, '- work fact\n'); put(hobby.mem, '- hobby fact\n');
  work.sync(); hobby.sync();
  assert(files(W).includes('dev.azure.com/acme/shop/_git/app') && !files(W).includes('hobby'), 'work memory only in the work repo');
  assert(files(P).includes('github.com/me/hobby') && !files(P).includes('acme'), 'personal memory only in the personal repo');

  // Machine B (a work laptop): just the repo; the project rules come from the repo itself.
  const B = machine('B');
  assert.match(B.setup('--repo', W), /dev\.azure\.com\/acme\/\*/, 'rules restored from the store');
  const bWork = B.project('code/app', 'git@ssh.dev.azure.com:v3/acme/shop/app'), bHobby = B.project('hobby', 'https://github.com/me/hobby');
  assert.match(bWork.sync(), /pulled 1/);
  assert.strictEqual(fs.readFileSync(bWork.mem, 'utf8'), '- work fact\n');
  assert.match(bHobby.sync(), /isn't synced/, 'personal projects stay off the work laptop');

  // Upgrade: a v0.7 clone checked out with autocrlf=true becomes byte-exact, keeping file mtimes (newest-wins depends on them).
  const C = machine('C');
  const legacy = path.join(C.h, '.mem-mastero', 'repo'), f = path.join(legacy, 'projects', 'x', 's.jsonl');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=true', P, legacy], { env: C.env, stdio: 'ignore' });
  const LF = '{"a":1}\n{"b":2}\n';
  put(f, LF);
  execFileSync('git', ['-C', legacy, 'add', '-A'], { env: C.env, stdio: 'ignore' }); execFileSync('git', ['-C', legacy, 'commit', '-qm', 'x'], { env: C.env, stdio: 'ignore' });
  fs.rmSync(f); execFileSync('git', ['-C', legacy, 'checkout', '-q', '--', '.'], { env: C.env }); // checkout converts to CRLF
  assert(fs.readFileSync(f, 'utf8').includes('\r\n'), 'precondition: CRLF checkout');
  const old = new Date('2026-01-02T03:04:05Z'); fs.utimesSync(f, old, old);
  C.setup('--repo', P);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), LF, 'byte-exact after upgrade');
  assert.strictEqual(fs.statSync(f).mtimeMs, old.getTime(), 'mtime kept');
  fs.rmSync(g, { recursive: true, force: true });
}
