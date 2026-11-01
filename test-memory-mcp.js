const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { buildServer, TOOLS, VERSIONS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = require('./memory-mcp');
const store = require('./memory-store');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-memory-mcp-')));
const projectA = path.join(root, 'project-a'), projectB = path.join(root, 'project-b');
const context = name => ({ memRoot: path.join(root, 'mem'), projectId: 'github.com/example/' + name, store: { github: 'https://github.com/example/memory.git' } });
const init = version => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'tests', version: '1' } } });
const request = (method, params = {}, id = 2) => ({ jsonrpc: '2.0', id, method, params });
const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
const content = response => JSON.parse(response.result.content[0].text);
async function test() {
  for (const version of [...VERSIONS, 'unknown-version']) {
    const server = buildServer();
    assert.equal((await server.handle(init(version))).result.protocolVersion, VERSIONS.includes(version) ? version : VERSIONS[0]);
    assert.equal(await server.handle(notification), null);
    const listed = await server.handle(request('tools/list'));
    assert.equal(listed.result.tools.length, 6);
    assert.equal(Boolean(listed.result.tools[0].annotations), version !== '2024-11-05');
    assert((await server.handle(init(version))).error, 'initialization cannot reset an existing server');
  }
  let resolves = 0;
  const server = buildServer({ resolveMemoryContext: directory => { resolves++; return context(directory === projectA ? 'a' : 'b'); } });
  assert.equal((await server.handle(request('ping'))).result.constructor, Object);
  assert.equal((await server.handle(request('tools/list'))).error.code, -32600);
  assert.equal((await server.handle(request('server/discover'))).error.code, -32601);
  assert.equal((await server.handle(init('2025-11-25'))).result.serverInfo.name, 'mem-mastero-memory');
  await server.handle(notification);
  const call = (name, args) => server.handle(request('tools/call', { name, arguments: args }));
  for (const args of [{}, { cwd: 'relative', query: '' }, { cwd: projectA, query: '', unexpected: true }, { cwd: projectA, query: '', limit: 101 },
    { cwd: projectA, query: '', from: 'invalid' }, { cwd: projectA, query: '', from: '2026-10-01', to: '2026-01-01' }]) {
    assert.equal((await call('memory_search', args)).error.code, -32602);
  }
  assert.equal(resolves, 0, 'invalid requests cannot trigger project or filesystem resolution');
  assert.equal((await call('unknown', { cwd: projectA })).error.code, -32602);
  assert.equal((await server.handle(request('tools/list', { cursor: 'invalid' }))).error.code, -32602);
  const saved = content(await call('memory_save', { cwd: projectA, kind: 'decision', title: 'Retry policy',
    text: 'Use exponential backoff for transient failures. <private>HIDDEN MEMORY</private> password=SECRET', tags: ['retries'],
    agent: 'claude', sessionId: 'session-1', eventId: 'message:2', archiveNode: 'archive:' + 'a'.repeat(64) })).saved;
  assert.match(saved.id, /^memory:[a-f0-9]{64}$/);
  const matches = content(await call('memory_search', { cwd: projectA, query: 'retry backoff', limit: 10 })).memories;
  assert.equal(matches.length, 1); assert.equal(matches[0].id, saved.id); assert(!Object.hasOwn(matches[0], 'text'));
  assert(!JSON.stringify(matches).includes('HIDDEN MEMORY')); assert(!JSON.stringify(matches).includes('SECRET'));
  assert.deepEqual(content(await call('memory_search', { cwd: projectB, query: '' })).memories, [], 'project is resolved independently for each call');
  const retrieved = content(await call('memory_get', { cwd: projectA, ids: [saved.id, 'memory:' + '0'.repeat(64)] }));
  assert.equal(retrieved.memories[0].id, saved.id); assert.equal(retrieved.missing.length, 1);
  assert(retrieved.memories[0].text.includes('exponential backoff'));
  assert.deepEqual(retrieved.memories[0].source, { agent: 'claude', sessionId: 'session-1', eventId: 'message:2', archiveNode: 'archive:' + 'a'.repeat(64) });
  assert((await call('memory_save', { cwd: projectA, text: 'Invalid reference', archiveNode: '../arbitrary-path' })).error);
  assert((await call('memory_save', { cwd: projectA, text: 'Invalid session', sessionId: '../session' })).error);
  assert.equal(content(await call('memory_timeline', { cwd: projectA, id: saved.id })).memories[0].id, saved.id);
  assert.equal(content(await call('memory_get', { cwd: projectB, ids: [saved.id] })).memories.length, 0);
  assert((await call('memory_get', { cwd: projectA, ids: ['../../arbitrary-file'] })).error);
  assert((await call('memory_get', { cwd: projectA, ids: [saved.id, saved.id] })).error);
  assert.equal(content(await call('memory_forget', { cwd: projectA, id: saved.id })).forgotten, true);
  assert.equal(content(await call('memory_forget', { cwd: projectA, id: saved.id })).forgotten, true, 'forget is idempotent');
  assert.equal(content(await call('memory_get', { cwd: projectA, ids: [saved.id] })).memories.length, 0);
  assert.equal((await call('memory_save', { cwd: projectA, text: '<private>HIDDEN</private>' })).result.isError, true);
  assert(resolves >= 10);

  const save = TOOLS.find(tool => tool.name === 'memory_save'), forget = TOOLS.find(tool => tool.name === 'memory_forget');
  assert.equal(save.annotations.readOnlyHint, false); assert.equal(save.annotations.idempotentHint, false);
  assert.equal(forget.annotations.destructiveHint, true);
  for (const tool of TOOLS) { assert(tool.inputSchema.required.includes('cwd')); assert.equal(tool.inputSchema.additionalProperties, false); }
  assert.equal((await server.handleLine('{broken')).error.code, -32700);
  assert.equal((await server.handleLine('[]')).error.code, -32600);
  assert.equal((await server.handleLine('x'.repeat(MAX_REQUEST_BYTES + 1))).error.code, -32600);
  assert.equal((await server.handle({ ...request('ping'), id: null })).error.code, -32600);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 100 } }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'memory_save', arguments: { cwd: projectA, text: 'Must not save notification' } } }), null);

  // A producer cannot retain an unbounded line. The stream recovers at the next
  // newline and still processes the following complete request.
  const pieces = [Buffer.from(JSON.stringify(init('2025-11-25')) + '\n' + JSON.stringify(notification) + '\n'),
    Buffer.alloc(MAX_REQUEST_BYTES, 120), Buffer.from('x\n'), Buffer.from(JSON.stringify(request('ping', {}, 42)) + '\n')];
  let output = '';
  await buildServer().run(Readable.from(pieces), new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }));
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3); assert.equal(responses[1].error.code, -32600); assert.equal(responses[2].id, 42);
  assert(responses.every(response => Buffer.byteLength(JSON.stringify(response) + '\n') <= MAX_RESPONSE_BYTES));
  let invalidUtf8 = '';
  await buildServer().run(Readable.from([Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])]),
    new Writable({ write(chunk, encoding, done) { invalidUtf8 += chunk.toString(); done(); } }));
  assert.equal(JSON.parse(invalidUtf8).error.code, -32700, 'invalid UTF-8 is rejected instead of replacing bytes before persistence');

  const oversized = buildServer({ resolveMemoryContext: () => context('a'), store: { getMemories: () => [{ text: 'x'.repeat(MAX_RESPONSE_BYTES) }] } });
  await oversized.handle(init('2025-11-25')); await oversized.handle(notification);
  const bounded = await oversized.handle(request('tools/call', { name: 'memory_get', arguments: { cwd: projectA, ids: [saved.id] } }));
  assert.equal(bounded.result.isError, true); assert(Buffer.byteLength(JSON.stringify(bounded)) < MAX_RESPONSE_BYTES);
  const failing = buildServer({ resolveMemoryContext: () => { throw new Error('secret-token-value'); } });
  await failing.handle(init('2025-11-25')); await failing.handle(notification);
  const error = await failing.handle(request('tools/call', { name: 'memory_search', arguments: { cwd: projectA, query: '' } }));
  assert.equal(error.result.isError, true); assert(!JSON.stringify(error).includes('secret-token-value'));

  const child = spawnSync(process.execPath, [path.join(__dirname, 'memory-mcp.js')], { cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root }, encoding: 'utf8', timeout: 10000,
    input: [init('2025-11-25'), notification, request('tools/list'), request('ping', {}, 3)].map(value => JSON.stringify(value)).join('\n') + '\n' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  const real = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(real.length, 3); assert.equal(real[1].result.tools.length, 6);
  console.log('Memory MCP tests passed');
}
test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = fs.realpathSync.native(root);
  if (resolved !== root || !path.basename(resolved).startsWith('mm-memory-mcp-')) throw new Error('Unexpected cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
