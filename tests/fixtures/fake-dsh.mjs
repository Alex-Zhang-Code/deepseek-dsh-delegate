import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (!args.includes('--json') || args.at(-1) !== '-') throw new Error('Unexpected DSH arguments.');
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const prompt = Buffer.concat(input).toString('utf8');
const task = JSON.parse(prompt.slice(prompt.indexOf('\n{') + 1));
const scenario = task.metadata?.fixture_scenario || process.env.DSH_FAKE_SCENARIO || 'success';
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (event, detail = {}) => {
  if (process.env.DSH_FAKE_LOG) fs.appendFileSync(process.env.DSH_FAKE_LOG,
    `${JSON.stringify({ event, task_id: task.task_id, pid: process.pid, at: Date.now(), ...detail })}\n`);
};
log('start');
process.on('exit', () => log('end'));
const sessionArg = args.indexOf('--session-id');
emit({ type: 'session', sessionId: scenario === 'wrong-session' ? 'wrong-session'
  : sessionArg < 0 ? 'fixture-session' : args[sessionArg + 1],
  cwd: scenario === 'wrong-cwd' ? process.env.TEMP : process.cwd() });
emit({ type: 'status', phase: 'turn_start', turn: 1 });

if (scenario === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  log('child', { child_pid: child.pid });
  setInterval(() => {}, 1000);
} else {
  if (scenario === 'slow') await delay(250);
  if (scenario === 'malformed') process.stdout.write('this is not JSON\n');
  if (scenario === 'limit') process.stdout.write('x'.repeat(17 * 1024 * 1024));
  const usage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage });
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage });
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 } });
  let text = 'fixture ok';
  if (scenario === 'empty') text = '';
  if (scenario === 'unicode') text = '\u8fde\u63a5\u6b63\u5e38\u3002';
  if (scenario === 'echo') text = JSON.stringify({ objective: task.objective, context: task.context,
    dsh_home: process.env.DSH_HOME, prompt });
  if (scenario === 'json') text = JSON.stringify({ ok: true });
  if (scenario === 'secret') {
    text = process.env.DEEPSEEK_RELAY_API_KEY;
    emit({ type: 'debug', nested: { [text]: text } });
    process.stderr.write(`credential=${text}\n`);
  }
  if (scenario === 'failure') {
    emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'fixture API failure' } } });
    emit({ type: 'final', text: '' });
    process.exitCode = 1;
  } else {
    if (scenario === 'error-event') emit({ type: 'error', code: 'FIXTURE_ERROR', message: 'fixture error event' });
    if (scenario !== 'incomplete') emit({ type: 'status', phase: 'turn_end', turn: 1,
      reason: { kind: scenario === 'canceled' ? 'canceled' : 'completed' } });
    emit({ type: 'final', text });
    if (scenario === 'duplicate-final') emit({ type: 'final', text });
    if (scenario === 'nonzero') process.exitCode = 7;
  }
}
