// Claude archive inventory and conservative liveness checks. No transcript content is parsed here.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXTRA_ROOTS = ['image-cache', 'uploads', 'dev-mods', 'session-env'];
const categoryNames = ['transcripts', 'companions', 'fileHistory', 'memory', 'otherClaude', 'memRepoWorkingTrees', 'memRepoGit', 'archiveCache', 'otherMem'];
const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const metadataError = (verb, file, error) => new Error(`Cannot ${verb} ${file}: ${error.code || 'filesystem error'}`);

function statOptional(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw metadataError('inspect', file, error); }
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Check each component beneath the explicitly selected root. Traversing a link could archive
// unrelated files or let a later unlink/restore escape the user's Claude directory.
function assertNoLinks(root, file) {
  if (!within(root, file)) throw new Error('Session path is outside the Claude directory');
  const relative = path.relative(root, file);
  let current = root;
  const components = relative ? relative.split(path.sep) : [];
  for (let i = 0; i <= components.length; i++) {
    const st = statOptional(current);
    if (!st) return;
    if (st.isSymbolicLink()) throw new Error(`Refusing symbolic link in session path: ${current}`);
    if (i < components.length && !st.isDirectory()) throw new Error(`Expected session directory: ${current}`);
    if (i < components.length) current = path.join(current, components[i]);
  }
}

function classifyClaude(relative) {
  const pieces = relative.split(path.sep);
  if (pieces[0] === 'file-history') return 'fileHistory';
  if (EXTRA_ROOTS.includes(pieces[0])) return 'companions';
  if (pieces[0] !== 'projects' || pieces.length < 3) return 'otherClaude';
  if (pieces[2] === 'memory') return 'memory';
  if (pieces.length === 3 && pieces[2].endsWith('.jsonl')) return 'transcripts';
  if (pieces.length > 3 && SESSION_ID.test(pieces[2])) return 'companions';
  return 'otherClaude';
}

function classifyMem(relative) {
  const pieces = relative.split(path.sep);
  if (['archive-cache', 'archive-staging', 'recall-cache'].includes(pieces[0])) return 'archiveCache';
  if (pieces[0] === 'repo') return pieces[1] === '.git' ? 'memRepoGit' : 'memRepoWorkingTrees';
  if (pieces[0] === 'repos' && pieces.length >= 3) return pieces[2] === '.git' ? 'memRepoGit' : 'memRepoWorkingTrees';
  return 'otherMem';
}

/** Report logical file sizes, not filesystem allocation/free-space estimates. Links are never followed. */
function scanStorage({ claudeRoot, memRoot }) {
  if (!claudeRoot || !memRoot) throw new Error('Claude and Mem-mastero directories are required');
  const report = {
    measurement: 'logical-file-bytes',
    categories: Object.fromEntries(categoryNames.map(name => [name, { bytes: 0, files: 0 }])),
    totalBytes: 0, totalFiles: 0, errors: [], skippedSymlinks: 0,
  };
  const seen = new Set();
  const roots = [{ root: path.resolve(claudeRoot), classify: classifyClaude }, { root: path.resolve(memRoot), classify: classifyMem }];
  function visit(file, root, classify) {
    const key = canonical(file);
    if (seen.has(key)) return;
    seen.add(key);
    let st;
    try { st = fs.lstatSync(file); }
    catch (error) {
      if (error.code !== 'ENOENT' || canonical(file) !== canonical(root)) report.errors.push({ path: file, message: error.code || 'Cannot inspect file' });
      return;
    }
    if (st.isSymbolicLink()) { report.skippedSymlinks++; return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(file); }
      catch (error) { report.errors.push({ path: file, message: error.code || 'Cannot read directory' }); return; }
      for (const entry of entries) visit(path.join(file, entry), root, classify);
    } else if (st.isFile()) {
      const category = report.categories[classify(path.relative(root, file))];
      category.bytes += st.size;
      category.files++;
      report.totalBytes += st.size;
      report.totalFiles++;
    } else report.errors.push({ path: file, message: 'Unsupported filesystem entry' });
  }
  // A nested root is counted using its own categories, once, before its parent is walked.
  roots.sort((a, b) => b.root.length - a.root.length);
  for (const { root, classify } of roots) visit(root, root, classify);
  return report;
}

