import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { executeTask, failureResult } from './task-runner.mjs';

let outcome;
try {
  const { values } = parseArgs({ options: {
    'task-file': { type: 'string' }, 'dsh-path': { type: 'string' }, 'dsh-home': { type: 'string' },
    'timeout-seconds': { type: 'string' }, 'include-events': { type: 'boolean', default: false },
  } });
  if (!values['task-file']) throw new Error('--task-file is required.');
  const json = fs.readFileSync(values['task-file'], 'utf8').replace(/^\uFEFF/, '');
  const task = JSON.parse(json);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  outcome = await executeTask(task, {
    dshPath: values['dsh-path'], dshHome: values['dsh-home'],
    timeoutSeconds: values['timeout-seconds'] === undefined ? undefined : Number(values['timeout-seconds']),
    includeEvents: values['include-events'], signal: controller.signal,
  });
} catch (error) {
  outcome = failureResult(null, 'validation', 'INVALID_TASK_INPUT', error.message);
}
process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
process.exitCode = outcome.exitCode;
