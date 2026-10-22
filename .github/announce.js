#!/usr/bin/env node
// Announces a release when a "vX.Y.Z: ..." commit lands on main (run by .github/workflows/announce.yml):
// a GitHub Release, a one-click "Post on X" link in the run summary, and, if their secrets are set,
// a Bluesky post (free) and an X API post (paid). Env: COMMITS (JSON from github.event.commits) or TEXT
// (manual post), DRY_RUN=1, GITHUB_TOKEN, BLUESKY_HANDLE / BLUESKY_APP_PASSWORD,
// X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET (an X app with Read and Write permission).
const crypto = require('crypto');

// Set by GitHub Actions, so the script works unchanged when copied into another repo.
const REPO = process.env.GITHUB_REPOSITORY || 'Shaf2665/mem-mastero';
const REPO_URL = `https://github.com/${REPO}`;
const NAME = REPO.split('/')[1];
const URL_LEN = 23; // X counts every link as 23 characters
const MAX = 280;

// RFC 3986 encoding; encodeURIComponent leaves !'()* alone, OAuth needs them encoded.
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// OAuth 1.0a HMAC-SHA1 signature. With a JSON body only the oauth_* params (plus any query/form params) are signed.
function sign(method, url, params, consumerSecret, tokenSecret) {
  const paramStr = Object.keys(params).sort().map(k => `${enc(k)}=${enc(params[k])}`).join('&');
  const base = [method, enc(url), enc(paramStr)].join('&');
  return crypto.createHmac('sha1', `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest('base64');
}

function authHeader(method, url, { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET }) {
  const oauth = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = sign(method, url, oauth, X_API_SECRET, X_ACCESS_SECRET);
  return 'OAuth ' + Object.keys(oauth).map(k => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

// X's weighted length: Latin and common punctuation count 1, everything else (emoji, CJK, …) counts 2.
// ponytail: counts each code point of a ZWJ emoji sequence, so it over-counts those; that only trims a bit early.
const weight = ch => {
  const cp = ch.codePointAt(0);
  return cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
};
const xLength = s => [...s].reduce((n, ch) => n + weight(ch), 0);

// Trim to fit X's limit, counting the link as 23. Cuts on code points so emoji aren't split in half.
function fit(text, link) {
  const room = MAX - (link ? URL_LEN + 2 : 0);
  let body = text;
  if (xLength(text) > room) {
    body = '';
    for (const ch of text) {
      if (xLength(body) + weight(ch) > room - 2) break; // leave room for the "…" (weight 2)
      body += ch;
    }
    body = body.trimEnd() + '…';
  }
  return link ? `${body}\n\n${link}` : body;
}

// The newest "vX.Y.Z: description" commit in this push, or null.
function releaseOf(commits) {
  const msg = commits.map(c => c.message).filter(m => /^v\d+\.\d+\.\d+: \S/.test(m)).pop();
  if (!msg) return null;
  const [subject, ...rest] = msg.split('\n');
  const [, ver, desc] = subject.match(/^(v\d+\.\d+\.\d+): (.*)$/);
  return { ver, desc, body: rest.join('\n').trim(), text: fit(`${NAME} ${ver} is out: ${desc}`, REPO_URL) };
}

// Free: a link that opens x.com with the post already written; you only click "Post".
const xIntent = text => 'https://x.com/intent/post?text=' + encodeURIComponent(text);

async function call(label, url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${label} returned ${res.status}: ${body}`);
  return JSON.parse(body);
}

// Free: Bluesky's API. Links only become clickable through a "facet" with UTF-8 byte offsets.
async function postBluesky(text, { BLUESKY_HANDLE, BLUESKY_APP_PASSWORD }) {
  const json = { 'Content-Type': 'application/json' };
  const session = await call('Bluesky login', 'https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST', headers: json, body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD }),
  });
  const { uri } = await call('Bluesky post', 'https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { ...json, Authorization: `Bearer ${session.accessJwt}` },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: { $type: 'app.bsky.feed.post', text, facets: linkFacets(text), createdAt: new Date().toISOString() },
    }),
  });
  return `https://bsky.app/profile/${BLUESKY_HANDLE}/post/${uri.split('/').pop()}`;
}

