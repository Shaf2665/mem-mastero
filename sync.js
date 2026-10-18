#!/usr/bin/env node
// mem-mastero: mirror ~/.claude/projects/<project> <-> <Google Drive>/mem-mastero/projects/<repo-id>
// Usage (from hooks, hook JSON on stdin): node sync.js start|push|pull
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SLACK_MS = 2000; // Drive rounds mtimes; anything within 2s counts as "same"

// Copy every file in src that is missing or newer in dst. Returns relative paths copied.
// ponytail: never deletes, so a memory pruned on one machine comes back from another. Add tombstones if that bites.
function syncDir(src, dst, rel = '', copied = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true }); } catch { return copied; }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { syncDir(src, dst, r, copied); continue; }
    if (!e.isFile()) continue;
    const s = path.join(src, r), d = path.join(dst, r);
    const sm = fs.statSync(s).mtimeMs;
    let dm = -Infinity;
    try { dm = fs.statSync(d).mtimeMs; } catch {}
    if (sm <= dm + SLACK_MS) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    fs.utimesSync(d, new Date(), new Date(sm)); // keep source mtime so the next run sees "same", not "newer"
    copied.push(r);
  }
  return copied;
}

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

function repoId(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (url.trim()) return normalizeRemote(url);
  } catch {}
  return null;
}

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

function main(mode) {
  const input = readStdin();
  const cwd = input.cwd || process.cwd();
  const local = input.transcript_path
    ? path.dirname(input.transcript_path)
    : path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const say = msg => { if (mode === 'start' || process.stdout.isTTY) console.log(`mem-mastero: ${msg}`); };

  const cfg = readConfig();
  if (mode === 'gitpush') return pullPush(githubClone(cfg.github)); // detached child of a Stop hook

  const id = repoId(cwd);
  if (!id) return say('no git "origin" remote in this folder, so sync is skipped (the remote URL is how projects are matched across machines).');

  let pulled = [], pushed = [];
  if (cfg.github) {
    const clone = githubClone(cfg.github);
    const remote = path.join(clone, 'projects', ...id.split('/'));
    // Push local edits into the clone and commit them first, so git (not mtimes) merges them with other machines' work.
    if (mode !== 'pull') { pushed = syncDir(local, remote); commit(clone); }
    if (mode === 'push') {
      if (pushed.length) spawn(process.execPath, [__filename, 'gitpush'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      pullPush(clone); // git rewrites mtimes of files it updates, so they count as newer than local
      pulled = syncDir(remote, local);
    }
    say(`${id} (GitHub): pulled ${pulled.length}, pushed ${pushed.length} file(s).`);
  } else {
    const root = driveRoot(cfg);
    if (!root) return say('no sync target. Install Google Drive for Desktop, or set ~/.mem-mastero.json {"dir": "..."} or {"github": "<private repo url>"}. Sync skipped.');
    const remote = path.join(root, 'projects', ...id.split('/'));
    pulled = mode === 'push' ? [] : syncDir(remote, local);
    pushed = mode === 'pull' ? [] : syncDir(local, remote);
    say(`${id}: pulled ${pulled.length}, pushed ${pushed.length} file(s).`);
  }

  // MEMORY.md may already be loaded before this hook ran, so hand the fresh copy to the session directly.
  const mem = path.join('memory', 'MEMORY.md');
  if (mode === 'start' && pulled.includes(mem)) {
    console.log(`Memory was updated from another device. Current ${path.join(local, mem)}:\n${fs.readFileSync(path.join(local, mem), 'utf8')}`);
  }
}

module.exports = { syncDir, normalizeRemote };

if (require.main === module) {
  try { main(process.argv[2] || 'start'); } catch (e) { console.error(`mem-mastero: ${e.message}`); }
  process.exit(0); // never block the session
}
