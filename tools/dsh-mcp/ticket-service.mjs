import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { TicketStore, processAlive } from './ticket-store.mjs';
import { traceDirectory, recordVerification } from './trace-store.mjs';

export async function ensureRuntime(directory = traceDirectory(), env = process.env) {
  const store = new TicketStore(directory);
  try {
    const health = store.health();
    if (health.alive) return health;
    if (processAlive(health.pid)) throw new Error('Executor heartbeat is stale but its process exists. Inspect executor.log before restarting.');
    const log = fs.openSync(path.join(directory, 'executor.log'), 'a');
    let child, launchError;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./runtime.mjs', import.meta.url)), '--directory', directory], {
        env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      });
      child.on('error', error => { launchError = error; }); child.unref();
    } finally { fs.closeSync(log); }
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = store.health();
      if (current.alive) return current;
      if (launchError) throw launchError;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Executor did not start; queued task is durable. Inspect executor.log.');
  } finally { store.close(); }
}

export async function submitTicket(task, directory = traceDirectory(), env = process.env) {
  const store = new TicketStore(directory);
  let ticket;
  try { ticket = store.submit(task); } finally { store.close(); }
  try { return { ...ticket, executor: await ensureRuntime(directory, env) }; }
  catch (error) { return { ...ticket, executor: { alive: false, error: error.message } }; }
}

export function verifyRun(directory, runId, verification) {
  const store = new TicketStore(directory);
  try {
    const assignment = store.findRun(runId);
    if (assignment) return store.verify(assignment.ticket_id, assignment.id, verification);
    return recordVerification(directory, runId, verification);
  } finally { store.close(); }
}
