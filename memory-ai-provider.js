// Native signed-in coding-agent clients own authentication. No token extraction,
// API endpoints, or API keys are part of Mem-mastero's provider configuration.
// Claude flags: https://code.claude.com/docs/en/cli-reference
// Codex settings: https://developers.openai.com/codex/config-schema.json
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { TextDecoder } = require('node:util');
const { safePath } = require('./archive-state');
const store = require('./memory-store');
const DEFAULTS = Object.freeze({ version: 1, semantic: false, summaries: false, automatic: false, provider: null });
const MAX_INPUT_BYTES = 48 * 1024, MAX_OUTPUT_BYTES = 64 * 1024, MAX_PROCESS_BYTES = 1024 * 1024;
const TIMEOUT_MS = 90000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(k => keys.includes(k));

function providerSpec(value) {
  if (!exact(value, ['type', 'model']) || !['claude', 'codex', 'copilot'].includes(value.type)
    || value.model !== undefined && (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model))) throw new Error('Invalid native AI provider; use a signed-in Claude Code, Codex, or Copilot CLI');
  return { type: value.type, ...(value.model === undefined ? {} : { model: value.model }) };
}
function validateSettings(value) {
  if (!exact(value, Object.keys(DEFAULTS)) || value.version !== 1 || ['semantic', 'summaries', 'automatic'].some(k => typeof value[k] !== 'boolean')) throw new Error('Invalid local AI settings');
  const result = { version: 1, semantic: value.semantic, summaries: value.summaries, automatic: value.automatic,
    provider: value.provider === null ? null : providerSpec(value.provider) };
  if ((result.semantic || result.summaries) && !result.provider) throw new Error('Select a signed-in native AI provider before enabling AI memory');
  if (result.automatic && !result.summaries) throw new Error('Automatic AI memory requires summaries');
  return result;
}
function settingsPath(context) { return safePath(store.memoryPath(context), 'ai-settings.json'); }
function readAISettings(context) {
  const file = settingsPath(context);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { ...DEFAULTS }; throw e; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Invalid local AI settings file');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid local AI settings JSON'); }
  return validateSettings(value);
}
function configureAI(context, patch) {
  if (!exact(patch, ['semantic', 'summaries', 'automatic', 'provider'])) throw new Error('Unknown AI setting; API keys and endpoint URLs are not supported');
  const dir = store.memoryPath(context); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let result;
  if (!require('./sync').withLock(dir, () => {
    result = validateSettings({ ...readAISettings(context), ...patch });
    require('./sync').atomicWrite(settingsPath(context), JSON.stringify(result, null, 2) + '\n');
  }, safePath(dir, 'ai-settings.lock'))) throw new Error('Another AI settings operation is running');
  return result;
}
function providerFingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(providerSpec(value))).digest('hex'); }

