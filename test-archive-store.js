const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createArchiveStore, repositoryOf, githubRequest, BRANCH, MAX_BLOB_BYTES } = require('./archive-store');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const objectHash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const error = status => Object.assign(new Error('secret server diagnostic'), { status });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-archive-store-test-'));
let number = 0;
const makeDir = () => { const dir = path.join(root, String(++number)); fs.mkdirSync(dir); return dir; };
function snapshot(sessionId = 'session-1', content = 'a transcript\n') {
  const dir = makeDir();
  const manifest = Buffer.from(JSON.stringify({ sessionId, files: [{ path: `${sessionId}.jsonl`, sha256: sha(content) }] }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(dir, 'payload-000001.gz'), content);
  return { projectId: 'github.com/example/project', sessionId, revision: sha(manifest), dir };
}

function server() {
  const calls = [], blobs = new Map(), trees = new Map(), commits = new Map();
  let sequence = 0;
  const state = { head: null, private: true, initialized: true, race: false, truncate: false, mutateTree: null, corruptBlob: false, failBlob: false, failPublish: false };
  const id = () => crypto.createHash('sha1').update(String(++sequence)).digest('hex');
  const main = id();
  const ref = () => ({ ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha: state.head } });
  const request = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    const suffix = endpoint.replace(/^repos\/example\/memory/, '');
    if (method === 'GET' && suffix === '') return { private: state.private, default_branch: 'main' };
    if (method === 'GET' && suffix === '/git/ref/heads/main') {
      if (!state.initialized) throw error(409);
      return { object: { type: 'commit', sha: main } };
    }
    if (method === 'GET' && suffix === `/git/ref/heads/${BRANCH}`) {
      if (!state.head) throw error(404);
      return ref();
    }
    if (method === 'POST' && suffix === '/git/blobs') {
      if (state.failBlob) throw error(503);
      const bytes = Buffer.from(body.content, 'base64'), key = objectHash(bytes);
      blobs.set(key, bytes);
      return { sha: key };
    }
    if (method === 'GET' && suffix.startsWith('/git/blobs/')) {
      const key = suffix.slice('/git/blobs/'.length), bytes = blobs.get(key);
      if (!bytes) throw error(404);
      return { sha: key, size: bytes.length, encoding: 'base64', content: state.corruptBlob ? Buffer.alloc(bytes.length, 42).toString('base64') : bytes.toString('base64') };
    }
    if (method === 'POST' && suffix === '/git/trees') {
      const key = id(), entries = new Map((trees.get(body.base_tree) || []).map(e => [e.path, e]));
      for (const item of body.tree) entries.set(item.path, { ...item, size: blobs.get(item.sha).length });
      trees.set(key, [...entries.values()]);
      return { sha: key };
    }
    if (method === 'GET' && suffix.startsWith('/git/trees/')) {
      const key = suffix.slice('/git/trees/'.length).split('?')[0];
      const entries = JSON.parse(JSON.stringify(trees.get(key)));
      if (state.mutateTree) state.mutateTree(entries);
      return { sha: key, truncated: state.truncate, tree: entries };
    }
    if (method === 'POST' && suffix === '/git/commits') {
      const key = id(); commits.set(key, body); return { sha: key };
    }
    if (method === 'GET' && suffix.startsWith('/git/commits/')) {
      const commit = commits.get(suffix.slice('/git/commits/'.length));
      return { tree: { sha: commit.tree } };
    }
    if (method === 'POST' && suffix === '/git/refs') {
      assert.equal(body.ref, `refs/heads/${BRANCH}`);
      if (state.head || state.failPublish) throw error(422);
      state.head = body.sha; return ref();
    }
    if (method === 'PATCH' && suffix === `/git/refs/heads/${BRANCH}`) {
      assert.equal(body.force, false, 'archive history must never be force rewritten');
      if (state.failPublish) throw error(422);
      if (state.race) {
        state.race = false;
        const concurrent = id();
        commits.set(concurrent, { tree: commits.get(state.head).tree, parents: [state.head] });
        state.head = concurrent;
        throw error(422);
      }
      if (commits.get(body.sha).parents[0] !== state.head) throw error(422);
      state.head = body.sha; return ref();
    }
    throw new Error(`unexpected request ${method} ${endpoint}`);
  };
  return { state, calls, request, blobs, trees, commits, store: createArchiveStore({ github: 'https://github.com/example/memory.git' }, { request }) };
}

