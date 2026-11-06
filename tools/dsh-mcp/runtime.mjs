import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { TicketStore } from './ticket-store.mjs';
import { sanitize } from './trace-store.mjs';

export function startRuntime(directory, env = process.env) {
  const workers = Number(env.DSH_MAX_WORKERS || 1);
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('DSH_MAX_WORKERS must be 1..4.');
  const store = new TicketStore(directory);
  if (!store.acquireRuntime(workers)) { store.close(); return null; }
  let closed = false;
  const tick = () => {
    try {
      store.heartbeat(workers);
      store.recover();
      for (let slot = 0; slot < workers; slot++) {
        const assignment = store.claim(workers);
        if (!assignment) break;
        const log = fs.openSync(path.join(store.directory, 'executor.log'), 'a');
        try {
          const child = spawn(process.execPath, [fileURLToPath(new URL('./assignment-worker.mjs', import.meta.url)),
            '--directory', store.directory, '--assignment', assignment.assignment_id], {
            env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
          });
          child.on('error', error => process.stderr.write(`${sanitize(error.message)}\n`));
          child.unref();
        } finally { fs.closeSync(log); }
      }
    } catch (error) { process.stderr.write(`${sanitize(error.message)}\n`); }
  };
  tick();
  const timer = setInterval(tick, 250);
  return { store, close() {
    if (closed) return;
    closed = true; clearInterval(timer); store.close();
    // Assignment supervisors are independent and keep running after scheduler shutdown.
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  const runtime = startRuntime(values.directory);
  if (runtime) {
    process.once('SIGINT', () => runtime.close());
    process.once('SIGTERM', () => runtime.close());
  }
}
