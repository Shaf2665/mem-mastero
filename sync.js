#!/usr/bin/env node
// mem-mastero: sync each repo's coding-agent sessions/memory across machines via Google Drive or a private GitHub repo.
// Usage (from hooks, hook JSON on stdin): node sync.js <claude|codex|copilot> <start|push|pull>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SLACK_MS = 2000; // Drive rounds mtimes; anything within 2s counts as "same"

// Copy s -> d if d is missing or older. Keeps s's mtime on d so the next run sees "same", not "newer".
function syncFile(s, d) {
  let sm, dm = -Infinity;
  try { sm = fs.statSync(s).mtimeMs; } catch { return false; }
  try { dm = fs.statSync(d).mtimeMs; } catch {}
  if (sm <= dm + SLACK_MS) return false;
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  fs.utimesSync(d, new Date(), new Date(sm));
  return true;
}

// Relative paths of every file under dir.
function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walk(dir, r, out); else if (e.isFile()) out.push(r);
  }
  return out;
}

// Copy every file in src that is missing or newer in dst. Returns relative paths copied.
// ponytail: never deletes, so a memory pruned on one machine comes back from another. Add tombstones if that bites.
const syncDir = (src, dst) => walk(src).filter(r => syncFile(path.join(src, r), path.join(dst, r)));

// git@github.com:o/r.git and https://github.com/o/r -> github.com/o/r
function normalizeRemote(url) {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d+\/)/, '/')
    .replace(/:\d+\//, '/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
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

const home = (env, dir) => process.env[env] || path.join(os.homedir(), dir);
const inside = r => r && !r.startsWith('..') && !path.isAbsolute(r);

// Where each agent keeps its sessions locally, and where they live in the synced folder.
const AGENTS = {
  // One folder per project: ~/.claude/projects/<encoded cwd>/{*.jsonl, memory/}
  claude: {
    remote: id => ['projects', ...id.split('/')],
    local: (input, cwd) => input.transcript_path
      ? path.dirname(input.transcript_path)
      : path.join(home('CLAUDE_CONFIG_DIR', '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')),
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
      else try { dirs = fs.readdirSync(c.local).filter(d => repoId(headCwd(path.join(c.local, d, 'events.jsonl'))) === c.id); } catch {}
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
// Fixed identity: commits/rebases must work on machines with no git user configured.
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=mem-mastero', '-c', 'user.email=mem-mastero@localhost', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});

function githubClone(url) {
  const dir = path.join(os.homedir(), '.mem-mastero', 'repo');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '-q', url, dir], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  }
  return dir;
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
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main(name, mode) {
  const cfg = readConfig();
  if (mode === 'gitpush') return pullPush(githubClone(cfg.github)); // detached child of a per-turn hook

  const agent = AGENTS[name];
  const input = readStdin();
  const cwd = input.cwd || process.cwd();
  const say = msg => { if (mode === 'start' || process.stdout.isTTY) console.log(`mem-mastero: ${msg}`); };

  const id = repoId(cwd);
  if (!id) return say('no git "origin" remote in this folder, so sync is skipped (the remote URL is how projects are matched across machines).');

  const root = cfg.github ? githubClone(cfg.github) : driveRoot(cfg);
  if (!root) return say('no sync target. Install Google Drive for Desktop, or set ~/.mem-mastero.json {"dir": "..."} or {"github": "<private repo url>"}. Sync skipped.');
  const c = { input, cwd, id, mode, local: agent.local(input, cwd), remote: path.join(root, ...agent.remote(id)) };

  // Push first: with GitHub, local edits get committed so git (not mtimes) merges them with other machines' work.
  const pushed = mode === 'pull' ? [] : agent.push(c);
  if (cfg.github) {
    commit(root);
    if (mode === 'push') {
      if (pushed.length) spawn(process.execPath, [__filename, name, 'gitpush'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else pullPush(root); // git rewrites mtimes of files it updates, so they count as newer than local
  }
  const pulled = mode === 'push' ? [] : syncDir(c.remote, c.local);
  say(`${name} ${id} (${cfg.github ? 'GitHub' : 'Drive'}): pulled ${pulled.length}, pushed ${pushed.length} file(s).`);

  // Claude may have loaded MEMORY.md before this hook ran, so hand the fresh copy to the session directly.
  const mem = path.join('memory', 'MEMORY.md');
  if (mode === 'start' && pulled.includes(mem)) {
    console.log(`Memory was updated from another device. Current ${path.join(c.local, mem)}:\n${fs.readFileSync(path.join(c.local, mem), 'utf8')}`);
  }
}

module.exports = { syncDir, normalizeRemote, headCwd, AGENTS };

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  try { AGENTS[a] ? main(a, b || 'start') : main('claude', a || 'start'); } catch (e) { console.error(`mem-mastero: ${e.message}`); }
  process.exit(0); // never block the session
}
