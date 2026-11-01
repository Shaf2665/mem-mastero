// Cold archives use GitHub's object API, never a persistent local Git clone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BRANCH = 'mem-mastero-archives-v1';
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10000;
const SHA = /^[a-f0-9]{40}$/;
const REVISION = /^[a-f0-9]{64}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FILE = /^(?:manifest\.json|payload-[0-9]{6}\.gz)$/;
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const gitBlobHash = b => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

function repositoryOf(store) {
  if (!store || typeof store.github !== 'string') throw new Error('archiving requires a private github.com memory repository');
  const remote = store.github;
  let account = '', owner, repo;
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(remote);
  if (ssh) [, owner, repo] = ssh;
  else {
    let url;
    try { url = new URL(remote); } catch { throw new Error('archiving requires a private github.com memory repository'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.port || url.search || url.hash || url.password) {
      throw new Error('invalid archive repository URL; use a github.com URL without passwords or tokens');
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match) throw new Error('invalid archive repository path');
    [, owner, repo] = match;
    try { account = decodeURIComponent(url.username); } catch { throw new Error('invalid GitHub account name'); }
    if (url.protocol === 'ssh:') {
      if (account && account !== 'git') throw new Error('invalid GitHub SSH account');
      account = '';
    } else if (account && !ACCOUNT.test(account)) throw new Error('invalid GitHub account name');
  }
  if (['.', '..'].includes(owner) || ['.', '..'].includes(repo)) throw new Error('invalid archive repository path');
  return { slug: `${owner}/${repo}`, account };
}

function apiError(status) {
  return Object.assign(new Error(`archive GitHub request failed${status ? ` (HTTP ${status})` : ''}; check authentication, connectivity, and repository permissions`), { status });
}

// --input - keeps archive contents out of process arguments and temporary files.
function githubRequest(account, run = spawnSync) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  if (account) {
    const token = run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account], {
      env, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    if (token.status !== 0 || !token.stdout?.trim()) throw new Error('sign in to GitHub CLI with the account named in the memory repository URL');
    env.GH_TOKEN = token.stdout.trim();
  }
  return (method, endpoint, body) => {
    const args = ['api', '--hostname', 'github.com', '--include', '--method', method,
      '-H', 'Accept: application/vnd.github+json', endpoint];
    if (body !== undefined) args.push('--input', '-');
    const result = run('gh', args, {
      env, input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8',
      timeout: 120000, maxBuffer: 24 * 1024 * 1024, windowsHide: true,
    });
    const output = result.stdout || '';
    const match = /^HTTP\/[^\s]+\s+(\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(output);
    const status = match ? Number(match[1]) : undefined;
    if (result.status !== 0 || !status || status < 200 || status > 299) throw apiError(status);
    try { return JSON.parse(match[2]); } catch { throw new Error('invalid JSON in archive GitHub response'); }
  };
}

function objectSha(value, description) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`invalid ${description} in archive response`);
  return value;
}

function snapshotPath(projectId, sessionId, revision) {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 4096) throw new Error('invalid archive project ID');
  if (typeof sessionId !== 'string' || !SESSION.test(sessionId)) throw new Error('invalid archive session ID');
  if (typeof revision !== 'string' || !REVISION.test(revision)) throw new Error('invalid archive revision');
  return `v1/${hash(projectId)}/${sessionId}/${revision}`;
}

function safeDirectory(dir) {
  const resolved = path.resolve(dir);
  // Reparse points/symlinks in any ancestor could redirect downloaded data.
  let cursor = resolved;
  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('archive staging path must contain only real directories');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolved;
}

function localFiles(dir) {
  const root = safeDirectory(dir);
  const names = fs.readdirSync(root).sort();
  if (!names.includes('manifest.json') || names.length > MAX_FILES || names.some(name => !FILE.test(name))) throw new Error('invalid archive snapshot files');
  return names.map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BLOB_BYTES) throw new Error('archive snapshot contains a non-file or oversized chunk');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== stat.size || bytes.length > MAX_BLOB_BYTES) throw new Error('archive snapshot changed while reading');
    return { name, file, size: bytes.length, sha: gitBlobHash(bytes) };
  });
}

