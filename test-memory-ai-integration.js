// Real command/stdio/worker integration; model responses come from an isolated
// executable fixture. No installed login, token, or model service is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { configureAI } = require('./memory-ai-provider');
const { runMemoryCommand } = require('./memory-command');
const store = require('./memory-store');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ai-integration-')));
const userHome = path.join(root, 'home'), project = path.join(root, 'project'), bin = path.join(root, 'bin'), remote = path.join(root, 'drive');
const script = path.join(__dirname, 'sync.js'), callsFile = path.join(root, 'provider-calls.txt');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(GIT_|MEM_MASTERO_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|COPILOT_HOME$|NODE_OPTIONS$)/i.test(key)) delete env[key];
Object.assign(env, { HOME: userHome, USERPROFILE: userHome, MEM_MASTERO_DIR: remote, MEM_MASTERO_INHIBIT: '1',
  GIT_CONFIG_GLOBAL: path.join(root, 'global.gitconfig'), GIT_CONFIG_SYSTEM: path.join(root, 'system.gitconfig'),
  OPENAI_API_KEY: 'SYNTHETIC_KEY_MUST_NOT_REACH_CLIENT', ANTHROPIC_API_KEY: 'SYNTHETIC_KEY_MUST_NOT_REACH_CLIENT',
  MM_TEST_AI_CALLS: callsFile, PATH: bin + path.delimiter + (env.PATH || env.Path || '') });
