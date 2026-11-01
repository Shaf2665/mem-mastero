const fs = require('node:fs');
const path = require('node:path');
const store = require('./memory-store');
const runtime = require('./memory-runtime');
const USAGE = 'Usage: memory status|sync|search [QUERY]|get ID|timeline [ID]|add --text TEXT|edit ID --text TEXT|forget ID|context|settings|capture --agent AGENT --file PATH|export --output PATH|import PATH|import-claude-mem PATH --source-project NAME [--dry-run]|view [--output PATH] [--json]';
const FLAGS = {
  status: [], sync: [], search: ['kind', 'agent', 'from', 'to', 'limit'], get: [], timeline: ['limit'],
  add: ['title', 'text', 'kind', 'tags', 'agent', 'session', 'archive-node', 'stdin'],
  edit: ['title', 'text', 'kind', 'tags', 'agent', 'session', 'archive-node', 'stdin'], forget: [],
  context: ['query', 'budget'], settings: ['capture', 'context', 'budget'], capture: ['agent', 'file', 'session'],
  export: ['output'], import: [], 'import-claude-mem': ['source-project', 'dry-run'], view: ['output'],
};
function parseMemoryArgs(args) {
  const command = args[0] || 'status', options = {}, positional = [];
  if (!Object.hasOwn(FLAGS, command)) throw new Error(USAGE);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!['json', ...FLAGS[command]].includes(key) || Object.hasOwn(options, key)) throw new Error(USAGE);
    if (['json', 'stdin', 'dry-run'].includes(key)) options[key] = true;
    else { if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(USAGE); options[key] = args[++i]; }
  }
  const required = ['get', 'edit', 'forget', 'import', 'import-claude-mem'].includes(command);
  const optional = ['search', 'timeline'].includes(command);
  if (positional.length > (required || optional ? 1 : 0) || required && positional.length !== 1) throw new Error(USAGE);
  for (const key of ['limit', 'budget']) if (options[key] !== undefined) {
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(USAGE);
    options[key] = Number(options[key]);
    if (options[key] < (key === 'limit' ? 1 : 512) || options[key] > (key === 'limit' ? 100 : 12000)) throw new Error(USAGE);
  }
  if (options.stdin && Object.keys(options).some(k => !['stdin', 'json'].includes(k))) throw new Error('Use --stdin alone for note fields');
  if (['add', 'edit'].includes(command) && !options.stdin && options.text === undefined) throw new Error(USAGE);
  if (command === 'capture' && (!options.agent || !options.file)) throw new Error(USAGE);
  if (command === 'export' && !options.output) throw new Error(USAGE);
  if (command === 'import-claude-mem' && !options['source-project']) throw new Error(USAGE);
  return { command, options, argument: positional[0] };
}
function jsonFile(file, max = 65 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Import must be a regular JSON file within the size limit');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function readNoteInput() {
  const chunks = [], buffer = Buffer.alloc(8192); let size = 0, n;
  while ((n = fs.readSync(0, buffer, 0, Math.min(buffer.length, 128 * 1024 + 1 - size), null))) {
    size += n;
    if (size > 128 * 1024) throw new Error('Memory note input exceeds 128 KiB');
    chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}
function noteFields(o, input) {
  if (o.stdin) {
    const bytes = input ? input() : readNoteInput();
    if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error('Memory note input exceeds 128 KiB');
    const value = JSON.parse(bytes);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['kind', 'title', 'text', 'tags', 'source'].includes(k))) throw new Error('Invalid note JSON fields');
    return { ...value, provenance: 'manual' };
  }
  const fields = { text: o.text, provenance: 'manual' };
  for (const key of ['title', 'kind']) if (o[key] !== undefined) fields[key] = o[key];
  if (o.tags !== undefined) fields.tags = o.tags.split(',').map(s => s.trim()).filter(Boolean);
  if (o.agent || o.session || o['archive-node']) fields.source = { agent: o.agent || 'manual', ...(o.session ? { sessionId: o.session } : {}), ...(o['archive-node'] ? { archiveNode: o['archive-node'] } : {}) };
  return fields;
}
function runMemoryCommand(args, services) {
  const { command, options: o, argument } = parseMemoryArgs(args);
  const context = services.context(), log = services.log || console.log;
  let result;
  switch (command) {
    case 'status': result = { projectId: context.projectId, settings: runtime.readSettings(context), activeMemories: store.listMemories(context).length }; break;
    case 'sync': result = services.sync(context); break;
    case 'add': result = store.addMemory(context, noteFields(o, services.input)); break;
    case 'edit': {
      const previous = store.getMemory(context, argument);
      if (!previous) throw new Error('Memory not found in this project');
      const fields = noteFields(o, services.input);
      const replacement = store.addMemory(context, { kind: previous.kind, title: previous.title, text: previous.text, tags: previous.tags, source: previous.source, ...fields });
      store.forgetMemory(context, argument);
      result = { replaced: argument, memory: replacement }; break;
    }
    case 'get': result = store.getMemory(context, argument); if (!result) throw new Error('Memory not found in this project'); break;
    case 'search': result = { matches: store.searchMemories(context, argument || '', { kind: o.kind, agent: o.agent, from: o.from, to: o.to, limit: o.limit || 20 }) }; break;
    case 'timeline': result = { memories: store.timelineMemories(context, { id: argument, limit: o.limit || 10 }) }; break;
    case 'forget': result = store.forgetMemory(context, argument); break;
    case 'context': result = { context: runtime.buildContext(context, { query: o.query, maxChars: o.budget }) }; break;
    case 'settings': {
      const change = {};
      for (const key of ['capture', 'context']) if (o[key] !== undefined) {
        if (!['on', 'off'].includes(o[key])) throw new Error(`${key} must be on or off`);
        change[key] = o[key] === 'on';
      }
      if (o.budget !== undefined) change.contextChars = o.budget;
      result = Object.keys(change).length ? runtime.updateSettings(context, change) : runtime.readSettings(context); break;
    }
    case 'capture': {
      const settings = runtime.readSettings(context);
      if (!settings.capture) throw new Error('Memory capture is paused for this project');
      const options = runtime.transcriptOptions(o.agent, { transcript_path: path.resolve(o.file), session_id: o.session }, context.cwd || process.cwd());
      options.minCreatedAt = settings.captureSince;
      result = require('./memory-capture').captureTranscript(context, options); break;
    }
    case 'export': {
      const bytes = JSON.stringify(store.exportMemories(context), null, 2) + '\n';
      const target = path.resolve(o.output); require('./archive-state').safePath(path.dirname(target), path.basename(target));
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); result = { path: target, bytes: Buffer.byteLength(bytes) }; break;
    }
    case 'import': result = store.importMemories(context, jsonFile(path.resolve(argument))); break;
    case 'import-claude-mem': result = require('./memory-import').importClaudeMem(context, jsonFile(path.resolve(argument), 32 * 1024 * 1024), { sourceProject: o['source-project'], dryRun: !!o['dry-run'] }); break;
    case 'view': result = require('./memory-view').writeView(context, o.output); break;
  }
  if (command === 'context' && !o.json) log(result.context);
  else log(JSON.stringify(result, null, 2));
  return result;
}
module.exports = { runMemoryCommand, parseMemoryArgs };