/** Discover intact native bundles without parsing JSONL or treating auto-memory as a session. */
function discoverSessions({ claudeRoot, projectDir, sessionId }) {
  if (!claudeRoot || !projectDir) throw new Error('Claude and project directories are required');
  claudeRoot = path.resolve(claudeRoot);
  projectDir = path.resolve(projectDir);
  if (canonical(path.dirname(projectDir)) !== canonical(path.join(claudeRoot, 'projects'))) throw new Error('Expected a project directory directly under Claude projects');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw new Error('Invalid session ID');
  assertNoLinks(claudeRoot, projectDir);
  const projectStat = statOptional(projectDir);
  if (!projectStat) return [];
  if (!projectStat.isDirectory()) throw new Error('Expected a Claude project directory');
  let entries;
  try { entries = fs.readdirSync(projectDir); }
  catch (error) { throw metadataError('read project directory', projectDir, error); }
  const ids = entries.filter(name => name.endsWith('.jsonl') && SESSION_ID.test(name.slice(0, -6))).map(name => name.slice(0, -6));
  const sessions = [];
  for (const id of ids.sort()) {
    if (sessionId !== undefined && id !== sessionId) continue;
    const files = [];
    function add(file) {
      assertNoLinks(claudeRoot, file);
      const st = statOptional(file);
      if (!st) throw new Error(`Session changed during discovery: ${file}`);
      const name = path.basename(file);
      if (/\.(?:lock|hold|tmp|temp)$/i.test(name) || /^\.mem-mastero-/i.test(name)) throw new Error(`Refusing session with lock or temporary file: ${file}`);
      if (st.isDirectory()) {
        let children;
        try { children = fs.readdirSync(file); }
        catch (error) { throw metadataError('read session directory', file, error); }
        for (const child of children.sort()) add(path.join(file, child));
      } else if (st.isFile()) {
        files.push({ path: file, relative: path.relative(claudeRoot, file).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777 });
      } else throw new Error(`Unsupported session filesystem entry: ${file}`);
    }
    const transcript = path.join(projectDir, `${id}.jsonl`);
    const transcriptStat = statOptional(transcript);
    if (!transcriptStat || !transcriptStat.isFile()) throw new Error(`Expected regular session transcript: ${transcript}`);
    add(transcript);
    const sidecars = [path.join(projectDir, id), path.join(claudeRoot, 'file-history', id), ...EXTRA_ROOTS.map(root => path.join(claudeRoot, root, id)), ...['json', 'env'].map(ext => path.join(claudeRoot, 'session-env', `${id}.${ext}`))];
    for (const sidecar of sidecars) {
      assertNoLinks(claudeRoot, sidecar);
      if (statOptional(sidecar)) add(sidecar);
    }
    sessions.push({ sessionId: id, files, bytes: files.reduce((sum, file) => sum + file.size, 0), lastModifiedMs: Math.max(...files.map(file => file.mtimeMs)) });
  }
  return sessions;
}

function scanProcesses() {
  if (process.platform === 'win32') {
    // JSON handles spaces and Unicode in executable paths. Never print command lines: they
    // can contain user prompts. No user-controlled strings are interpolated into this script.
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress";
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const records = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!Array.isArray(records) || records.length === 0) throw new Error('Unexpected process inventory');
    return records.map(record => ({ pid: record.ProcessId, name: record.Name, commandLine: record.CommandLine }));
  }
  const raw = execFileSync('ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = raw.split('\n').filter(line => line.trim());
  if (!lines.length) throw new Error('Unexpected process inventory');
  return lines.map(line => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) throw new Error('Unexpected process inventory');
    return { pid: Number(match[1]), name: match[2], commandLine: match[3] };
  });
}

function isClaudeProcess(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid < 0 || typeof record.name !== 'string' || !record.name) throw new Error('Cannot verify process identity');
  const name = record.name.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (/^claude(?:$|[-_. ])/.test(name)) return true;
  if (/^(?:node|nodejs|bun|npm|npx)$/.test(name)) {
    if (typeof record.commandLine !== 'string' || !record.commandLine.trim()) throw new Error('Cannot determine whether a JavaScript process is running Claude');
    const command = record.commandLine.toLowerCase();
    // npm's global bin can remain a symlink named simply "claude" in argv,
    // rather than resolving to node_modules/@anthropic-ai/claude-code/cli.js.
    return /(?:^|[\\/\s"'])claude-code(?:[\\/\s"']|\.js(?:\s|$))/.test(command)
      || /(?:^|[\\/\s"'])claude(?:\.[cm]?js)?(?=[\s"']|$)/.test(command)
      || /[\\/]claude\.app[\\/]/i.test(command);
  }
  return false;
}

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Explicit archive/restore requires all Claude applications to be stopped. Ambiguity blocks deletion. */
function assertClaudeStopped({ claudeRoot, processScanner = scanProcesses, pidAlive = defaultPidAlive }) {
  if (!claudeRoot) throw new Error('Claude directory is required');
  claudeRoot = path.resolve(claudeRoot);
  assertNoLinks(claudeRoot, claudeRoot);
  let processes;
  try {
    processes = processScanner();
    if (!Array.isArray(processes) || processes.some(record => !record || !Number.isInteger(record.pid))) throw new Error('Invalid process list');
    for (const record of processes) {
      if (isClaudeProcess(record)) throw Object.assign(new Error('Claude is still running. Close Claude Code and Claude desktop before archiving or restoring sessions.'), { claudeBusy: true });
    }
  } catch (error) {
    if (error.claudeBusy) throw error;
    throw new Error('Cannot verify that Claude processes have stopped; archive/restore refused.');
  }
  const recordsDir = path.join(claudeRoot, 'sessions');
  assertNoLinks(claudeRoot, recordsDir);
  const st = statOptional(recordsDir);
  if (!st) return;
  if (!st.isDirectory()) throw new Error('Cannot verify Claude session records directory');
  let entries;
  try { entries = fs.readdirSync(recordsDir); }
  catch { throw new Error('Cannot read Claude session records; archive/restore refused.'); }
  for (const name of entries) {
    const file = path.join(recordsDir, name);
    assertNoLinks(claudeRoot, file);
    const recordStat = statOptional(file);
    if (!recordStat) continue; // A process that exited may have removed its own record.
    if (!name.endsWith('.json') || !recordStat.isFile() || recordStat.size > 1024 * 1024) throw new Error('Cannot verify unfamiliar Claude session record; archive/restore refused.');
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('Cannot read Claude session record; archive/restore refused.'); }
    if (!record || !Number.isInteger(record.pid) || record.pid < 1 || record.pid > 2147483647) throw new Error('Cannot verify Claude session record PID; archive/restore refused.');
    let alive;
    try { alive = pidAlive(record.pid); if (typeof alive !== 'boolean') throw new Error('Unknown process state'); }
    catch { throw new Error('Cannot verify a Claude session process; archive/restore refused.'); }
    if (alive) throw new Error('A Claude session is still active. Close it before archiving or restoring sessions.');
  }
}

module.exports = { scanStorage, discoverSessions, assertClaudeStopped };
