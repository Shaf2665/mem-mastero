// node test.js — machine A -> Drive -> machine B (different local folder names), then nothing left to copy
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncDir, normalizeRemote } = require('./sync');

for (const u of ['git@github.com:o/R.git', 'https://github.com/o/r', 'https://user@github.com/o/r.git/', 'ssh://git@github.com:22/o/r.git']) {
  assert.strictEqual(normalizeRemote(u), 'github.com/o/r', u);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mastero-'));
const A = path.join(tmp, 'D--Work-repo'), B = path.join(tmp, 'C--Users-x-repo'), drive = path.join(tmp, 'drive');
fs.mkdirSync(path.join(A, 'memory'), { recursive: true });
fs.writeFileSync(path.join(A, 'memory', 'MEMORY.md'), '- fact');
fs.writeFileSync(path.join(A, 's1.jsonl'), '{}');

assert.strictEqual(syncDir(A, drive).length, 2);       // A pushes
assert.strictEqual(syncDir(drive, B).length, 2);       // B pulls
assert.strictEqual(fs.readFileSync(path.join(B, 'memory', 'MEMORY.md'), 'utf8'), '- fact');
assert(Math.abs(fs.statSync(path.join(B, 's1.jsonl')).mtimeMs - fs.statSync(path.join(A, 's1.jsonl')).mtimeMs) < 1000); // mtime carried over
for (const [s, d] of [[A, drive], [drive, A], [B, drive], [drive, B]]) assert.strictEqual(syncDir(s, d).length, 0); // no ping-pong

// B edits memory later -> flows back to A
const later = new Date(Date.now() + 10000);
fs.writeFileSync(path.join(B, 'memory', 'MEMORY.md'), '- fact\n- new');
fs.utimesSync(path.join(B, 'memory', 'MEMORY.md'), later, later);
assert.deepStrictEqual(syncDir(B, drive), [path.join('memory', 'MEMORY.md')]);
syncDir(drive, A);
assert.strictEqual(fs.readFileSync(path.join(A, 'memory', 'MEMORY.md'), 'utf8'), '- fact\n- new');

fs.rmSync(tmp, { recursive: true });
console.log('ok');
