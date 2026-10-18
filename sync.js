#!/usr/bin/env node
// mem-mastero: sync each repo's coding-agent sessions/memory across machines via Google Drive or a private GitHub repo.
// Usage (from hooks, hook JSON on stdin): node sync.js <claude|codex|copilot> <start|push|pull>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SLACK_MS = 2000; // Drive rounds mtimes; anything within 2s counts as "same"

// --- Big files: GitHub rejects files over 100 MB, so in the synced folder a big session X is stored as
// X.parts/manifest.json + X.parts/part-001.jsonl, ... Parts are cut at line ends, so each one is valid JSONL
// that agents and humans can read on its own. Agents never see parts: pulling rebuilds the original X.
const PART_BYTES = Number(process.env.MEM_MASTERO_PART_BYTES) || 45 * 1024 * 1024; // under GitHub's 50 MB warning
const partsDir = p => p + '.parts';
const manifestOf = p => path.join(partsDir(p), 'manifest.json');
const sha256 = buf => require('crypto').createHash('sha256').update(buf).digest('hex');

function manifestTime(p) {
  try { return fs.statSync(manifestOf(p)).mtimeMs; } catch { return -Infinity; }
}
function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return manifestTime(p); }
}

// ponytail: whole file in memory; stream it if sessions reach GBs.
function writeParts(d, buf) {
  fs.rmSync(d, { force: true });
  fs.rmSync(partsDir(d), { recursive: true, force: true });
  fs.mkdirSync(partsDir(d), { recursive: true });
  const parts = [];
  for (let start = 0; start < buf.length;) {
    let end = Math.min(start + PART_BYTES, buf.length);
    if (end < buf.length) { const nl = buf.lastIndexOf(0x0a, end - 1); if (nl >= start) end = nl + 1; } // a single line longer than a part gets cut mid-line
    const name = `part-${String(parts.length + 1).padStart(3, '0')}${path.extname(d)}`;
    fs.writeFileSync(path.join(partsDir(d), name), buf.subarray(start, end));
    parts.push(name);
    start = end;
  }
  fs.writeFileSync(manifestOf(d), JSON.stringify({
    note: 'Split by mem-mastero to stay under GitHub\'s 100 MB file limit. Concatenate the parts in order to rebuild the original file.',
    file: path.basename(d), bytes: buf.length, sha256: sha256(buf), parts,
  }, null, 2) + '\n');
}

// The original bytes of p, rebuilt from parts if needed. null if parts are missing or don't match (half-synced).
function readWhole(p) {
  if (fs.existsSync(p)) return fs.readFileSync(p);
  try {
    const m = JSON.parse(fs.readFileSync(manifestOf(p), 'utf8'));
    const buf = Buffer.concat(m.parts.map(f => fs.readFileSync(path.join(partsDir(p), path.basename(f)))));
    return sha256(buf) === m.sha256 ? buf : null;
  } catch { return null; }
}

// Copy s -> d if d is missing or older. Keeps s's mtime on d so the next run sees "same", not "newer".
// toRemote: d is in the synced folder, so files over PART_BYTES are stored as parts.
function syncFile(s, d, toRemote = true) {
  const sm = mtimeOf(s);
  if (sm === -Infinity) return false;
  const split = toRemote && fs.existsSync(s) && fs.statSync(s).size > PART_BYTES;
  // Split: compare against the parts only, so an old whole copy of d (e.g. git-ignored) still gets converted.
  const dm = split ? manifestTime(d) : mtimeOf(d);
  if (sm <= dm + SLACK_MS) return false;
  fs.mkdirSync(path.dirname(d), { recursive: true });
  if (split) {
    writeParts(d, fs.readFileSync(s));
    fs.utimesSync(manifestOf(d), new Date(), new Date(sm));
  } else {
    if (fs.existsSync(s)) fs.copyFileSync(s, d);
    else { const buf = readWhole(s); if (!buf) return false; fs.writeFileSync(d, buf); }
    if (fs.existsSync(partsDir(d))) fs.rmSync(partsDir(d), { recursive: true, force: true });
    fs.utimesSync(d, new Date(), new Date(sm));
  }
  return true;
}