function createArchiveStore(store, options = {}) {
  const { slug, account } = repositoryOf(store);
  const request = options.request || githubRequest(account, options.spawnSync);
  const endpoint = `repos/${slug}`;
  const api = (method, suffix = '', body) => request(method, endpoint + suffix, body);
  const treesByCommit = new Map();

  function privateRepository() {
    const repo = api('GET');
    if (repo?.private !== true) throw new Error('cannot verify archive repository is private; no archive data was changed');
    return repo;
  }

  function branchHead() {
    let ref;
    try { ref = api('GET', `/git/ref/heads/${BRANCH}`); }
    catch (e) { if (e.status === 404) return null; throw e; }
    if (ref?.ref !== `refs/heads/${BRANCH}` || ref?.object?.type !== 'commit') throw new Error('invalid archive branch reference');
    return objectSha(ref.object.sha, 'commit');
  }

  function readTree(commit) {
    objectSha(commit, 'commit');
    if (treesByCommit.has(commit)) return treesByCommit.get(commit);
    const treeSha = objectSha(api('GET', `/git/commits/${commit}`)?.tree?.sha, 'tree');
    const tree = api('GET', `/git/trees/${treeSha}?recursive=1`);
    if (!tree || tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error('archive tree is incomplete; refusing a partial archive listing');
    const seen = new Set();
    const entries = tree.tree.filter(entry => {
      if (!entry || typeof entry.path !== 'string' || entry.path.length > 512 || entry.path.split('/').some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f\x7f]/.test(p)) || seen.has(entry.path)) {
        throw new Error('invalid or duplicate path in archive tree');
      }
      seen.add(entry.path);
      objectSha(entry.sha, 'object');
      if (entry.type === 'tree' && entry.mode === '040000') return false;
      if (entry.type !== 'blob' || entry.mode !== '100644' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BLOB_BYTES
        || !/^v1\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[a-f0-9]{64}\/(?:manifest\.json|payload-[0-9]{6}\.gz)$/.test(entry.path)) {
        throw new Error('unsupported or oversized file in archive tree');
      }
      return true;
    });
    // Commits are immutable. A catalogue listing followed by N manifest reads needs one tree request.
    treesByCommit.set(commit, entries);
    return entries;
  }

  function descriptors(projectId, sessionId, commit, tree) {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 4096) throw new Error('invalid archive project ID');
    if (sessionId !== undefined && !SESSION.test(sessionId)) throw new Error('invalid archive session ID');
    const prefix = `v1/${hash(projectId)}/`;
    return tree.filter(e => e.path.startsWith(prefix) && e.path.endsWith('/manifest.json')).map(e => {
      const [, , id, revision] = e.path.split('/');
      return { projectId, sessionId: id, revision, basePath: e.path.slice(0, -'/manifest.json'.length), commit };
    }).filter(d => sessionId === undefined || d.sessionId === sessionId);
  }

  function descriptorPath(descriptor) {
    const base = snapshotPath(descriptor?.projectId, descriptor?.sessionId, descriptor?.revision);
    if (descriptor.basePath !== base) throw new Error('archive descriptor does not match its project and session');
    objectSha(descriptor.commit, 'commit');
    return base;
  }

  function readBlob(entry) {
    const blob = api('GET', `/git/blobs/${entry.sha}`);
    if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > MAX_BLOB_BYTES * 1.5
      || blob.sha !== entry.sha || blob.size !== entry.size) throw new Error('archive blob metadata does not match the committed snapshot');
    const encoded = blob.content.replace(/[\r\n]/g, '');
    if (encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('invalid base64 in archive blob');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('invalid base64 in archive blob');
    if (bytes.length !== entry.size || gitBlobHash(bytes) !== entry.sha) throw new Error('archive blob checksum verification failed');
    return bytes;
  }

  function snapshotEntries(descriptor) {
    const base = descriptorPath(descriptor);
    const entries = readTree(descriptor.commit).filter(e => e.path.startsWith(base + '/'));
    if (!entries.some(e => e.path === `${base}/manifest.json`) || entries.length > MAX_FILES) throw new Error('archive snapshot is missing or has too many files');
    return entries;
  }

  return {
    publishSnapshot({ projectId, sessionId, revision, dir }) {
      const basePath = snapshotPath(projectId, sessionId, revision);
      const files = localFiles(dir);
      if (hash(fs.readFileSync(path.join(dir, 'manifest.json'))) !== revision) throw new Error('archive revision does not match the manifest checksum');
      const repo = privateRepository();
      // GitHub cannot create references in an entirely empty repository.
      if (!repo.default_branch || typeof repo.default_branch !== 'string') throw new Error('initialize the private memory repository before archiving');
      try { api('GET', `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`); }
      catch (e) { if ([404, 409].includes(e.status)) throw new Error('initialize the private memory repository with a normal sync before archiving'); throw e; }
      let uploaded = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const head = branchHead();
        const tree = head ? readTree(head) : [];
        const existing = tree.filter(e => e.path.startsWith(basePath + '/'));
        if (existing.length) {
          if (existing.length !== files.length || files.some(f => !existing.some(e => e.path === `${basePath}/${f.name}` && e.sha === f.sha && e.size === f.size))) {
            throw new Error('archive revision already exists with different contents; refusing to overwrite');
          }
          return { projectId, sessionId, revision, basePath, commit: head };
        }
        if (!uploaded) {
          for (const f of files) {
            const bytes = fs.readFileSync(f.file);
            if (bytes.length !== f.size || gitBlobHash(bytes) !== f.sha) throw new Error('archive snapshot changed before upload');
            const blob = api('POST', '/git/blobs', { encoding: 'base64', content: bytes.toString('base64') });
            if (blob?.sha !== f.sha) throw new Error('uploaded archive blob checksum does not match');
          }
          uploaded = true;
        }
        const newTree = api('POST', '/git/trees', {
          ...(head ? { base_tree: objectSha(api('GET', `/git/commits/${head}`)?.tree?.sha, 'tree') } : {}),
          tree: files.map(f => ({ path: `${basePath}/${f.name}`, mode: '100644', type: 'blob', sha: f.sha })),
        });
        const commit = objectSha(api('POST', '/git/commits', {
          message: 'Archive Claude session with mem-mastero', tree: objectSha(newTree?.sha, 'tree'), parents: head ? [head] : [],
        })?.sha, 'commit');
        try {
          if (head) api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit, force: false });
          else api('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit });
          // Check the branch still reaches the immutable files, even if a concurrent writer appended.
          const current = branchHead();
          const committed = readTree(current).filter(e => e.path.startsWith(basePath + '/'));
          if (committed.length !== files.length || files.some(f => !committed.some(e => e.path === `${basePath}/${f.name}` && e.sha === f.sha && e.size === f.size))) {
            throw new Error('published archive is not present in the remote branch');
          }
          return { projectId, sessionId, revision, basePath, commit: current };
        } catch (e) {
          if (![409, 422].includes(e.status)) throw e;
          const current = branchHead();
          if (current === head || attempt === 3) throw new Error('archive branch update was rejected; no local sessions should be removed');
        }
      }
      throw new Error('archive branch changed repeatedly; retry archiving');
    },

    listSnapshots(projectId, sessionId) {
      privateRepository();
      const head = branchHead();
      return head ? descriptors(projectId, sessionId, head, readTree(head)) : [];
    },

    readManifest(descriptor) {
      privateRepository();
      const entry = snapshotEntries(descriptor).find(e => e.path.endsWith('/manifest.json'));
      const bytes = readBlob(entry);
      if (hash(bytes) !== descriptor.revision) throw new Error('archive manifest checksum does not match its revision');
      return bytes;
    },

    downloadSnapshot(descriptor, destDir) {
      privateRepository();
      const entries = snapshotEntries(descriptor);
      const root = safeDirectory(destDir);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(root).length) throw new Error('archive download directory must be empty');
      for (const entry of entries) {
        const bytes = readBlob(entry);
        if (entry.path.endsWith('/manifest.json') && hash(bytes) !== descriptor.revision) throw new Error('archive manifest checksum does not match its revision');
        fs.writeFileSync(path.join(root, path.posix.basename(entry.path)), bytes, { flag: 'wx', mode: 0o600 });
      }
      return descriptor;
    },
  };
}

module.exports = { createArchiveStore, repositoryOf, githubRequest, BRANCH, MAX_BLOB_BYTES };
