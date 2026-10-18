// Pi extension: runs ../sync.js on Pi's lifecycle events, the same way Claude/Codex hooks do.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SYNC = fileURLToPath(new URL('../sync.js', import.meta.url));

function sync(mode, ctx, { wait = false } = {}) {
  const sm = ctx?.sessionManager;
  const input = JSON.stringify({ cwd: ctx?.cwd, transcript_path: sm?.getSessionFile?.(), session_dir: sm?.getSessionDir?.() });
  const child = spawn(process.execPath, [SYNC, 'pi', mode], wait
    ? { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    : { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
  child.stdin.end(input);
  if (!wait) return child.unref();
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return new Promise(resolve => child.on('close', () => resolve(out.trim())).on('error', () => resolve('')));
}

export default function memMastero(pi) {
  pi.on('session_start', async (_event, ctx) => {
    const out = await sync('start', ctx, { wait: true });
    if (out) ctx?.ui?.notify?.(out, 'info');
  });
  pi.on('agent_end', async (_event, ctx) => { sync('push', ctx); });
  pi.on('session_shutdown', async (_event, ctx) => { sync('push', ctx); });
}