try {
  for (const url of ['https://github.com/example/memory.git', 'git@github.com:example/memory.git', 'ssh://git@github.com/example/memory.git']) {
    assert.deepEqual(repositoryOf({ github: url }), { slug: 'example/memory', account: '' });
  }
  assert.deepEqual(repositoryOf({ github: 'https://work-user@github.com/example/memory.git' }), { slug: 'example/memory', account: 'work-user' });
  for (const github of ['https://github.com/example/memory?x=y', 'https://token:secret@github.com/example/memory',
    'https://bad%26echo@github.com/example/memory', 'https://github.com:8080/example/memory',
    'https://evil.test/example/memory', 'http://github.com/example/memory', '/local/repo', 'https://github.com/../memory']) {
    assert.throws(() => repositoryOf({ github }), /invalid|requires/);
  }

  const s = server(), first = snapshot();
  assert.deepEqual(s.store.listSnapshots(first.projectId), []);
  const published = s.store.publishSnapshot(first);
  assert.equal(published.sessionId, first.sessionId);
  assert.equal(published.revision, first.revision);
  assert.deepEqual(s.commits.get(published.commit).parents, [], 'archive branch begins with a separate root, not legacy transcript history');
  assert.deepEqual(s.store.listSnapshots(first.projectId, first.sessionId), [published]);
  assert.deepEqual(s.store.listSnapshots('github.com/example/other'), []);
  const treeRequests = () => s.calls.filter(c => c.method === 'GET' && /\/git\/(?:commits|trees)\//.test(c.endpoint)).length;
  const beforeManifestReads = treeRequests();
  assert.deepEqual(s.store.readManifest(published), fs.readFileSync(path.join(first.dir, 'manifest.json')));
  assert.deepEqual(s.store.readManifest(published), fs.readFileSync(path.join(first.dir, 'manifest.json')));
  assert.equal(treeRequests(), beforeManifestReads, 'immutable commit tree is reused for catalogue manifest reads');
  const downloaded = makeDir();
  s.store.downloadSnapshot(published, downloaded);
  for (const name of fs.readdirSync(first.dir)) assert.deepEqual(fs.readFileSync(path.join(downloaded, name)), fs.readFileSync(path.join(first.dir, name)));
  assert.throws(() => s.store.downloadSnapshot(published, downloaded), /must be empty/);
  assert.throws(() => s.store.downloadSnapshot({ ...published, basePath: '../elsewhere' }, makeDir()), /descriptor does not match/);
  assert.throws(() => s.store.readManifest({ ...published, commit: '../refs' }), /invalid commit/);

  if (process.platform === 'darwin') {
    const aliasRoot = fs.mkdtempSync('/tmp/mem-archive-alias-');
    try {
      const upload = path.join(aliasRoot, 'upload');
      fs.cpSync(first.dir, upload, { recursive: true });
      assert.deepEqual(s.store.publishSnapshot({ ...first, dir: upload }), published, 'backend accepts the standard /tmp system alias');
      s.store.downloadSnapshot(published, path.join(aliasRoot, 'download'));
      fs.symlinkSync(upload, path.join(aliasRoot, 'user-link'), 'dir');
      assert.throws(() => s.store.publishSnapshot({ ...first, dir: path.join(aliasRoot, 'user-link') }), /real directories/, 'system alias support does not allow user-created child links');
    } finally {
      const resolved = fs.realpathSync.native(aliasRoot);
      assert.equal(path.dirname(resolved), fs.realpathSync.native('/tmp'));
      assert(path.basename(resolved).startsWith('mem-archive-alias-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  const writes = () => s.calls.filter(c => c.method !== 'GET').length;
  const before = writes();
  assert.deepEqual(s.store.publishSnapshot(first), published);
  assert.equal(writes(), before, 'identical revisions do not republish');
  fs.writeFileSync(path.join(first.dir, 'payload-000001.gz'), 'different bytes');
  assert.throws(() => s.store.publishSnapshot(first), /different contents/);

  const second = snapshot('session-2', 'next transcript');
  s.state.race = true;
  const secondPublished = s.store.publishSnapshot(second);
  assert.equal(s.store.listSnapshots(first.projectId).length, 2, 'concurrent append preserves earlier archives');
  assert.equal(s.commits.get(secondPublished.commit).parents.length, 1);
  assert(s.calls.filter(c => c.method === 'PATCH').every(c => c.body.force === false));
  assert.equal(s.calls.filter(c => c.method === 'POST' && c.endpoint.endsWith('/git/blobs')).length, 4, 'CAS retry reuses uploaded blobs');
  // A descriptor from an earlier commit continues to restore that exact snapshot.
  const oldDownload = makeDir();
  s.store.downloadSnapshot(published, oldDownload);
  assert.equal(fs.readFileSync(path.join(oldDownload, 'payload-000001.gz'), 'utf8'), 'a transcript\n');
  const large = snapshot('session-large', crypto.randomBytes(2 * 1024 * 1024));
  const largePublished = s.store.publishSnapshot(large), largeDownload = makeDir();
  s.store.downloadSnapshot(largePublished, largeDownload);
  assert.deepEqual(fs.readFileSync(path.join(large.dir, 'payload-000001.gz')), fs.readFileSync(path.join(largeDownload, 'payload-000001.gz')), 'multi-megabyte base64 decoding must not overflow the regular expression stack');

  for (const flag of ['failBlob', 'failPublish']) {
    const failing = server(); failing.state[flag] = true;
    const candidate = snapshot();
    assert.throws(() => failing.store.publishSnapshot(candidate));
    assert.equal(failing.state.head, null, 'failed publication never produces a published descriptor');
    assert(fs.existsSync(path.join(candidate.dir, 'manifest.json')), 'backend never deletes source files');
  }
  const empty = server(); empty.state.initialized = false;
  assert.throws(() => empty.store.publishSnapshot(snapshot()), /initialize.*normal sync/);
  assert(!empty.calls.some(c => c.method !== 'GET'), 'empty repos are not silently initialized');
  for (const visibility of [false, undefined, 'true']) {
    const publicStore = server(); publicStore.state.private = visibility;
    assert.throws(() => publicStore.store.publishSnapshot(snapshot()), /private/);
    assert(!publicStore.calls.some(c => c.method !== 'GET'));
  }
  s.state.private = false;
  assert.throws(() => s.store.downloadSnapshot(published, makeDir()), /private/);
  s.state.private = true;
  s.state.corruptBlob = true;
  assert.throws(() => s.store.downloadSnapshot(published, makeDir()), /checksum/);
  s.state.corruptBlob = false;
  s.state.truncate = true;
  const freshStore = () => createArchiveStore({ github: 'https://github.com/example/memory.git' }, { request: s.request });
  assert.throws(() => freshStore().listSnapshots(first.projectId), /incomplete/);
  s.state.truncate = false;
  for (const mutation of [
    entries => { entries[0].path = '../outside'; },
    entries => { entries[0].mode = '120000'; },
    entries => { entries[0].size = MAX_BLOB_BYTES + 1; },
    entries => { entries.push({ ...entries[0] }); },
    entries => { entries[0].path = entries[0].path.replace('manifest.json', 'payload-../../outside'); },
  ]) {
    s.state.mutateTree = mutation;
    assert.throws(() => freshStore().downloadSnapshot(published, makeDir()), /invalid|unsupported|oversized/);
  }
  s.state.mutateTree = null;
  const huge = snapshot();
  fs.writeFileSync(path.join(huge.dir, 'payload-000002.gz'), Buffer.alloc(MAX_BLOB_BYTES + 1));
  assert.throws(() => s.store.publishSnapshot(huge), /oversized/);
  const invalidRevision = snapshot(); invalidRevision.revision = '0'.repeat(64);
  assert.throws(() => s.store.publishSnapshot(invalidRevision), /manifest checksum/);
  const invalidFile = snapshot(); fs.writeFileSync(path.join(invalidFile.dir, 'extra.txt'), 'x');
  assert.throws(() => s.store.publishSnapshot(invalidFile), /invalid archive snapshot files/);
  const symlinkTarget = makeDir(), symlinkDir = path.join(root, 'symlink-dir');
  fs.symlinkSync(symlinkTarget, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => s.store.downloadSnapshot(published, symlinkDir), /real directories/);

  const authCalls = [];
  const run = (cmd, args, options) => {
    authCalls.push({ cmd, args, options });
    if (args[0] === 'auth') return { status: 0, stdout: 'secret-test-token\n' };
    return { status: 0, stdout: 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"ok":true}\n' };
  };
  const request = githubRequest('work-user', run);
  assert.deepEqual(request('POST', 'repos/example/memory/git/blobs', { content: 'private-payload' }), { ok: true });
  assert.equal(authCalls[0].args.at(-1), 'work-user');
  assert.equal(authCalls[1].options.env.GH_TOKEN, 'secret-test-token');
  assert(!JSON.stringify(authCalls[1].args).includes('secret-test-token'));
  assert(!JSON.stringify(authCalls[1].args).includes('private-payload'));
  assert.equal(authCalls[1].options.input, '{"content":"private-payload"}');
  const rejected = githubRequest('', () => ({ status: 1, stdout: 'HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{"message":"secret diagnostic"}', stderr: 'secret stderr' }));
  assert.throws(() => rejected('GET', 'repos/example/memory'), e => e.status === 404 && !/secret/.test(e.message));
  const timeout = githubRequest('', () => ({ status: null, error: new Error('secret timeout'), stdout: '' }));
  assert.throws(() => timeout('GET', 'repos/example/memory'), /request failed/);
  console.log('Archive store tests passed.');
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('mem-archive-store-test-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