delete env.Path;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const context = { cwd: project, memRoot: path.join(userHome, '.mem-mastero'), projectId: 'github.com/example/ai-integration', store: { dir: remote } };
const cli = (args, extra = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: project, env: { ...env, ...(extra.env || {}) }, input: extra.input || '', encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, extra.status || 0, result.stderr); return result.stdout;
};
const memory = (args, extra) => JSON.parse(cli(['memory', ...args, '--json'], extra));
const countCalls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
try {
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(userHome); fs.mkdirSync(bin); fs.mkdirSync(remote);
  put(env.GIT_CONFIG_GLOBAL, ''); put(env.GIT_CONFIG_SYSTEM, '[core]\n  longpaths = true\n');
  execFileSync('git', ['init', '-q', project], { env, windowsHide: true });
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/example/ai-integration.git'], { env, windowsHide: true });
  const fixture = `#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict');
assert(!process.env.OPENAI_API_KEY); assert(!process.env.ANTHROPIC_API_KEY);
assert.equal(process.env.MEM_MASTERO_AI_CHILD,'1');
const args=process.argv.slice(2); assert(args.includes('--ephemeral')); assert(args.includes('--ignore-user-config')); assert(args.includes('read-only'));
fs.appendFileSync(process.env.MM_TEST_AI_CALLS,'call\\n');
if(process.env.MM_AI_FAIL==='1') process.exit(2);
const input=fs.readFileSync(0,'utf8'),data=JSON.parse(input.slice(input.lastIndexOf('\\n\\n')+2));
assert(!input.includes('PRIVATE_SENTINEL')); assert(!input.includes('SYNTHETIC_SECRET_VALUE'));
let result;
if(data.memories){result={matches:data.memories.filter(r=>/backoff|throttle/i.test(r.title+' '+r.text)).map(r=>({id:r.id,score:0.95}))};}
else {result={title:'Request retry decision',summary:'Transient failures use bounded exponential backoff.',decisions:['Retry transient failures with a bounded delay.'],fixes:[],openQuestions:[],sourceIds:data.records.map(r=>r.id)};}
fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(result));
console.log(JSON.stringify({type:'turn.completed'}));
`;
  if (process.platform === 'win32') put(path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), fixture);
  else { put(path.join(bin, 'codex'), fixture); fs.chmodSync(path.join(bin, 'codex'), 0o755); }
  const source = memory(['add', '--kind', 'decision', '--text', 'Use bounded exponential backoff after throttle failures. <private>PRIVATE_SENTINEL</private> api_key=SYNTHETIC_SECRET_VALUE']);
  memory(['add', '--kind', 'preference', '--text', 'Use dark colors in the dashboard.']);
  const query = 'recover gracefully when service temporarily refuses requests';
  assert.equal(memory(['search', query, '--mode', 'keyword']).matches.length, 0);
  memory(['ai-settings', '--provider', 'codex', '--semantic', 'on', '--summaries', 'on']);
  assert.equal(countCalls(), 0, 'configuration without automatic work never calls a model');
  const semantic = memory(['search', query, '--mode', 'semantic']);
  assert.equal(semantic.modeUsed, 'semantic'); assert.equal(semantic.matches[0].id, source.id); assert.equal(semantic.coverage.total, 2);
  assert.equal(countCalls(), 1);
  assert.equal(memory(['search', query, '--mode', 'semantic']).matches[0].id, source.id); assert.equal(countCalls(), 1, 'same query uses scoped ID-only cache');
  const preview = memory(['summarize', '--dry-run']); assert.equal(preview.status, 'preview'); assert.equal(countCalls(), 1);
  const summary = memory(['summarize']); assert.equal(summary.status, 'created'); assert.equal(countCalls(), 2);
  const generated = memory(['get', summary.id]); assert.equal(generated.provenance, 'generated'); assert(generated.source.memoryIds.includes(source.id));
  assert.equal(memory(['summarize']).status, 'empty'); assert.equal(countCalls(), 2);

  const offline = memory(['search', 'throttle or temporary outage', '--mode', 'hybrid'], { env: { MM_AI_FAIL: '1' } });
  assert.equal(offline.modeUsed, 'keyword'); assert.equal(offline.fallback, 'provider_unavailable'); assert(offline.matches.some(r => r.id === source.id));
  memory(['forget', source.id]);
  assert(!memory(['search', '', '--mode', 'keyword']).matches.some(r => r.id === summary.id), 'source deletion excludes its generated summary');
  cli(['memory', 'get', summary.id], { status: 1 });
  assert(!memory(['search', query, '--mode', 'semantic']).matches.some(r => r.id === source.id), 'cached semantic match cannot resurrect a forgotten source');

  memory(['add', '--kind', 'bugfix', '--text', 'Throttle recovery now has a maximum retry count.']);
  configureAI(context, { automatic: true });
  runMemoryCommand(['ai-settings'], { context: () => context, log() {}, scheduleAI: () => assert.fail('read-only settings must not schedule AI') });
  cli(['memory-worker', project]);
  assert.equal(memory(['ai-status']).job.created, 1);
  const cloudFiles = fs.readdirSync(path.join(remote, 'knowledge', 'v1'), { recursive: true });
  assert(cloudFiles.some(file => String(file).endsWith('.json')), 'worker syncs generated knowledge through the configured store');
  assert(!cloudFiles.some(file => /ai-settings|ai-search|ai-job/.test(String(file))), 'provider settings/cache/jobs stay local');
  assert.equal(fs.readdirSync(path.join(context.memRoot, 'ai-work')).length, 0, 'temporary prompts/results are removed');

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { cwd: project, query: 'throttle', mode: 'hybrid' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_summarize', arguments: { cwd: project, dryRun: true } } },
  ];
  const mcp = spawnSync(process.execPath, [path.join(__dirname, 'memory-mcp.js')], { env, cwd: project, input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(mcp.status, 0, mcp.stderr); assert.equal(mcp.stderr, '');
  const replies = mcp.stdout.trim().split('\n').map(JSON.parse); assert.equal(replies.length, 3);
  const result = JSON.parse(replies[1].result.content[0].text); assert.equal(result.modeUsed, 'hybrid'); assert(result.coverage);
  assert.equal(JSON.parse(replies[2].result.content[0].text).status, 'empty');
  console.log('AI CLI, native transport, MCP, summary worker and sync integration tests passed.');
} finally {
  const resolved = fs.realpathSync.native(root); assert.equal(resolved, root); assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mm-ai-integration-')); fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
