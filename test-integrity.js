// node test-integrity.js — interrupted writes and timestamp collisions never lose the good copy.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MEM_MASTERO_PART_BYTES = '100';
const { atomicWrite, syncFile, syncDir, readWhole } = require('./sync');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-integrity-'));
const put = (file, bytes, time) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, new Date(time), new Date(time));
};
const base = Date.parse('2026-01-01T00:00:00Z');
const partialWrite = (matches, fn) => {
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...args) => {
    if (matches(String(file))) {
      write(file, Buffer.from(data).subarray(0, 12), ...args);
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    }
    return write(file, data, ...args);
  };
  try { fn(); } finally { fs.writeFileSync = write; }
};

try {
  const source = path.join(tmp, 'source', 'session.jsonl'), dest = path.join(tmp, 'dest', 'session.jsonl');
  put(source, 'first\n', base);
  assert(syncFile(source, dest));
  put(source, 'first\nsecond\n', base + 1000);
  assert(syncFile(source, dest), 'one-second append is copied');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'first\nsecond\n');
  assert(!syncFile(source, dest) && !syncFile(dest, source), 'unchanged bytes do not ping-pong');
  put(source, 'equal timestamp, different bytes\n', base + 1000);
  assert.throws(() => syncFile(source, dest), /same timestamp/);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'first\nsecond\n', 'conflict keeps destination');
  assert.strictEqual(fs.readFileSync(source, 'utf8'), 'equal timestamp, different bytes\n', 'conflict keeps source');
  put(source, 'old\n', base);
  assert(!syncFile(source, dest), 'older copy cannot overwrite a newer one');
  const rounded = path.join(tmp, 'rounded.jsonl');
  put(source, 'fractional mtime\n', base + 2000);
  const fractionalSeconds = (base + 2000.125) / 1000;
  fs.utimesSync(source, fractionalSeconds, fractionalSeconds);
  assert(syncFile(source, rounded));
  assert(!syncFile(source, rounded) && !syncFile(rounded, source), 'timestamp precision differences do not repeat copies');

  const savedTime = fs.statSync(dest).mtimeMs;
  partialWrite(file => file.endsWith('.tmp'), () => {
    assert.throws(() => atomicWrite(dest, 'replacement must finish before publishing', base + 2000), /disk full/);
  });
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'first\nsecond\n');
  assert.strictEqual(fs.statSync(dest).mtimeMs, savedTime, 'failed replacement preserves the good timestamp');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dest)), ['session.jsonl'], 'failed temporary file is removed');
  if (process.platform !== 'win32') {
    fs.chmodSync(dest, 0o600);
    atomicWrite(dest, 'first\nsecond\n', savedTime);
    assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600, 'replacement preserves private file permissions');
    const privateFile = path.join(tmp, 'private.json');
    atomicWrite(privateFile, '{}');
    assert.strictEqual(fs.statSync(privateFile).mode & 0o777, 0o600, 'new files are private by default');
  }

  const large = path.join(tmp, 'large', 'session.jsonl'), remote = path.join(tmp, 'remote', 'session.jsonl');
  const data = Array.from({ length: 20 }, (_, i) => JSON.stringify({ turn: i, text: 'original' })).join('\n') + '\n';
  put(large, data, base + 3000);
  assert(syncFile(large, remote));
  assert.strictEqual(readWhole(remote).toString(), data);
  const manifestPath = remote + '.parts/manifest.json';
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const updated = data.replace(/original/g, 'modified');
  put(large, updated, base + 4000);
  partialWrite(file => path.basename(file).startsWith('part-'), () => {
    assert.throws(() => syncFile(large, remote), /disk full/);
  });
  assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), manifest, 'failed generation does not replace manifest');
  assert.strictEqual(readWhole(remote).toString(), data, 'old parts still reconstruct after failed publication');
  partialWrite(file => file.endsWith('.tmp'), () => {
    assert.throws(() => syncFile(large, remote), /disk full/);
  });
  assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), manifest, 'failed manifest publication keeps the old generation');
  assert.strictEqual(readWhole(remote).toString(), data);
  assert(syncFile(large, remote), 'successful retry replaces the failed generation');
  assert.strictEqual(readWhole(remote).toString(), updated);
  const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepStrictEqual(fs.readdirSync(remote + '.parts').sort(), ['manifest.json', ...current.parts].sort(), 'obsolete completed generation is removed');

  put(dest, 'last good local session\n', base + 2000);
  partialWrite(file => file.endsWith('.tmp'), () => {
    assert.throws(() => syncFile(remote, dest, false), /disk full/);
  });
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'last good local session\n');
  assert(syncFile(remote, dest, false), 'failed reconstructed pull remains retryable');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), updated);

  const incomplete = path.join(tmp, 'incomplete'), pulled = path.join(tmp, 'pulled');
  put(path.join(incomplete, 'pending.jsonl.parts', 'part-001.jsonl'), '{"half":true}\n', base);
  put(path.join(incomplete, '.mem-mastero-incomplete.tmp'), 'partial', base);
  assert.deepStrictEqual(syncDir(incomplete, pulled, false), [], 'unpublished parts and temporary files stay out of agent folders');
  fs.unlinkSync(path.join(remote + '.parts', current.parts[0]));
  assert.strictEqual(readWhole(remote), null, 'missing published part is rejected');
  assert(!syncFile(remote, path.join(tmp, 'missing.jsonl'), false), 'missing parts cannot produce a local session');
  assert(syncFile(large, remote), 'a good source repairs incomplete parts even with the same timestamp');
  assert.strictEqual(readWhole(remote).toString(), updated);
  put(large, 'small again\n', base + 5000);
  partialWrite(file => file.endsWith('.tmp'), () => {
    assert.throws(() => syncFile(large, remote), /disk full/);
  });
  assert.strictEqual(readWhole(remote).toString(), updated, 'failed split-to-whole transition keeps old parts');
  assert(syncFile(large, remote));
  assert.strictEqual(readWhole(remote).toString(), 'small again\n');
  assert(!fs.existsSync(remote + '.parts'), 'successful split-to-whole transition removes obsolete parts');

  console.log('integrity tests ok');
} finally {
  const resolved = fs.realpathSync.native(tmp);
  assert.strictEqual(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
  assert(path.basename(resolved).startsWith('mem-integrity-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
