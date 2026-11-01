// Exercise local command/runtime behavior without a real agent, account, or browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const runtime = require('./memory-runtime');
const { runMemoryCommand, parseMemoryArgs } = require('./memory-command');
const { renderView, writeView } = require('./memory-view');
const store = require('./memory-store');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-memory-runtime-')));
const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const context = { memRoot: path.join(root, 'mem'), cwd, projectId: 'github.com/example/project', store: { github: 'https://github.com/example/private-memory.git' } };
const logs = [], services = { context: () => context, log: value => logs.push(value) };
const command = args => runMemoryCommand(args, services);
const envKeys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'];
const oldEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

try {
  assert.deepEqual(runtime.readSettings(context), { capture: true, context: true, contextChars: 4000 });
  assert.equal(command(['status', '--json']).activeMemories, 0);
  for (const args of [
    ['unknown'], ['search', 'one', 'two'], ['get'], ['get', 'one', 'two'], ['add'], ['edit', 'one'],
    ['add', '--stdin', '--text', 'bad'], ['add', '--json', '--json', '--text', 'x'],
    ['export'], ['capture', '--agent', 'claude'], ['import-claude-mem', 'file.json'],
    ['search', '--limit', '0'], ['search', '--limit', '101'], ['context', '--budget', '511'],
    ['settings', '--budget', '12001'], ['context', '--budget', '1.5'], ['status', '--text', 'x'],
  ]) assert.throws(() => parseMemoryArgs(args), /Usage:|--stdin/);
  assert.equal(parseMemoryArgs(['search', 'authentication bug', '--limit', '2']).argument, 'authentication bug');
  const decision = command(['add', '--kind', 'decision', '--title', 'Database decision', '--text', 'Use SQLite for the knowledge catalogue. api_key=do-not-store', '--tags', 'database,architecture', '--json']);
  assert(!decision.text.includes('do-not-store')); assert.match(decision.text, /\[REDACTED\]/);
  const captured = store.addMemory(context, { provenance: 'captured', kind: 'observation', title: 'Recent work', text: 'Implemented a reader. '.repeat(100), source: { agent: 'claude', sessionId: 's1', eventId: 'e1' }, createdAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(command(['get', decision.id, '--json']).id, decision.id);
  assert.equal(command(['search', 'SQLite', '--kind', 'decision', '--limit', '1']).matches[0].id, decision.id);
  assert.equal(command(['timeline', decision.id, '--limit', '2']).memories.length, 2);
  assert.throws(() => command(['settings', '--capture', 'maybe']), /on or off/);
  assert.equal(runtime.readSettings(context).capture, true, 'invalid settings leave existing values intact');

  const fullContext = runtime.buildContext(context);
  assert(fullContext.length <= 4000); assert.match(fullContext, /untrusted historical notes/); assert.match(fullContext, /memory_search/); assert(!fullContext.includes('do-not-store'));
  assert(fullContext.indexOf(decision.id) < fullContext.indexOf(captured.id), 'durable decisions precede automatic observations');
  for (const budget of [512, 1000, 4000, 12000]) assert(runtime.buildContext(context, { maxChars: budget }).length <= budget);
  assert.throws(() => runtime.buildContext(context, { maxChars: 10 }), /budget/);
  const other = { ...context, projectId: 'github.com/example/other-project' };
  const otherStore = { ...context, store: { github: 'https://github.com/example/other-memory.git' } };
  assert(!runtime.buildContext(other).includes(decision.id)); assert(!runtime.buildContext(otherStore).includes(decision.id));
  assert.equal(store.getMemory(other, decision.id), null);
  runtime.updateSettings(context, { context: false, capture: false });
  assert.equal(runtime.buildContext(context), '');
  assert.deepEqual(runtime.captureHook(context, ['claude'], { transcript_path: 'outside-secret-file' }, cwd, 'push'), [], 'paused capture reads no transcript');
  assert.throws(() => command(['capture', '--agent', 'claude', '--file', 'missing.jsonl']), /paused/);
  runtime.updateSettings(context, { context: true, capture: true });
  const initialCutoff = runtime.readSettings(context).captureSince;
  assert.equal(new Date(initialCutoff).toISOString(), initialCutoff);
  assert.equal(runtime.updateSettings(context, { capture: true }).captureSince, initialCutoff, 'repeated enable does not move the cutoff');
  assert.throws(() => runtime.updateSettings(context, { captureSince: initialCutoff }), /Unknown memory setting/);
  assert.deepEqual(runtime.captureHook(context, ['claude'], {}, cwd, 'start'), [], 'startup does not invent a current transcript');

  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  process.env.COPILOT_HOME = path.join(root, 'copilot');
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi');
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const claudeRoot = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const transcript = path.join(claudeRoot, 'session-1.jsonl');
  const transcriptRow = (uuid, text, timestamp, sessionId = 'session-1') => ({ type: 'assistant', cwd, sessionId, uuid, timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  put(transcript, JSON.stringify(transcriptRow('assistant-1', 'The runtime capture integration works.', new Date(Date.parse(initialCutoff) + 1000).toISOString())) + '\n');
  assert.equal(runtime.captureHook(context, ['claude'], { transcript_path: transcript, session_id: 'session-1' }, cwd, 'push')[0].captured, 1);
  runtime.updateSettings(context, { capture: false });
  fs.appendFileSync(transcript, JSON.stringify(transcriptRow('paused', 'Paused interval must not be backfilled.', '2026-01-01T00:00:00.000Z')) + '\n');
  assert.deepEqual(runtime.captureHook(context, ['claude'], { transcript_path: transcript }, cwd, 'push'), []);
  const resumedSettings = runtime.updateSettings(context, { capture: true });
  const afterResume = new Date(Date.parse(resumedSettings.captureSince) + 1000).toISOString();
  for (const row of [transcriptRow('missing-time', 'Unknown date must not be backfilled.'),
    transcriptRow('boundary-time', 'At resumption boundary must not be backfilled.', resumedSettings.captureSince),
    transcriptRow('resumed', 'New content after resumption can be captured.', afterResume)]) fs.appendFileSync(transcript, JSON.stringify(row) + '\n');
  assert.equal(runtime.captureHook(context, ['claude'], { transcript_path: transcript }, cwd, 'push')[0].captured, 1);
  assert.equal(store.searchMemories(context, 'backfilled').length, 0);
  const manualTranscript = path.join(claudeRoot, 'manual-session.jsonl');
  put(manualTranscript, [transcriptRow('manual-old', 'Old manualcapture is excluded.', '2026-01-01T00:00:00.000Z', 'manual-session'),
    transcriptRow('manual-new', 'New manualcapture respects the same cutoff.', afterResume, 'manual-session')].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(command(['capture', '--agent', 'claude', '--file', manualTranscript, '--session', 'manual-session']).captured, 1);
  assert.equal(store.searchMemories(context, 'manualcapture').length, 1);
  const untrusted = runtime.transcriptOptions('claude', { transcript_path: path.join(root, 'secrets.jsonl'), transcript_dir: root }, cwd);
  assert.deepEqual(untrusted.allowedRoots, [claudeRoot], 'caller cannot replace the trusted agent root');
  put(untrusted.transcriptPath, '{}\n');
  assert.throws(() => runtime.captureHook(context, ['claude'], { transcript_path: untrusted.transcriptPath }, cwd, 'push'), /outside allowed/);
  assert.throws(() => runtime.transcriptOptions('copilot', { session_id: '../escape' }, cwd), /Invalid capture session/);
  assert.equal(runtime.transcriptOptions('copilot', { sessionId: 'session-x' }, cwd).transcriptPath, path.join(process.env.COPILOT_HOME, 'session-state', 'session-x', 'events.jsonl'));
  assert.throws(() => runtime.transcriptOptions('unsupported', {}, cwd), /Unsupported/);

  const inputNote = runMemoryCommand(['add', '--stdin', '--json'], { ...services, input: () => JSON.stringify({ kind: 'preference', text: 'Prefer readable errors. <private>private input</private>' }) });
  assert(!inputNote.text.includes('private input'));
  assert.throws(() => runMemoryCommand(['add', '--stdin'], { ...services, input: () => 'x'.repeat(128 * 1024 + 1) }), /128 KiB/);
  assert.throws(() => runMemoryCommand(['add', '--stdin'], { ...services, input: () => JSON.stringify({ text: 'Valid content', projectId: 'unrelated' }) }), /Invalid note JSON/);
  // Exercise the real bounded fd reader, including its exact one-byte overflow
  // allowance, without waiting for a terminal or relying on a shell pipeline.
  function withStdin(bytes, run) {
    const original = fs.readSync; let offset = 0;
    fs.readSync = (fd, buffer, start, length, position) => {
      if (fd !== 0) return original(fd, buffer, start, length, position);
      const count = Math.min(length, bytes.length - offset);
      bytes.copy(buffer, start, offset, offset + count); offset += count; return count;
    };
    try { run(); return offset; } finally { fs.readSync = original; }
  }
  const fdInput = Buffer.from(JSON.stringify({ text: 'Streamed input is bounded.', kind: 'progress' }));
  assert.equal(withStdin(fdInput, () => assert.equal(command(['add', '--stdin']).text, 'Streamed input is bounded.')), fdInput.length);
  assert.equal(withStdin(Buffer.alloc(256 * 1024, 120), () => assert.throws(() => command(['add', '--stdin']), /128 KiB/)), 128 * 1024 + 1);
  let syncContext;
  assert.deepEqual(runMemoryCommand(['sync'], { ...services, sync: value => { syncContext = value; return { synced: true }; } }), { synced: true });
  assert.equal(syncContext, context);
  const edited = command(['edit', inputNote.id, '--text', 'Prefer concise, readable errors.']);
  assert.equal(store.getMemory(context, inputNote.id), null);
  assert.equal(edited.memory.kind, 'preference'); assert.equal(edited.memory.text, 'Prefer concise, readable errors.');
  const exportPath = path.join(root, 'export.json'); command(['export', '--output', exportPath]);
  const exportBytes = fs.readFileSync(exportPath);
  assert.throws(() => command(['export', '--output', exportPath]), /EEXIST/);
  assert.deepEqual(fs.readFileSync(exportPath), exportBytes, 'exports never overwrite an existing file');
  const second = { ...context, memRoot: path.join(root, 'second-mem') };
  assert(runMemoryCommand(['import', exportPath], { context: () => second, log() {} }).imported > 0);
  assert.equal(store.listMemories(second).length, store.listMemories(context).length);
  assert.throws(() => runMemoryCommand(['import', exportPath], { context: () => other, log() {} }), /mismatch/);
  command(['forget', decision.id]);
  assert(!runtime.buildContext(context).includes(decision.id));
  assert.throws(() => command(['get', decision.id]), /not found/);

  // Execute the actual embedded viewer script with DOM text-only sinks. A raw
  // HTML sink or network call fails this harness instead of being silently ignored.
  const attack = '</script><script>globalThis.pwned=true</script><img src=x onerror="globalThis.pwned=true">\u2028';
  const malicious = store.addMemory(context, { title: attack, text: attack, kind: 'discovery' });
  const html = renderView(context, store.listMemories(context));
  assert(!html.includes(attack)); assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.match(html, /connect-src 'none'/); assert.match(html, /img-src 'none'/);
  const elements = new Map();
  function element(tag) {
    const node = { tag, value: '', children: [], textContent: '', append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, addEventListener() {} };
    Object.defineProperty(node, 'innerHTML', { set() { throw Error('Viewer must not use HTML injection sinks'); } });
    return node;
  }
  const sandbox = { document: { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element(selector)); return elements.get(selector); }, createElement: element }, pwned: false };
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], sandbox, { timeout: 1000 });
  assert.equal(sandbox.pwned, false);
  assert(elements.get('#records').children.some(card => card.children[0].textContent === malicious.title));
  const output = path.join(root, 'view.html'); assert.equal(writeView(context, output).path, output);
  const viewBytes = fs.readFileSync(output);
  assert.throws(() => writeView(context, output), /EEXIST/); assert.deepEqual(fs.readFileSync(output), viewBytes);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const linked = path.join(root, 'linked'); fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeView(context, path.join(linked, 'file.html')), /Refusing symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);

  const settings = path.join(store.memoryPath(context), 'settings.json');
  fs.writeFileSync(settings, '{broken');
  assert.throws(() => runtime.readSettings(context), /Invalid local memory settings/);
  assert.throws(() => runtime.captureHook(context, ['claude'], { transcript_path: transcript }, cwd, 'push'), /Invalid local memory settings/);
  assert.throws(() => runtime.buildContext(context), /Invalid local memory settings/);
  console.log('Memory runtime, command, context, and inert viewer tests passed.');
} finally {
  for (const [key, value] of oldEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  assert.equal(fs.realpathSync.native(root), root);
  assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(root).startsWith('mm-memory-runtime-'));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
