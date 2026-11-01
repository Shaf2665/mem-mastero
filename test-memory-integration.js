// Real CLI coverage using synthetic homes, local project origins, and a folder
// transport. The offline fixture intercepts every network-capable Git/GH call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-memory-integration-')));
const script = path.join(__dirname, 'sync.js');
const hub = path.join(root, 'folder-store');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (/^(GIT_|MEM_MASTERO_|PI_CODING_AGENT_|NODE_OPTIONS$|CODEX_HOME$|COPILOT_HOME$|CLAUDE_CONFIG_DIR$)/i.test(key)) delete baseEnv[key];
}
Object.assign(baseEnv, {
  TEMP: root, TMP: root, GIT_CONFIG_GLOBAL: path.join(root, 'global.gitconfig'),
  GIT_CONFIG_SYSTEM: path.join(root, 'system.gitconfig'), GIT_TERMINAL_PROMPT: '0', MEM_MASTERO_INHIBIT: '1',
});

function machine(name, origin = 'https://github.com/example/knowledge-project.git') {
  const home = path.join(root, name), project = path.join(home, 'work', name + '-checkout');
  fs.mkdirSync(project, { recursive: true });
  const env = { ...baseEnv, HOME: home, USERPROFILE: home, MEM_MASTERO_DIR: hub,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    COPILOT_HOME: path.join(home, '.copilot'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') };
  const git = args => execFileSync('git', ['-C', project, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true });
  git(['init', '-q', '--initial-branch=main']); git(['remote', 'add', 'origin', origin]);
  const native = path.join(env.CLAUDE_CONFIG_DIR, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  return { home, project, env, native };
}
function invoke(device, args, { input = '', extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd: device.project, env: { ...device.env, ...extraEnv },
    input, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
function successful(device, args, options) {
  const result = invoke(device, args, options);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result;
}
function memory(device, args, options) { return JSON.parse(successful(device, ['memory', ...args, '--json'], options).stdout); }
function add(device, text, kind = 'decision') { return memory(device, ['add', '--stdin'], { input: JSON.stringify({ kind, title: text, text }) }); }
function assistant(device, sessionId, id, text) {
  return JSON.stringify({ type: 'assistant', uuid: id, cwd: device.project, sessionId, timestamp: '2026-10-29T12:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
}
function hook(device, mode, transcript, sessionId) {
  return invoke(device, ['claude', mode], { input: JSON.stringify({ cwd: device.project, transcript_path: transcript, session_id: sessionId }) });
}

try {
  put(baseEnv.GIT_CONFIG_GLOBAL, ''); put(baseEnv.GIT_CONFIG_SYSTEM, '');
  const a = machine('device-A'), b = machine('device-B');
  const nativeMemory = path.join(a.native, 'memory', 'MEMORY.md');
  put(nativeMemory, '- Existing native memory stays intact.\n');
  const first = add(a, 'Use blue widgets for this project.');
  assert.match(first.id, /^memory:[a-f0-9]{64}$/);
  assert.equal(memory(a, ['search', 'blue widgets']).matches[0].id, first.id);
  assert.equal(memory(b, ['search', 'blue widgets']).matches.length, 0, 'devices have independent local caches before sync');
  assert.equal(memory(a, ['sync']).pushed, 1);
  assert.equal(memory(b, ['sync']).pulled, 1);
  assert.equal(memory(b, ['get', first.id]).text, first.text, 'same origin resolves across different checkout paths');
  assert.equal(fs.readFileSync(nativeMemory, 'utf8'), '- Existing native memory stays intact.\n');
  assert(!fs.existsSync(b.native), 'memory-only sync must not copy native sessions or native memory');

  const fromB = add(b, 'Retry green widget requests twice.', 'constraint');
  memory(a, ['forget', first.id]); memory(a, ['sync']);
  assert.equal(memory(b, ['search', 'blue widgets']).matches.length, 1, 'offline peer still has the stale record before syncing');
  memory(b, ['sync']); memory(a, ['sync']);
  for (const device of [a, b]) {
    assert.equal(memory(device, ['search', 'blue widgets']).matches.length, 0, 'stale peer must never resurrect a tombstoned note');
    assert.equal(invoke(device, ['memory', 'get', first.id, '--json']).status, 1);
    assert.equal(memory(device, ['get', fromB.id]).id, fromB.id, 'unrelated edits still merge');
    assert(!memory(device, ['context']).context.includes('blue widgets'));
  }
  const exportedPath = path.join(root, 'export.json');
  memory(a, ['export', '--output', exportedPath]);
  const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
  assert(!exported.records.some(record => record.id === first.id));
  assert(exported.tombstones.some(record => record.id === first.id));
  assert.equal(memory(b, ['import', exportedPath]).imported, 0, 'roundtrip import deduplicates active records and keeps deletion markers');

  // Both the project identity and the configured store isolate local recall.
  const other = machine('other-project', 'https://github.com/example/other-project.git');
  assert.equal(memory(other, ['search', 'widgets'], { extraEnv: { GIT_DIR: path.join(a.project, '.git'), GIT_WORK_TREE: a.project } }).matches.length, 0,
    'inherited Git hook variables cannot redirect memory to another project');
  assert.equal(memory(a, ['status'], { extraEnv: { MEM_MASTERO_DIR: path.join(root, 'other-store') } }).activeMemories, 0);

  // An actual Stop-style hook captures a derived observation and normal sync
  // carries it to another device. Source transcript and native memory survive.
  const transcript = path.join(a.native, 'session-fixture.jsonl');
  const raw = assistant(a, 'session-fixture', 'assistant-one', 'Amber cache invalidation is now explicit. api_key=synthetic_secret_value_123456789');
  put(transcript, raw);
  const pushed = hook(a, 'push', transcript, 'session-fixture');
  assert.equal(pushed.status, 0, pushed.stderr);
  const captured = memory(a, ['search', 'Amber']).matches;
  assert.equal(captured.length, 1);
  assert.equal(captured[0].provenance, 'captured');
  assert.equal(captured[0].source.sessionId, 'session-fixture');
  assert(!memory(a, ['get', captured[0].id]).text.includes('synthetic_secret_value_123456789'));
  assert.equal(fs.readFileSync(transcript, 'utf8'), raw, 'capture never edits its source transcript');
  assert.equal(fs.readFileSync(nativeMemory, 'utf8'), '- Existing native memory stays intact.\n');
  assert.equal(hook(a, 'push', transcript, 'session-fixture').status, 0);
  assert.equal(memory(a, ['search', 'Amber']).matches.length, 1, 'hook replay deduplicates');
  const started = hook(b, 'start');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Retry green widget requests/);
  assert.equal((started.stdout.match(/Mem-mastero project knowledge/g) || []).length, 1, 'cached knowledge is emitted only once');
  assert.equal(memory(b, ['search', 'Amber']).matches.length, 1);
  const fresh = machine('first-start-device');
  const firstStart = hook(fresh, 'start');
  assert.equal(firstStart.status, 0, firstStart.stderr);
  assert.match(firstStart.stdout, /Amber cache invalidation/, 'a device with no cached knowledge receives the newly pulled context');
  assert.equal((firstStart.stdout.match(/Mem-mastero project knowledge/g) || []).length, 1);

  memory(a, ['settings', '--capture', 'off']);
  fs.appendFileSync(transcript, assistant(a, 'session-fixture', 'assistant-paused', 'Pausedmarker should never be captured while disabled.'));
  assert.equal(hook(a, 'push', transcript, 'session-fixture').status, 0);
  assert.equal(memory(a, ['search', 'Pausedmarker']).matches.length, 0);
  memory(a, ['settings', '--context', 'off']);
  assert.equal(memory(a, ['context']).context, '');

  // This preload permits local Git identity reads but fails before any GH or
  // remote Git command can run. No network service or real credential is used.
  const guard = path.join(root, 'no-network.cjs'), attempts = path.join(root, 'network-attempts.txt');
  put(guard, `const fs = require('node:fs'), cp = require('node:child_process');\n`
    + `for (const name of ['execFileSync', 'spawnSync', 'spawn']) { const original = cp[name]; cp[name] = function(file, args, ...rest) {\n`
    + ` const command = String(file).trim().split(/\\s+/)[0].replace(/\\\\/g, '/').split('/').pop().toLowerCase();\n`
    + ` if (/^gh(?:\\.exe)?$/.test(command) || (/^git(?:\\.exe)?$/.test(command) && Array.isArray(args) && args.some(a => ['clone','fetch','pull','push','ls-remote'].includes(a)))) {\n`
    + `   fs.appendFileSync(process.env.MM_TEST_NETWORK_MARKER, command + '\\n'); throw new Error('Synthetic offline network guard'); }\n`
    + ` return original.call(this, file, args, ...rest); }; }\n`);
  const offline = machine('offline-device');
  delete offline.env.MEM_MASTERO_DIR;
  offline.env.NODE_OPTIONS = '--require ' + JSON.stringify(guard);
  offline.env.MM_TEST_NETWORK_MARKER = attempts;
  put(path.join(offline.home, '.mem-mastero.json'), JSON.stringify({ github: 'https://github.com/example/private-offline-memory.git' }));
  const offlineNote = add(offline, 'Offline local knowledge remains available.');
  assert.equal(memory(offline, ['search', 'Offline']).matches[0].id, offlineNote.id);
  assert.match(memory(offline, ['context', '--budget', '1500']).context, /Offline local knowledge/);
  assert.equal(memory(offline, ['status']).activeMemories, 1);
  assert(!fs.existsSync(attempts), 'add/search/context/status resolve locally without any attempted cloud access');
  assert(!fs.existsSync(path.join(offline.home, '.mem-mastero', 'repos')), 'local commands must not clone a memory repository');

  const offlineTranscript = path.join(offline.native, 'offline-session.jsonl');
  put(offlineTranscript, assistant(offline, 'offline-session', 'offline-one', 'Offlinecapture survives a failed upload.'));
  const offlinePush = hook(offline, 'push', offlineTranscript, 'offline-session');
  assert.equal(offlinePush.status, 0, 'agent hook failures must not stop the agent');
  assert(fs.existsSync(attempts), 'fixture actually reached and blocked the upload path');
  assert.equal(memory(offline, ['search', 'Offlinecapture']).matches.length, 1, 'capture is durable before cloud synchronization fails');
  const offlineStart = hook(offline, 'start');
  assert.equal(offlineStart.status, 0, offlineStart.stderr);
  assert.match(offlineStart.stdout, /Offline local knowledge/, 'session start still injects bounded cached context during an outage');
  assert(!fs.existsSync(path.join(offline.home, '.mem-mastero', 'repos')));
  console.log('Memory CLI integration tests passed.');
} finally {
  const resolved = fs.realpathSync.native(root);
  assert.equal(resolved, root);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mm-memory-integration-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
