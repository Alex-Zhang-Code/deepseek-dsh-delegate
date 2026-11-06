import { parseArgs } from 'node:util';
import { TicketStore } from './ticket-store.mjs';
import { executeTask, failureResult } from './task-runner.mjs';
import { createTrace, sanitize } from './trace-store.mjs';

const { values } = parseArgs({ options: { directory: { type: 'string' }, assignment: { type: 'string' } } });
const store = new TicketStore(values.directory);
const id = values.assignment;
const controller = new AbortController();
let pulse;
let owned = false;
try {
  const ticket = store.attach(id, process.pid);
  owned = true;
  const task = { ...ticket.task, metadata: { ...ticket.task.metadata, ticket_id: ticket.id, assignment_id: id } };
  const trace = createTrace(task, { ...process.env, DSH_TRACE_DIR: store.directory });
  if (trace) store.setRun(id, trace.run.run_id);
  const check = () => { if (store.pulse(id).cancel_requested) controller.abort(); };
  check();
  pulse = setInterval(check, 150);
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const { result } = await executeTask(task, { signal: controller.signal, trace,
    env: { DSH_TRACE_DIR: store.directory } });
  store.finish(id, result);
} catch (error) {
  process.stderr.write(`${sanitize(error.message)}\n`);
  if (owned) try {
    store.finish(id, failureResult({}, 'protocol', 'PROCESS_CLEANUP_FAILED', `Supervisor failed; inspect possible side effects: ${error.message}`).result);
  } catch { /* Recovery retains uncertain work. */ }
  process.exitCode = 1;
} finally { clearInterval(pulse); store.close(); }
