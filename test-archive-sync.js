// Real CLI + Git integration using synthetic sessions, isolated homes, and a local bare remote.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const { writeState } = require('./archive-state');
const { normalizeRemote } = require('./sync');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-archive-sync-')));
const userHome = path.join(root, 'home'), project = path.join(root, 'project');
const claudeRoot = path.join(userHome, '.claude'), memRoot = path.join(userHome, '.mem-mastero');
const remote = path.join(root, 'remote.git'), seed = path.join(root, 'seed');
const projectId = 'github.com/example/archive-project';
const projectDir = path.join(claudeRoot, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
const store = { github: pathToFileURL(remote).href };
const sync = path.join(__dirname, 'sync.js');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(GIT_|MEM_MASTERO_|PI_CODING_AGENT_|CODEX_HOME$|COPILOT_HOME$|CLAUDE_CONFIG_DIR$)/i.test(key)) delete env[key];
}
Object.assign(env, {
  HOME: userHome, USERPROFILE: userHome, TEMP: root, TMP: root,
  CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: path.join(userHome, '.codex'), COPILOT_HOME: path.join(userHome, '.copilot'),
  PI_CODING_AGENT_DIR: path.join(userHome, '.pi', 'agent'),
  GIT_CONFIG_GLOBAL: path.join(root, 'global.gitconfig'), GIT_CONFIG_SYSTEM: path.join(root, 'system.gitconfig'),
  GIT_TERMINAL_PROMPT: '0', MEM_MASTERO_INHIBIT: '1',
});
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const git = (dir, args, input) => execFileSync('git', ['-C', dir, '-c', 'user.name=archive-test', '-c', 'user.email=archive-test@localhost', '-c', 'core.autocrlf=false', ...args], {
  env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, windowsHide: true,
}).trim();
const cli = (args, script = sync) => execFileSync(process.execPath, [script, ...args], {
  env, cwd: project, input: JSON.stringify({ cwd: project }), encoding: 'utf8', timeout: 60000, windowsHide: true,
});
const revision = 'a'.repeat(64);
const context = { claudeRoot, memRoot, projectDir, projectId, store };

