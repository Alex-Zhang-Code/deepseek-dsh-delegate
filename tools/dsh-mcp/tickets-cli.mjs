import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { TicketStore } from './ticket-store.mjs';
import { buildTask } from './task-builder.mjs';
import { submitTicket, ensureRuntime } from './ticket-service.mjs';
import { traceDirectory, sanitize } from './trace-store.mjs';
import { redact } from './task-runner.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    directory: { type: 'string' }, file: { type: 'string' }, id: { type: 'string' },
    assignment: { type: 'string' }, reason: { type: 'string' }, reviewed: { type: 'boolean' },
  } });
  const directory = values.directory || traceDirectory();
  const command = positionals[0];
  let reply;
  if (command === 'start') reply = await ensureRuntime(directory);
  else if (command === 'build' || command === 'submit') {
    const input = JSON.parse(fs.readFileSync(values.file, 'utf8').replace(/^\uFEFF/, ''));
    reply = command === 'build' ? buildTask(input) : await submitTicket(input.schema_version ? input : buildTask(input), directory);
  } else {
    const store = new TicketStore(directory);
    try {
      if (command === 'list') reply = { tickets: store.list(), executor: store.health() };
      else if (command === 'get') reply = store.get(values.id);
      else if (command === 'cancel') reply = store.cancel(values.id);
      else if (command === 'retry' || command === 'resolve') reply = store.retry(values.id, values.assignment || null, values.reviewed, values.reason, command === 'resolve');
      else throw new Error('Commands: build/submit --file, start, list, get/cancel --id, retry/resolve --id --assignment --reviewed --reason.');
    } finally { store.close(); }
    if (command === 'retry') reply.executor = await ensureRuntime(directory);
  }
  process.stdout.write(`${JSON.stringify(redact(reply))}\n`);
} catch (error) { process.stderr.write(`${sanitize(error.message)}\n`); process.exitCode = 2; }
