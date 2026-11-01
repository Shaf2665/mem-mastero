// Inventory reads metadata only; archive candidates include the native session bundle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanStorage, discoverSessions, assertClaudeStopped } = require('./claude-files');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-claude-files-')));
const claudeRoot = path.join(tmp, 'claude'), memRoot = path.join(tmp, 'mem');
const projectDir = path.join(claudeRoot, 'projects', '-test-project');
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
const noProcesses = () => [];
const stopped = extra => assertClaudeStopped({ claudeRoot, processScanner: noProcesses, pidAlive: () => false, ...extra });

try {
  put(path.join(projectDir, 'session-one.jsonl'), 'history');
  put(path.join(projectDir, 'session-one', 'subagents', 'agent-a.jsonl'), 'child');
  put(path.join(projectDir, 'session-one', 'tool-results', 'large.txt'), 'result');
  put(path.join(projectDir, 'session-one', 'mcp-tasks', 'task.json'), '{}');
  put(path.join(claudeRoot, 'file-history', 'session-one', 'checkpoint'), 'before');
  put(path.join(claudeRoot, 'uploads', 'session-one', 'image.png'), 'image');
  put(path.join(claudeRoot, 'session-env', 'session-one.json'), '{}');
  put(path.join(projectDir, 'memory', 'MEMORY.md'), 'remember');
  put(path.join(claudeRoot, 'debug', 'debug.log'), 'log');
  put(path.join(memRoot, 'repos', 'repo-one', '.git', 'objects', 'object'), 'git');
  put(path.join(memRoot, 'repos', 'repo-one', 'projects', 'session.jsonl'), 'copy');
  put(path.join(memRoot, 'repo', '.git', 'config'), 'legacy');
  put(path.join(memRoot, 'archive-cache', 'pending', 'payload.gz'), 'zip');
  put(path.join(memRoot, 'sync.js'), 'script');

  const originalRead = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('inventory must never read transcript content'); };
  let report;
  try { report = scanStorage({ claudeRoot, memRoot }); } finally { fs.readFileSync = originalRead; }
  assert.deepStrictEqual(report.categories.transcripts, { bytes: 7, files: 1 });
  assert.deepStrictEqual(report.categories.companions, { bytes: 20, files: 5 });
  assert.deepStrictEqual(report.categories.fileHistory, { bytes: 6, files: 1 });
  assert.deepStrictEqual(report.categories.memory, { bytes: 8, files: 1 });
  assert.deepStrictEqual(report.categories.otherClaude, { bytes: 3, files: 1 });
  assert.deepStrictEqual(report.categories.memRepoGit, { bytes: 9, files: 2 });
  assert.deepStrictEqual(report.categories.memRepoWorkingTrees, { bytes: 4, files: 1 });
  assert.deepStrictEqual(report.categories.archiveCache, { bytes: 3, files: 1 });
  assert.deepStrictEqual(report.categories.otherMem, { bytes: 6, files: 1 });
  assert.strictEqual(report.totalBytes, 66);
  assert.strictEqual(report.totalFiles, 14);
  assert.deepStrictEqual(report.errors, []);

  const sessions = discoverSessions({ claudeRoot, projectDir });
  assert.strictEqual(sessions.length, 1);
  const session = sessions[0];
  assert.strictEqual(session.sessionId, 'session-one');
  assert.strictEqual(session.bytes, 33);
  assert.strictEqual(session.files.length, 7);
  assert(session.files.every(file => path.isAbsolute(file.path) && file.size >= 0 && Number.isFinite(file.mtimeMs)));
  assert(session.files.some(file => file.relative === 'file-history/session-one/checkpoint'));
  assert(session.files.some(file => file.relative === 'uploads/session-one/image.png'));
  assert(session.files.some(file => file.relative === 'session-env/session-one.json'));
  assert(!session.files.some(file => file.relative.includes('MEMORY.md')));
  assert.strictEqual(session.lastModifiedMs, Math.max(...session.files.map(file => file.mtimeMs)));
  assert.throws(() => discoverSessions({ claudeRoot, projectDir: tmp }), /project directory/);
  assert.throws(() => discoverSessions({ claudeRoot, projectDir, sessionId: '../escape' }), /session ID/);
  assert.deepStrictEqual(discoverSessions({ claudeRoot, projectDir: path.join(claudeRoot, 'projects', '-missing') }), []);

  const blocked = put(path.join(projectDir, 'session-one', 'active.lock'), 'lock');
  assert.throws(() => discoverSessions({ claudeRoot, projectDir }), /lock|temporary/);
  fs.unlinkSync(blocked);
  const pending = put(path.join(projectDir, 'session-one', 'payload.tmp'), 'partial');
  assert.throws(() => discoverSessions({ claudeRoot, projectDir }), /lock|temporary/);
  fs.unlinkSync(pending);

  stopped();
  for (const process of [
    { pid: 42, name: 'claude.exe', commandLine: 'claude.exe' },
    { pid: 42, name: 'claude-cli', commandLine: 'claude-cli' },
    { pid: 42, name: 'Claude Helper', commandLine: '/Applications/Claude.app/Contents/Frameworks/Claude Helper' },
    { pid: 42, name: 'node', commandLine: 'node /npm/@anthropic-ai/claude-code/cli.js' },
    { pid: 42, name: 'bun.exe', commandLine: 'bun C:\\npm\\@anthropic-ai\\claude-code\\cli.js' },
    { pid: 42, name: 'node', commandLine: 'node /usr/local/bin/claude' },
    { pid: 42, name: 'bun', commandLine: 'bun "/home/user space/.local/bin/claude" --resume a-session' },
    { pid: 42, name: 'node.exe', commandLine: 'node "C:\\global bin\\claude.js"' },
    { pid: 42, name: 'node', commandLine: 'node /global/claude.cjs' },
  ]) assert.throws(() => stopped({ processScanner: () => [process] }), /Claude.*running|running.*Claude/i);
  stopped({ processScanner: () => [{ pid: 42, name: 'node', commandLine: 'node /work/test-claude-files.js' }] });
  assert.throws(() => stopped({ processScanner: () => [{ pid: 42, name: 'node', commandLine: null }] }), /verify|determine/);
  assert.throws(() => stopped({ processScanner: () => { throw new Error('permission denied'); } }), /verify.*process/i);
  assert.throws(() => stopped({ processScanner: () => ({ invalid: true }) }), /verify.*process/i);

  const record = put(path.join(claudeRoot, 'sessions', '42.json'), JSON.stringify({ pid: 42 }));
  assert.throws(() => stopped({ pidAlive: pid => pid === 42 }), /running|active/i);
  stopped(); // A stale native record does not stop explicit archival.
  fs.writeFileSync(record, '{broken');
  assert.throws(() => stopped(), /session record/);
  fs.writeFileSync(record, JSON.stringify({ unknown: true }));
  assert.throws(() => stopped(), /session record/);
  fs.writeFileSync(record, JSON.stringify({ pid: -1 }));
  assert.throws(() => stopped(), /session record/);
  fs.writeFileSync(record, JSON.stringify({ pid: 42 }));
  assert.throws(() => stopped({ pidAlive: () => { throw new Error('EPERM'); } }), /verify.*session/i);
  fs.unlinkSync(record);

  // Exercise both platform subprocess adapters without inspecting the user's processes.
  const vm = require('vm');
  const source = fs.readFileSync(path.join(__dirname, 'claude-files.js'), 'utf8');
  for (const platform of ['win32', 'linux', 'darwin']) {
    let response = platform === 'win32'
      ? JSON.stringify([{ ProcessId: 10, Name: 'node.exe', CommandLine: 'node test.js' }])
      : '  10 node node test.js\n';
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, process: { platform, kill() { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); } },
      require(name) {
        if (name !== 'child_process') return require(name);
        return { execFileSync(command, args, options) {
          assert.strictEqual(command, platform === 'win32' ? 'powershell.exe' : 'ps');
          assert.strictEqual(options.timeout, 15000);
          if (platform === 'win32') assert.strictEqual(options.windowsHide, true);
          return response;
        } };
      },
    });
    module.exports.assertClaudeStopped({ claudeRoot });
    response = platform === 'win32'
      ? JSON.stringify([{ ProcessId: 10, Name: 'claude.exe', CommandLine: 'private user prompt' }])
      : '  10 /Applications/Claude.app/Contents/MacOS/Claude private user prompt\n';
    assert.throws(() => module.exports.assertClaudeStopped({ claudeRoot }), error => /Claude.*running/.test(error.message) && !error.message.includes('private user prompt'));
    response = platform === 'win32' ? '[]' : '';
    assert.throws(() => module.exports.assertClaudeStopped({ claudeRoot }), /Cannot verify/);
    response = 'unparseable';
    assert.throws(() => module.exports.assertClaudeStopped({ claudeRoot }), /Cannot verify/);
  }

  // Windows junctions do not require symlink privileges and exercise traversal protection.
  const external = path.join(tmp, 'external');
  put(path.join(external, 'secret'), 'outside');
  const linked = path.join(projectDir, 'session-one', 'linked');
  fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discoverSessions({ claudeRoot, projectDir }), /symbolic link/i);
  const linkedReport = scanStorage({ claudeRoot, memRoot });
  assert.strictEqual(linkedReport.totalBytes, 66, 'inventory never follows links');
  assert.strictEqual(linkedReport.skippedSymlinks, 1);
  fs.unlinkSync(linked);
  const rootLink = path.join(tmp, 'linked-claude');
  fs.symlinkSync(claudeRoot, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discoverSessions({ claudeRoot: rootLink, projectDir: path.join(rootLink, 'projects', '-test-project') }), /symbolic link/i);
  assert.throws(() => assertClaudeStopped({ claudeRoot: rootLink, processScanner: noProcesses }), /symbolic link/i);
  fs.unlinkSync(rootLink);

  const realReaddir = fs.readdirSync;
  fs.readdirSync = (file, ...args) => {
    if (path.resolve(file) === path.resolve(projectDir)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realReaddir(file, ...args);
  };
  try {
    assert(scanStorage({ claudeRoot, memRoot }).errors.some(error => error.path === projectDir && /EACCES/.test(error.message)));
    assert.throws(() => discoverSessions({ claudeRoot, projectDir }), /read|EACCES/);
  } finally { fs.readdirSync = realReaddir; }
  assert.strictEqual(scanStorage({ claudeRoot: path.join(tmp, 'missing'), memRoot: path.join(tmp, 'also-missing') }).totalBytes, 0);
  console.log('Claude inventory and liveness tests passed');
} finally {
  const resolved = fs.realpathSync.native(tmp);
  if (resolved !== tmp || !path.basename(resolved).startsWith('mm-claude-files-')) throw new Error('Unexpected test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