function createColdCommit(content, parent) {
  const blob = git(remote, ['hash-object', '-w', '--stdin'], content);
  const tree = git(remote, ['mktree'], `100644 blob ${blob}\tcold-payload.bin\n`);
  const commit = git(remote, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Synthetic cold archive']);
  git(remote, ['update-ref', 'refs/heads/mem-mastero-archives-v1', commit]);
  return { blob, commit };
}

function assertBlobAbsent(clone, blob, reason) {
  const result = spawnSync('git', ['-C', clone, 'cat-file', '-e', blob], { env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0, reason);
}

try {
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(project); fs.mkdirSync(seed);
  put(env.GIT_CONFIG_SYSTEM, '[core]\n  longpaths = true\n');
  put(env.GIT_CONFIG_GLOBAL, '');
  put(path.join(userHome, '.mem-mastero.json'), JSON.stringify(store));
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(project, ['init', '-q', '--initial-branch=main']);
  git(project, ['remote', 'add', 'origin', `https://${projectId}.git`]);
  git(seed, ['init', '-q', '--initial-branch=main']);
  git(seed, ['remote', 'add', 'origin', store.github]);
  const relativeProject = 'projects/' + projectId;
  put(path.join(seed, relativeProject, 'archived.jsonl'), '{"old":"archived transcript"}\n');
  put(path.join(seed, relativeProject, 'archived', 'subagents', 'agent.jsonl'), '{"old":"subagent"}\n');
  put(path.join(seed, relativeProject, 'current.jsonl'), '{"current":true}\n');
  put(path.join(seed, relativeProject, 'memory', 'MEMORY.md'), '- durable memory\n');
  git(seed, ['add', '.']); git(seed, ['commit', '-qm', 'Seed synthetic memory']); git(seed, ['push', '-qu', 'origin', 'main']);
  const cold = createColdCommit('archive-only binary payload before clone\n');

  writeState(context, { version: 1, sessions: { archived: { revision } } });
  cli(['claude', 'pull']);
  assert(!fs.existsSync(path.join(projectDir, 'archived.jsonl')), 'actual CLI pull must not rehydrate an evicted transcript');
  assert(!fs.existsSync(path.join(projectDir, 'archived')), 'actual CLI pull must not rehydrate an evicted companion directory');
  assert.equal(fs.readFileSync(path.join(projectDir, 'current.jsonl'), 'utf8'), '{"current":true}\n');
  assert.equal(fs.readFileSync(path.join(projectDir, 'memory', 'MEMORY.md'), 'utf8'), '- durable memory\n', 'durable memory continues syncing');
  const clone = path.join(memRoot, 'repos', normalizeRemote(store.github).replace(/[^a-z0-9._-]+/g, '_'));
  assert(fs.existsSync(path.join(clone, '.git')));
  assert.equal(git(clone, ['config', '--get', 'remote.origin.fetch']), '+refs/heads/main:refs/remotes/origin/main');
  assertBlobAbsent(clone, cold.blob, 'initial normal sync clone must not download archive branch blobs');

  // Emulate an old installation's wildcard refspec before another cold archive is added.
  git(clone, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  const nextCold = createColdCommit('archive-only binary payload after clone\n', cold.commit);
  cli(['claude', 'start']);
  assert.equal(git(clone, ['config', '--get', 'remote.origin.fetch']), '+refs/heads/main:refs/remotes/origin/main', 'ordinary sync repairs wildcard fetching before the pull');
  assertBlobAbsent(clone, nextCold.blob, 'repaired normal sync must leave newly archived blobs remote-only');
  assert(!fs.existsSync(path.join(projectDir, 'archived.jsonl')));
  assert(!fs.existsSync(path.join(projectDir, 'archived')));

  // Re-running setup on a legacy clone must also avoid fetching the archive branch.
  git(clone, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  const setupCold = createColdCommit('archive-only payload before repeat setup\n', nextCold.commit);
  cli(['setup', '--repo', store.github, '--yes', '--no-agents', '--no-hooks']);
  assert.equal(git(clone, ['config', '--get', 'remote.origin.fetch']), '+refs/heads/main:refs/remotes/origin/main');
  assertBlobAbsent(clone, setupCold.blob, 'repeat setup must not fetch archive payloads into the local clone');

  // A restored transcript stays protected even when a legacy store copy is newer.
  const restored = path.join(projectDir, 'archived.jsonl');
  const legacy = path.join(clone, relativeProject, 'archived.jsonl');
  put(restored, '{"restored":"verified archive"}\n');
  writeState(context, { version: 1, sessions: { archived: { revision, restoredAt: new Date().toISOString() } } });
  put(legacy, '{"legacy":"newer timestamp but obsolete content"}\n');
  const newer = new Date(Date.now() + 60000); fs.utimesSync(legacy, newer, newer);
  cli(['claude', 'pull']);
  assert.equal(fs.readFileSync(restored, 'utf8'), '{"restored":"verified archive"}\n', 'legacy pull must not replace a restored cloud revision');
  assert(!fs.existsSync(path.join(projectDir, 'archived', 'subagents', 'agent.jsonl')));

  // New local turns in a restored session still reach the ordinary sync store.
  const edited = '{"restored":"verified archive"}\n{"newTurn":true}\n';
  put(restored, edited);
  const newest = new Date(Date.now() + 120000); fs.utimesSync(restored, newest, newest);
  const start = cli(['claude', 'start']);
  assert.match(start, /pushed 1 file/);
  assert.equal(git(remote, ['show', `main:${relativeProject}/archived.jsonl`]), edited.trim(), 'restored local edits are still uploaded');
  assert.equal(fs.readFileSync(restored, 'utf8'), edited);

  put(path.join(claudeRoot, 'debug', 'example.log'), 'debug bytes');
  put(path.join(claudeRoot, 'file-history', 'other-session', 'checkpoint'), 'checkpoint bytes');
  put(path.join(memRoot, 'archive-cache', 'measured.bin'), 'temporary bytes');
  const report = JSON.parse(cli(['storage', '--json']));
  assert.equal(report.measurement, 'logical-file-bytes');
  assert.deepEqual(report.errors, []);
  assert.equal(report.categories.transcripts.bytes, Buffer.byteLength(edited) + Buffer.byteLength('{"current":true}\n'));
  assert.equal(report.categories.memory.bytes, Buffer.byteLength('- durable memory\n'));
  assert.equal(report.categories.fileHistory.bytes, Buffer.byteLength('checkpoint bytes'));
  assert.equal(report.categories.archiveCache.bytes, Buffer.byteLength('temporary bytes'));
  assert(report.categories.memRepoGit.bytes > 0, 'storage accounts for retained .git history');
  assert(report.categories.memRepoWorkingTrees.bytes > 0, 'storage accounts for retained legacy working copies');
  assert.equal(report.totalBytes, Object.values(report.categories).reduce((sum, category) => sum + category.bytes, 0));

  // Installed stable scripts must ship their helper modules and work without the source checkout.
  assert.match(cli(['install-git-hooks']), /git hooks installed/);
  for (const name of ['sync.js', 'archive-state.js', 'archive-store.js', 'claude-files.js', 'archive.js', 'archive-graph.js', 'archive-recall.js', 'archive-access.js',
    'memory-privacy.js', 'memory-store.js', 'memory-capture.js', 'memory-runtime.js', 'memory-import.js', 'memory-view.js', 'memory-command.js', 'memory-mcp.js',
    'memory-ai-provider.js', 'memory-semantic.js', 'memory-summary.js', 'memory-ai-jobs.js', 'memory-copilot-provider.js', 'package.json']) {
    assert(fs.existsSync(path.join(memRoot, name)), `installed stable script needs ${name}`);
  }
  const installedReport = JSON.parse(cli(['storage', '--json'], path.join(memRoot, 'sync.js')));
  const sourceReport = JSON.parse(cli(['storage', '--json']));
  assert.deepEqual(installedReport, sourceReport, 'installed helpers report the same actual fixture storage');
  assert.equal(git(project, ['config', '--global', '--get', 'core.hooksPath']).replace(/\\/g, '/'), path.join(memRoot, 'git-hooks').replace(/\\/g, '/'));

  for (const args of [['archive', '--unknown'], ['archive', '--session', '../escape'], ['archive', '--older-than', '-1', '--dry-run'], ['restore'], ['restore', 'archived', '--revision', 'invalid'], ['storage', '--bad'], ['graph', '--cleanup'], ['graph', '--query'], ['recall'], ['recall', '../escape'], ['recall', 'archived', '--offset', '-1'], ['recall', '--cleanup', 'archived']]) {
    const result = spawnSync(process.execPath, [sync, ...args], { env, cwd: project, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1, `invalid CLI arguments must fail: ${args.join(' ')}`);
    assert.match(result.stderr, /Usage:/);
  }
  console.log('Archive sync integration tests passed.');
} finally {
  const resolved = fs.realpathSync.native(root);
  assert.equal(resolved, root);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mm-archive-sync-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