// Relative paths of every file under dir; a split file's X.parts/ folder counts as the one file X.
// Lock files are machine-local (Copilot's inuse.<pid>.lock/.hold mark a session open on *this* PC): never synced.
const LOCAL_ONLY = /\.(lock|hold)$/;
function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (LOCAL_ONLY.test(e.name)) continue;
    if (e.isDirectory() && e.name.endsWith('.parts') && fs.existsSync(path.join(dir, r, 'manifest.json'))) {
      if (!fs.existsSync(path.join(dir, r.slice(0, -6)))) out.push(r.slice(0, -6));
    } else if (e.isDirectory()) walk(dir, r, out); else if (e.isFile()) out.push(r);
  }
  return out;
}

// Copy every file in src that is missing or newer in dst. Returns relative paths copied.
// ponytail: never deletes, so a memory pruned on one machine comes back from another. Add tombstones if that bites.
const syncDir = (src, dst, toRemote = true) => walk(src).filter(r => syncFile(path.join(src, r), path.join(dst, r), toRemote));

// git@github.com:o/r.git and https://github.com/o/r -> github.com/o/r
function normalizeRemote(url) {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d+\/)/, '/')
    .replace(/:\d+\//, '/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
    // Azure Repos: SSH and legacy visualstudio.com URLs -> the https form dev.azure.com/org/project/_git/repo
    .replace(/^(?:vs-)?ssh\.(?:dev\.azure\.com|visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/, 'dev.azure.com/$1/$2/_git/$3')
    .replace(/^([^/.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/, 'dev.azure.com/$1/$2/_git/$3');
}

const ids = new Map();
function repoId(cwd) {
  if (!cwd) return null;
  if (!ids.has(cwd)) {
    let id = null;
    try {
      const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (url.trim()) id = normalizeRemote(url);
    } catch {}
    ids.set(cwd, id);
  }
  return ids.get(cwd);
}

// The working directory a session file records near its top (Codex session_meta, Copilot session start).
// Regex, not JSON.parse: the first line can be huge and only its head is read.
function headCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m && JSON.parse(`"${m[1]}"`);
  } catch { return null; }
}

// Copilot CLI records a session's folder in workspace.yaml (`cwd: C:\path`); older builds only in events.jsonl.
function copilotCwd(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8').match(/^cwd:\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2');
  } catch {}
  return headCwd(path.join(dir, 'events.jsonl'));
}

const home = (env, dir) => process.env[env] || path.join(os.homedir(), dir);
const inside = r => r && !r.startsWith('..') && !path.isAbsolute(r);