function childEnvironment(environment = process.env) {
  const env = { ...environment };
  // Force use of the client's ordinary sign-in, not an inherited paid API-key
  // or alternate-provider configuration. We never inspect credential values.
  for (const key of Object.keys(env)) if (/^(?:COPILOT_PROVIDER_.*|COPILOT_ALLOW_ALL|COPILOT_CUSTOM_INSTRUCTIONS_DIRS|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|AZURE_OPENAI_API_KEY|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|NODE_OPTIONS|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)$/i.test(key)) delete env[key];
  Object.assign(env, { MEM_MASTERO_AI_CHILD: '1', MEM_MASTERO_INHIBIT: '1', CLAUDE_CODE_SAFE_MODE: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_COLOR: '1' });
  return env;
}
function resolveCLI(type, env = process.env, platform = process.platform) {
  const name = type;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const directories = pathValue.split(platform === 'win32' ? ';' : ':').map(s => s.replace(/^"|"$/g, '')).filter(p => path.isAbsolute(p));
  for (const directory of directories) {
    const binary = path.join(directory, name + (platform === 'win32' ? '.exe' : ''));
    try { if (fs.statSync(binary).isFile()) return { command: binary, prefix: [] }; } catch {}
    if (platform === 'win32') {
      // Run the installed npm entry point with Node directly. Never route prompt
      // text, model names, or JSON through cmd.exe/PowerShell quoting.
      const relative = type === 'claude' ? ['@anthropic-ai', 'claude-code', 'cli.js']
        : type === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@github', 'copilot', 'index.js'];
      const entry = path.join(directory, 'node_modules', ...relative);
      try { if (fs.statSync(entry).isFile()) return { command: process.execPath, prefix: [entry] }; } catch {}
    }
  }
  throw new Error(`Install the ${name} CLI and sign in before using this AI provider`);
}
function requestOf(request) {
  if (!exact(request, ['system', 'user', 'schema']) || typeof request.system !== 'string' || !request.system.trim()
    || typeof request.user !== 'string' || !request.user.trim() || Buffer.byteLength(request.system) + Buffer.byteLength(request.user) > MAX_INPUT_BYTES) throw new Error('AI request exceeds its text budget or has invalid fields');
  if (request.schema !== undefined && (!object(request.schema) || Buffer.byteLength(JSON.stringify(request.schema)) > 16 * 1024)) throw new Error('Invalid AI response schema');
  return request;
}
function responseSchema(schema) {
  if (schema === undefined) return undefined;
  // Native model providers implement a subset of JSON Schema. OpenAI-backed
  // Codex/Copilot reject uniqueItems before generation. Keep the authoritative
  // application schema unchanged; summary/search validators still enforce
  // uniqueness and source membership on every returned object.
  const copy = JSON.parse(JSON.stringify(schema));
  const visit = node => {
    if (!object(node)) return node;
    delete node.uniqueItems;
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) if (object(node[key])) {
      for (const name of Object.keys(node[key])) node[key][name] = visit(node[key][name]);
    }
    for (const key of ['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else']) {
      if (Array.isArray(node[key])) node[key] = node[key].map(visit);
      else if (object(node[key])) node[key] = visit(node[key]);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(node[key])) node[key] = node[key].map(visit);
    return node;
  };
  return visit(copy);
}
function invocation(spec, request, work) {
  const system = safePath(work, 'system.txt'), schema = safePath(work, 'schema.json'), output = safePath(work, 'result.txt');
  fs.writeFileSync(system, request.system, { mode: 0o600, flag: 'wx' });
  if (request.schema) fs.writeFileSync(schema, JSON.stringify(request.schema), { mode: 0o600, flag: 'wx' });
  if (spec.type === 'claude') {
    const mcp = safePath(work, 'mcp.json'); fs.writeFileSync(mcp, '{"mcpServers":{}}', { mode: 0o600, flag: 'wx' });
    // --tools '' removes every built-in action. Deny MCP separately: denying
    // '*' also denies Claude's internal StructuredOutput formatter and makes
    // valid JSON-schema requests exhaust their turn budget.
    return { args: ['--print', '--safe-mode', '--no-session-persistence', '--disable-slash-commands', '--tools', '', '--disallowedTools', 'mcp__*',
      '--strict-mcp-config', '--mcp-config', mcp, '--setting-sources', '', '--output-format', 'json', '--max-turns', '2',
      '--settings', '{"forceLoginMethod":"claudeai"}',
      '--system-prompt-file', system, '--debug-file', safePath(work, 'debug.log'),
      ...(request.schema ? ['--json-schema', JSON.stringify(request.schema)] : []), ...(spec.model ? ['--model', spec.model] : [])], input: request.user, output: null };
  }
  // Every potentially agentic capability is disabled independently of the
  // read-only sandbox. Unknown flags in an older CLI fail closed.
  const disable = ['shell_tool', 'unified_exec', 'hooks', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'browser_use', 'view_image', 'image_generation', 'code_mode'];
  return { args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
    ...disable.flatMap(name => ['--disable', name]), '-c', 'forced_login_method="chatgpt"', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', 'history.persistence="none"', '-c', 'log_dir=' + JSON.stringify(safePath(work, 'logs')),
    '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false', '-c', 'model_instructions_file=' + JSON.stringify(system),
    ...(request.schema ? ['--output-schema', schema] : []), '-o', output, ...(spec.model ? ['--model', spec.model] : []), '-'],
    input: request.system + '\n\n' + request.user, output };
}