function linkFacets(text) {
  return [...text.matchAll(/https?:\/\/\S+/g)].map(m => {
    const byteStart = Buffer.byteLength(text.slice(0, m.index));
    return {
      index: { byteStart, byteEnd: byteStart + Buffer.byteLength(m[0]) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    };
  });
}

// Paid ($0.015 a post, $0.20 with a link): X's API. Only runs when the four X_* secrets are set.
async function postX(text, env) {
  const url = 'https://api.x.com/2/tweets';
  const { data } = await call('X', url, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', url, env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return `https://x.com/i/web/status/${data.id}`;
}

// Free: a GitHub Release, so the version shows on the repo page and watchers get notified.
async function createRelease(rel, shareLink, { GITHUB_TOKEN, GITHUB_SHA }) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      tag_name: rel.ver,
      target_commitish: GITHUB_SHA,
      name: `${rel.ver}: ${rel.desc}`,
      body: `${rel.body ? rel.body + '\n\n' : ''}[Share on X](${shareLink})`,
    }),
  });
  if (res.status === 422) return `${rel.ver} already has a release; left it alone`;
  if (!res.ok) throw new Error(`GitHub release returned ${res.status}: ${await res.text()}`);
  return (await res.json()).html_url;
}

async function main() {
  const env = process.env;
  const rel = env.TEXT ? null : releaseOf(JSON.parse(env.COMMITS || 'null') || []);
  const text = env.TEXT ? fit(env.TEXT.trim()) : rel && rel.text;
  if (!text) return console.log('No "vX.Y.Z: ..." commit in this push; nothing to announce.');

  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const hasBluesky = env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD;
  const hasX = env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET;
  const lines = [`**Post on X (one click):** ${xIntent(text)}`];
  let failed = false;
  const step = async (label, fn) => {
    if (dry) return lines.push(`**${label}:** dry run, skipped`);
    try { lines.push(`**${label}:** ${await fn()}`); } catch (e) { failed = true; lines.push(`**${label}:** failed. ${e.message}`); }
  };

  if (rel && env.GITHUB_TOKEN) await step('GitHub release', () => createRelease(rel, xIntent(text), env));
  if (hasBluesky) await step('Bluesky', () => postBluesky(text, env));
  if (hasX) await step('X API', () => postX(text, env));

  const summary = `### Announcement\n\n${'```'}\n${text}\n${'```'}\n\n${lines.map(l => `- ${l}`).join('\n')}\n`;
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) require('fs').appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (failed) process.exitCode = 1; // not process.exit(): it can abort Node mid-cleanup after a fetch
}

function selfTest() {
  const assert = require('assert');
  // Worked example from X's "Creating a signature" docs (classic api.twitter.com URL).
  const sig = sign('POST', 'https://api.twitter.com/1.1/statuses/update.json', {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  }, 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE');
  assert.strictEqual(sig, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  assert.strictEqual(enc("a!'()*"), 'a%21%27%28%29%2A');
  assert.strictEqual(releaseOf([{ message: 'README tweak' }, { message: 'Merge pull request #2' }]), null);
  assert.deepStrictEqual(releaseOf([{ message: 'v0.9.0: Pi is production-ready\n\nTested live.' }]), {
    ver: 'v0.9.0', desc: 'Pi is production-ready', body: 'Tested live.',
    text: `mem-mastero v0.9.0 is out: Pi is production-ready\n\n${REPO_URL}`,
  });
  const long = releaseOf([{ message: 'v1.0.0: ' + 'x'.repeat(400) }]).text;
  assert.ok(xLength(long.split('\n\n')[0]) + 2 + URL_LEN <= MAX);
  assert.ok(xLength(long.split('\n\n')[0]) + 2 + URL_LEN >= MAX - 1);
  const rockets = fit('🚀'.repeat(300));
  assert.ok(xLength(rockets) <= MAX && rockets.endsWith('🚀…'));
  assert.strictEqual(fit('short and sweet'), 'short and sweet');
  // Bluesky link facet: byte offsets, so a multi-byte "é" before the link shifts it by 2.
  const [facet] = linkFacets('café https://x.io end');
  assert.deepStrictEqual(facet.index, { byteStart: 6, byteEnd: 18 });
  assert.strictEqual(facet.features[0].uri, 'https://x.io');
  assert.strictEqual(xIntent('a b&c'), 'https://x.com/intent/post?text=a%20b%26c');
  console.log('announce self-test ok');
}

if (process.argv[2] === '--test') selfTest();
else main().catch(e => { console.error(e); process.exitCode = 1; });
