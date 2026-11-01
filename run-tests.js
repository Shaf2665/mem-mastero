// Isolate all homes and Git config so tests never use an installed agent or a real memory store.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tests-')));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(GIT_|MEM_MASTERO_|PI_CODING_AGENT_|CODEX_HOME$|COPILOT_HOME$|CLAUDE_CONFIG_DIR$)/i.test(key)) delete env[key];
}
const systemConfig = path.join(root, 'gitconfig-system');
fs.writeFileSync(systemConfig, '[core]\n  longpaths = true\n');
Object.assign(env, {
  HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
  GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig-global'), GIT_CONFIG_SYSTEM: systemConfig,
});
try {
  for (const args of [
    ['test.js'], ['test-integrity.js'], ['test-privacy.js'], ['test-recovery.js'], ['test-update.js'],
    ['test-claude-files.js'], ['test-archive-store.js'], ['test-archive.js'], ['test-archive-adversarial.js'], ['test-archive-sync.js'], ['.github/announce.js', '--test'],
  ]) {
    console.log(`Testing ${args[0]}`);
    const result = spawnSync(process.execPath, args, { cwd: __dirname, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 180000 });
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) { process.exitCode = 1; break; }
  }
} finally {
  const resolved = fs.realpathSync.native(root);
  if (resolved !== root || !path.basename(resolved).startsWith('mm-tests-')) throw new Error('Unexpected test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
