#!/usr/bin/env node
// Posts a release announcement to X when a "vX.Y.Z: ..." commit lands on main (run by .github/workflows/post-to-x.yml).
// Env: COMMITS (JSON from github.event.commits) or TEXT (manual post), DRY_RUN=1 to print instead of posting,
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

// The newest "vX.Y.Z: description" commit subject in this push, or null.
function releaseText(commits) {
  const hit = commits.map(c => c.message.split('\n')[0]).filter(s => /^v\d+\.\d+\.\d+: \S/.test(s)).pop();
  if (!hit) return null;
  const [, ver, desc] = hit.match(/^(v\d+\.\d+\.\d+): (.*)$/);
  return fit(`${NAME} ${ver} is out: ${desc}`, REPO_URL);
}

async function main() {
  const env = process.env;
  const text = env.TEXT ? fit(env.TEXT.trim()) : releaseText(JSON.parse(env.COMMITS || 'null') || []);
  if (!text) return console.log('No "vX.Y.Z: ..." commit in this push; nothing to post.');
  if (env.DRY_RUN === '1' || env.DRY_RUN === 'true') return console.log('Dry run, would post:\n' + text);

  const missing = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'].filter(k => !env[k]);
  if (missing.length) {
    console.error(`Missing secrets: ${missing.join(', ')}. Add them under Settings > Secrets and variables > Actions.`);
    process.exit(1);
  }
  const url = 'https://api.x.com/2/tweets';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', url, env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (res.status !== 201) {
    console.error(`X returned ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`Posted: https://x.com/i/web/status/${JSON.parse(body).data.id}\n${text}`);
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
  assert.strictEqual(releaseText([{ message: 'README tweak' }, { message: 'Merge pull request #2' }]), null);
  assert.strictEqual(releaseText([{ message: 'v0.9.0: Pi is production-ready\n\nbody' }]),
    `mem-mastero v0.9.0 is out: Pi is production-ready\n\n${REPO_URL}`);
  const long = releaseText([{ message: 'v1.0.0: ' + 'x'.repeat(400) }]);
  assert.ok(xLength(long.split('\n\n')[0]) + 2 + URL_LEN <= MAX);
  assert.ok(xLength(long.split('\n\n')[0]) + 2 + URL_LEN >= MAX - 1);
  const rockets = fit('🚀'.repeat(300));
  assert.ok(xLength(rockets) <= MAX && rockets.endsWith('🚀…'));
  assert.strictEqual(fit('short and sweet'), 'short and sweet');
  console.log('post-to-x self-test ok');
}

if (process.argv[2] === '--test') selfTest();
else main().catch(e => { console.error(e); process.exit(1); });