// Where each agent keeps its sessions locally, and where they live in the synced folder.
const AGENTS = {
  // One folder per project: ~/.claude/projects/<encoded cwd>/{*.jsonl, memory/}
  claude: {
    remote: id => ['projects', ...id.split('/')],
    local(input, cwd) {
      if (input.transcript_path) return path.dirname(input.transcript_path);
      // From a git hook: reuse Claude's folder even if the drive letter case differs (d--App vs D--App).
      const root = path.join(home('CLAUDE_CONFIG_DIR', '.claude'), 'projects'), name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      let hit;
      try { hit = fs.readdirSync(root).find(d => d.toLowerCase() === name.toLowerCase()); } catch {}
      return path.join(root, hit || name);
    },
    push: c => syncDir(c.local, c.remote),
  },
  // All projects mixed: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl, cwd in the first line.
  codex: {
    remote: id => ['codex', 'projects', ...id.split('/')],
    local: () => path.join(home('CODEX_HOME', '.codex'), 'sessions'),
    push(c) {
      const current = c.mode === 'push' && c.input.transcript_path && path.relative(c.local, c.input.transcript_path);
      const files = inside(current) ? [current] // per turn: just this session
        : walk(c.local).filter(r => r.endsWith('.jsonl') && repoId(headCwd(path.join(c.local, r))) === c.id);
      return files.filter(r => syncFile(path.join(c.local, r), path.join(c.remote, r)));
    },
  },
  // One folder per session: $COPILOT_HOME/session-state/<sessionId>/events.jsonl (+ checkpoints, plan, files).
  copilot: {
    remote: id => ['copilot', 'projects', ...id.split('/')],
    local: () => path.join(home('COPILOT_HOME', '.copilot'), 'session-state'),
    push(c) {
      const sid = c.input.sessionId || c.input.session_id;
      let dirs = [];
      if (c.mode === 'push' && sid) dirs = [sid];
      else try { dirs = fs.readdirSync(c.local).filter(d => repoId(copilotCwd(path.join(c.local, d))) === c.id); } catch {}
      return dirs.filter(inside).flatMap(d => syncDir(path.join(c.local, d), path.join(c.remote, d)).map(r => path.join(d, r)));
    },
  },
  // One folder per cwd: ~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl, cwd in the header line.
  // Pulled sessions land in this machine's folder for the repo, so Pi's /resume lists them.
  pi: {
    remote: id => ['pi', 'projects', ...id.split('/')],
    local: (input, cwd) => input.session_dir || path.join(
      process.env.PI_CODING_AGENT_SESSION_DIR || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions'),
      `--${cwd.replace(/^[\\/]+/, '').replace(/[\\/:]/g, '-')}--`),
    push(c) {
      const root = path.dirname(c.local);
      const current = c.mode === 'push' && c.input.transcript_path && path.relative(root, c.input.transcript_path);
      const files = inside(current) ? [current]
        : walk(root).filter(r => r.endsWith('.jsonl') && repoId(headCwd(path.join(root, r))) === c.id);
      return files.filter(r => syncFile(path.join(root, r), path.join(c.remote, path.basename(r)))).map(r => path.basename(r));
    },
  },
};

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mem-mastero.json'), 'utf8')); } catch { return {}; }
}

function driveRoot(cfg) {
  if (process.env.MEM_MASTERO_DIR) return process.env.MEM_MASTERO_DIR;
  if (cfg.dir) return cfg.dir;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const l of 'GHIJKLMNOPQRSTUVWXYZDEF') candidates.push(`${l}:\\My Drive`);
  }
  const cs = path.join(os.homedir(), 'Library', 'CloudStorage');
  try { for (const n of fs.readdirSync(cs)) if (n.startsWith('GoogleDrive-')) candidates.push(path.join(cs, n, 'My Drive')); } catch {}
  candidates.push(path.join(os.homedir(), 'Google Drive', 'My Drive'), path.join(os.homedir(), 'My Drive'));
  const hit = candidates.find(p => fs.existsSync(p));
  return hit && path.join(hit, 'mem-mastero');
}

// --- GitHub backend: one local clone of the user's private repo, same layout as the Drive folder.
const BASE = () => path.join(os.homedir(), '.mem-mastero');
const CLONE = () => path.join(BASE(), 'repo');
// MEM_MASTERO_INHIBIT: our own git calls must not trigger mem-mastero's global git hooks (recursion).
const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', MEM_MASTERO_INHIBIT: '1' });
// Fixed identity: commits/rebases must work on machines with no git user configured.
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=mem-mastero', '-c', 'user.email=mem-mastero@localhost', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV(),
});

function githubClone(url) {
  const dir = CLONE();
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '-q', url, dir], { stdio: 'ignore', env: GIT_ENV() });
  }
  return dir;
}

// One sync at a time per clone: agent hooks, git hooks and background pushes can overlap,
// and a second pullPush would abort the first one's rebase. Waits up to 30s; a lock older than 2 min is stale.
function withLock(dir, fn) {
  const lock = path.join(dir, '.git', 'mem-mastero.lock');
  for (let waited = 0; ; waited += 250) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch {}
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 120000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
    if (waited >= 30000) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  try { fn(); return true; } finally { fs.rmSync(lock, { force: true }); }
}

function commit(dir) {
  git(dir, 'add', '-A');
  try { git(dir, 'commit', '-q', '-m', `mem-mastero: ${os.hostname()}`); } catch {} // nothing to commit
}

// Same file edited on two machines: -X theirs keeps the commit being replayed, i.e. this machine's copy.
function pullPush(dir) {
  try { git(dir, 'pull', '-q', '--rebase', '-X', 'theirs'); } catch { // empty remote, offline, or unresolvable rebase
    try { git(dir, 'rebase', '--abort'); } catch {}
  }
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD'); // throws when offline/behind; the next sync retries
}