function stop(child) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return true;
  let stopped = false;
  if (process.platform === 'win32') {
    try { stopped = cp.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0; } catch {}
  } else try { process.kill(-child.pid, 'SIGKILL'); stopped = true; } catch {}
  try { stopped = child.kill('SIGKILL') || stopped; } catch {}
  if (!stopped) try { process.kill(child.pid, 0); } catch (e) { if (e.code === 'ESRCH') stopped = true; }
  return stopped;
}
function runProcess(command, args, options, spawn = cp.spawn) {
  return new Promise((resolve, reject) => {
    let child, stdout = [], bytes = 0, failure, complete = false, closeTimer;
    const finish = (error, value) => { if (complete) return; complete = true; clearTimeout(timer); clearTimeout(closeTimer); options.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const fail = message => {
      if (failure || complete) return;
      failure = new Error(message);
      let stopped = !child;
      if (child) try { stopped = (options.stopProcess || stop)(child) === true; } catch {}
      // A killed child or inherited pipe may never deliver close. Bound that
      // wait too; do not keep the host worker alive indefinitely after timeout.
      closeTimer = setTimeout(() => {
        if (complete) return;
        if (!stopped && child?.exitCode == null && child?.signalCode == null) {
          failure = new Error('AI client could not be stopped; its temporary work was retained safely');
          failure.retainedAIWork = true;
        }
        child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.();
        finish(failure);
      }, 500);
    };
    const abort = () => fail('AI request cancelled');
    const timer = setTimeout(() => fail('AI request timed out; local memory remains available'), options.timeoutMs);
    if (options.signal?.aborted) { finish(new Error('AI request cancelled')); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    try { child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', windowsHide: true }); }
    catch { finish(new Error('AI client could not start; check its installation and sign-in')); return; }
    child.once('error', () => finish(new Error('AI client could not start; check its installation and sign-in')));
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_PROCESS_BYTES) fail('AI client output exceeds its budget'); else stdout.push(chunk); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_PROCESS_BYTES) fail('AI client output exceeds its budget'); });
    child.once('close', code => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new Error('AI client failed; check its sign-in, plan limits, model, and CLI version'));
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)); }
      catch { return finish(new Error('AI client returned invalid UTF-8')); }
      finish(null, text);
    });
    child.stdin.on('error', () => { /* The exit event supplies a sanitized error. */ });
    child.stdin.end(options.input);
  });
}
function responseText(spec, raw, output, work) {
  let text;
  if (spec.type === 'claude') {
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('AI client returned an invalid response'); }
    if (!object(value) || value.type !== 'result' || value.is_error === true || value.subtype && value.subtype !== 'success') throw new Error('AI client did not complete successfully');
    text = value.structured_output !== undefined ? JSON.stringify(value.structured_output) : value.result;
  } else {
    const file = safePath(work, path.relative(work, output)); let stat;
    try { stat = fs.lstatSync(file); } catch { throw new Error('AI client did not return its final result'); }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_OUTPUT_BYTES) throw new Error('AI client result exceeds its budget or is unsafe');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
    catch { throw new Error('AI client returned invalid UTF-8'); }
  }
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error('AI client returned an empty or oversized result');
  return text;
}
async function generate(value, request, options = {}) {
  const spec = providerSpec(value); requestOf(request);
  if (request.schema !== undefined) request = { ...request, schema: responseSchema(request.schema) };
  if (!options.context) throw new Error('AI processing requires a project memory context');
  if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function'
    || typeof options.signal.removeEventListener !== 'function' || typeof options.signal.aborted !== 'boolean')) throw new Error('Invalid AI cancellation signal');
  store.scope(options.context);
  const timeoutMs = options.timeoutMs === undefined ? TIMEOUT_MS : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > TIMEOUT_MS) throw new Error('Invalid AI request timeout');
  const env = childEnvironment(options.env || process.env);
  const cli = spec.type === 'copilot' ? null : options.resolveCLI ? options.resolveCLI(spec.type, env) : resolveCLI(spec.type, env);
  const base = safePath(options.context.memRoot, 'ai-work'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'job-')));
  let retainWork = false;
  try {
    if (spec.type === 'copilot') return await require('./memory-copilot-provider').generateCopilot(spec, request, { ...options, work, env, timeoutMs });
    const call = invocation(spec, request, work);
    const raw = await runProcess(cli.command, [...cli.prefix, ...call.args], { cwd: work, env, input: call.input, signal: options.signal, timeoutMs, stopProcess: options.stopProcess }, options.spawn);
    return responseText(spec, raw, call.output, work);
  } catch (error) {
    retainWork = error.retainedAIWork === true;
    throw error;
  } finally {
    // Delete only this invocation's verified, newly created temporary directory.
    const realBase = fs.realpathSync.native(base), resolved = fs.realpathSync.native(work);
    if (resolved !== work || path.dirname(resolved) !== realBase || !/^job-[A-Za-z0-9]+$/.test(path.basename(resolved))) throw new Error('AI temporary-directory cleanup refused an unexpected path');
    if (!retainWork) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
module.exports = { readAISettings, configureAI, providerFingerprint, generate, providerSpec, childEnvironment, resolveCLI, responseSchema,
  stopProcess: stop, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_PROCESS_BYTES, TIMEOUT_MS };
