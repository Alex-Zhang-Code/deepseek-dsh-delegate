import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { traceDirectory } from './trace-store.mjs';

async function probe(port) {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return reply.ok ? await reply.json() : null;
  } catch { return null; }
}

export async function ensureDashboard(env = process.env) {
  const directory = traceDirectory(env);
  const preferred = Number(env.DSH_DASHBOARD_PORT || 8766);
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65515) throw new Error('Invalid dashboard port.');
  fs.mkdirSync(directory, { recursive: true });
  for (let port = preferred; port < preferred + 20; port++) {
    const existing = await probe(port);
    if (existing?.service === 'dsh-observatory' && path.resolve(existing.directory).toLowerCase() === directory.toLowerCase()) {
      return `http://127.0.0.1:${port}`;
    }
    if (existing) continue;
    const output = fs.openSync(path.join(directory, 'dashboard.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./dashboard.mjs', import.meta.url)), '--port', String(port), '--directory', directory], {
        env, windowsHide: true, detached: true, stdio: ['ignore', output, output],
      });
    } finally { fs.closeSync(output); }
    let failed = false;
    child.on('error', () => { failed = true; });
    child.unref();
    for (let attempt = 0; attempt < 12 && !failed; attempt++) {
      const health = await probe(port);
      if (health?.service === 'dsh-observatory' && path.resolve(health.directory).toLowerCase() === directory.toLowerCase()) {
        const url = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(directory, 'dashboard.json'), JSON.stringify({ url, pid: child.pid, directory }));
        return url;
      }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('No dashboard port available. See local/observability/dashboard.log.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await ensureDashboard()}\n`);
}