function readStdin() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  // Troubleshooting: MEM_MASTERO_LOG=<file> records what each agent's hook sent.
  if (process.env.MEM_MASTERO_LOG) fs.appendFileSync(process.env.MEM_MASTERO_LOG, JSON.stringify({ at: new Date().toISOString(), argv: process.argv.slice(2), input }) + '\n');
  return input;
}

// Sync the given agents for one repo. mode: start (pull+push), push, pull. loud: always print the summary.
function run(names, mode, input, loud = mode === 'start') {
  const cfg = readConfig();
  const cwd = input.cwd || process.cwd();
  const say = msg => { if (loud || process.stdout.isTTY) console.log(`mem-mastero: ${msg}`); };

  const id = repoId(cwd);
  if (!id) return say('no git "origin" remote in this folder, so sync is skipped (the remote URL is how projects are matched across machines).');

  // MEM_MASTERO_DIR (env) beats the config file, so one shell can sync somewhere else (e.g. a test folder).
  const github = !process.env.MEM_MASTERO_DIR && cfg.github;
  const root = github ? githubClone(cfg.github) : driveRoot(cfg);
  if (!root) return say('no sync target. Install Google Drive for Desktop, or set ~/.mem-mastero.json {"dir": "..."} or {"github": "<private repo url>"}. Sync skipped.');
  if (mode === 'start' && fs.existsSync(path.join(BASE(), 'git-hooks'))) refreshHookScript();

  const work = () => {
    const jobs = names.map(name => {
      const agent = AGENTS[name];
      const c = { input, cwd, id, mode, local: agent.local(input, cwd), remote: path.join(root, ...agent.remote(id)) };
      // Push first: with GitHub, local edits get committed so git (not mtimes) merges them with other machines' work.
      return { name, c, pushed: mode === 'pull' ? [] : agent.push(c) };
    });
    if (github) {
      commit(root);
      if (mode === 'push') {
        if (jobs.some(j => j.pushed.length)) spawn(process.execPath, [__filename, 'gitpush'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else pullPush(root); // git rewrites mtimes of files it updates, so they count as newer than local
    }
    for (const { name, c, pushed } of jobs) {
      const pulled = mode === 'push' ? [] : syncDir(c.remote, c.local, false);
      if (loud && mode !== 'start' && !pulled.length && !pushed.length) continue;
      say(`${name} ${id} (${github ? 'GitHub' : 'Drive'}): pulled ${pulled.length}, pushed ${pushed.length} file(s).`);
      // Claude may have loaded MEMORY.md before this hook ran, so hand the fresh copy to the session directly.
      const mem = path.join('memory', 'MEMORY.md');
      if (mode === 'start' && pulled.includes(mem)) {
        console.log(`Memory was updated from another device. Current ${path.join(c.local, mem)}:\n${fs.readFileSync(path.join(c.local, mem), 'utf8')}`);
      }
    }
  };
  if (!github) return work();
  if (!withLock(root, work)) say('another sync is still running; skipped this one (the next sync catches up).');
}

// --- Git hooks: sync with `git push` / `git pull` / `git clone` in every repo, for every agent.
// Installed as a global core.hooksPath. Every standard hook name gets a shim that runs the repo's own
// .git/hooks/<name> afterwards, so existing hooks (LFS, pre-commit, ...) keep working.
const HOOK_NAMES = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive',
  'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'];
const SYNC_HOOKS = ['pre-push', 'post-merge', 'post-rewrite', 'post-checkout'];
const hooksDir = () => path.join(BASE(), 'git-hooks');
const fwd = p => p.replace(/\\/g, '/');
const globalGit = (...args) => { try { return execFileSync('git', ['config', '--global', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

// Hooks call a stable copy of this script, so plugin updates (new cache paths) don't break them.
function refreshHookScript() {
  const dst = path.join(BASE(), 'sync.js');
  try { if (fs.readFileSync(dst, 'utf8') === fs.readFileSync(__filename, 'utf8')) return; } catch {}
  fs.copyFileSync(__filename, dst);
}

function installGitHooks() {
  const cur = globalGit('--get', 'core.hooksPath');
  if (cur && path.resolve(cur) !== path.resolve(hooksDir())) {
    return console.log(`mem-mastero: git's global core.hooksPath is already "${cur}". Not changing it; git hooks not installed.`);
  }
  fs.mkdirSync(hooksDir(), { recursive: true });
  refreshHookScript();
  const node = fwd(process.execPath), script = fwd(path.join(BASE(), 'sync.js'));
  for (const name of HOOK_NAMES) {
    const ours = SYNC_HOOKS.includes(name)
      ? `[ -z "$MEM_MASTERO_INHIBIT" ] && "${node}" "${script}" git ${name} "$@" </dev/null || true\n` : '';
    fs.writeFileSync(path.join(hooksDir(), name),
      `#!/bin/sh\n# mem-mastero global git hook. Runs this repo's own .git/hooks/${name} afterwards.\n${ours}` +
      // No git dir yet (e.g. reference-transaction during `git init`): nothing of the repo's own to run.
      `gd="$(git rev-parse --git-dir 2>/dev/null)" || exit 0\nown="$gd/hooks/${name}"\n[ -x "$own" ] && exec "$own" "$@"\nexit 0\n`, { mode: 0o755 });
  }
  execFileSync('git', ['config', '--global', 'core.hooksPath', fwd(hooksDir())]);
  console.log(`mem-mastero: git hooks installed (${fwd(hooksDir())}). Undo: node "${script}" uninstall-git-hooks`);
}

function uninstallGitHooks() {
  const cur = globalGit('--get', 'core.hooksPath');
  if (cur && path.resolve(cur) === path.resolve(hooksDir())) globalGit('--unset', 'core.hooksPath');
  fs.rmSync(hooksDir(), { recursive: true, force: true });
  console.log('mem-mastero: git hooks removed.');
}

// Called by the shims. push: before `git push` (in the background, so the push isn't slowed down).
// pull: after `git pull` (merge or rebase) and after `git clone`. `git fetch` has no hook.
function gitHook(name, args) {
  let top;
  try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return; }
  if (path.resolve(top).toLowerCase() === path.resolve(CLONE()).toLowerCase()) return; // the memory repo itself
  if (name === 'pre-push') {
    return spawn(process.execPath, [__filename, 'git-bg-push', top], { detached: true, stdio: 'ignore', windowsHide: true, env: GIT_ENV() }).unref();
  }
  const pull = name === 'post-merge' || (name === 'post-rewrite' && args[0] === 'rebase') || (name === 'post-checkout' && /^0+$/.test(args[0] || ''));
  if (pull) run(Object.keys(AGENTS), 'pull', { cwd: top }, true);
}

module.exports = { syncDir, normalizeRemote, headCwd, AGENTS };

// Git runs hooks with repo-local variables (GIT_DIR, GIT_INDEX_FILE, ...) pointing at the repo being pushed.
// Inherited, they would aim every git call here, including commit/push of the memory repo, at *that* repo
// (this leaked memory into a public repo once). Clear them first: `git rev-parse --local-env-vars`.
const GIT_LOCAL_ENV = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH'];

if (require.main === module) {
  for (const k of GIT_LOCAL_ENV) delete process.env[k];
  const [a, b, ...rest] = process.argv.slice(2);
  try {
    if (a === 'gitpush' || b === 'gitpush') { const dir = githubClone(readConfig().github); withLock(dir, () => pullPush(dir)); } // background push
    else if (a === 'install-git-hooks') installGitHooks();
    else if (a === 'uninstall-git-hooks') uninstallGitHooks();
    else if (a === 'git') gitHook(b, rest);
    else if (a === 'git-bg-push') run(Object.keys(AGENTS), 'push', { cwd: b });
    else if (AGENTS[a]) run([a], b || 'start', readStdin());
    else run(['claude'], a || 'start', readStdin());
  } catch (e) { console.error(`mem-mastero: ${e.message}`); }
  process.exit(0); // never block the session or the git command
}
