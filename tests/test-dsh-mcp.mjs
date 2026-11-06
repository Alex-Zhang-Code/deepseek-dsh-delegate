import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { executeTask, validateResult, root } from '../tools/dsh-mcp/task-runner.mjs';

const fixture = path.join(root, 'tests/fixtures/fake-dsh.mjs');
const cli = path.join(root, 'tools/dsh-mcp/cli.mjs');
const server = path.join(root, 'tools/dsh-mcp/server.mjs');
const template = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/task.json'), 'utf8'));
const offlineEnv = { DEEPSEEK_RELAY_API_KEY: 'offline-test-key', DEEPSEEK_DSH_PATH: fixture, DSH_FAKE_LOG: '', DSH_TRACE_ENABLED: '0', DSH_DASHBOARD_AUTO_START: '0' };
const makeTask = (scenario = 'success', overrides = {}) => ({ ...structuredClone(template),
  working_directory: root, metadata: { fixture_scenario: scenario }, ...overrides });
function valid(result) { assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors)); }
async function run(scenario, task = {}, options = {}) {
  const outcome = await executeTask(makeTask(scenario, task), { dshPath: fixture, env: offlineEnv, ...options });
  valid(outcome.result);
  return outcome;
}
const records = log => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(25);
  }
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh adapter test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function connect(t, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root,
    env: { ...process.env, ...offlineEnv, ...extraEnv }, stderr: 'pipe' });
  const client = new Client({ name: 'dsh-test', version: '1.0.0' });
  transport.stderr.on('data', () => {});
  await client.connect(transport);
  t.after(() => client.close());
  const call = (task, options) => client.callTool({ name: 'delegate_to_deepseek', arguments: task }, undefined, { timeout: 10000, ...options });
  return { client, transport, call };
}

test('success normalizes lifecycle and deduplicates per-step token usage', async () => {
  const { result, exitCode } = await run('success');
  assert.equal(exitCode, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.final_text, 'fixture ok');
  assert.deepEqual(result.status_history.map(item => item.status), ['submitted', 'working', 'completed']);
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 7, total_tokens: 16 });
  assert.equal(result.verification.semantic, 'required_by_caller');
  assert.equal(result.events, undefined);
});

for (const [scenario, code, status, exitCode] of [
  ['failure', 'PI_AI_ERROR', 'failed', 1], ['error-event', 'FIXTURE_ERROR', 'failed', 1],
  ['nonzero', 'DSH_NONZERO_EXIT', 'failed', 1], ['malformed', 'INCOMPLETE_EVENT_STREAM', 'failed', 1],
  ['incomplete', 'INCOMPLETE_EVENT_STREAM', 'failed', 1], ['duplicate-final', 'INCOMPLETE_EVENT_STREAM', 'failed', 1],
  ['empty', 'EMPTY_FINAL', 'failed', 1], ['canceled', 'CANCELED', 'canceled', 130],
]) {
  test(`rejects ${scenario}`, async () => {
    const outcome = await run(scenario);
    assert.equal(outcome.result.error.code, code);
    assert.equal(outcome.result.status, status);
    assert.equal(outcome.exitCode, exitCode);
  });
}

test('verifies JSON output and matching sessions/workspaces', async () => {
  const expected_output = { format: 'json', requirements: [] };
  assert.equal((await run('json', { expected_output })).exitCode, 0);
  assert.equal((await run('success', { expected_output })).result.error.code, 'INVALID_FINAL_JSON');
  assert.equal((await run('wrong-session', { session_id: 'requested-session' })).result.error.code, 'SESSION_MISMATCH');
  assert.equal((await run('wrong-cwd')).result.error.code, 'SESSION_MISMATCH');
  assert.equal((await run('success', { session_id: 'requested-session' })).result.session_id, 'requested-session');
});

test('UTF-8, quotes and shell metacharacters survive stdin and paths with spaces', async t => {
  const dir = temporary(t);
  const spacedFixture = path.join(dir, 'fake dsh.mjs');
  fs.copyFileSync(fixture, spacedFixture);
  const context = '\u4e2d\u6587 "double" \'single\' & | % ! $() ` newline\nsecond line';
  const { result } = await run('echo', { context, working_directory: dir }, { dshPath: spacedFixture, dshHome: path.join(dir, 'dsh home') });
  assert.equal(result.status, 'completed');
  const echo = JSON.parse(result.final_text);
  assert.equal(echo.context, context);
  assert.equal(echo.dsh_home, path.join(dir, 'dsh home'));
  assert.match(echo.prompt, /Do not create, modify/);
  assert.equal((await run('unicode')).result.final_text, '\u8fde\u63a5\u6b63\u5e38\u3002');
});

test('redacts credentials from final text, stderr, events and object keys', async () => {
  const { result } = await run('secret', {}, { includeEvents: true });
  assert.equal(JSON.stringify(result).includes('offline-test-key'), false);
  assert.equal(result.final_text, '[REDACTED]');
  assert.match(result.protocol.stderr, /REDACTED/);
});

test('rejects invalid tasks, missing credentials and launcher before starting DSH', async () => {
  for (const task of [
    { objective: ' ' }, { working_directory: '.' }, { unexpected: true },
    { allowed_paths: [path.dirname(root)] }, { mode: 'workspace_write', allowed_paths: [] },
  ]) assert.equal((await run('success', task)).result.error.code, 'INVALID_TASK');
  assert.equal((await run('success', {}, { env: { ...offlineEnv, DEEPSEEK_RELAY_API_KEY: '' } })).result.error.code, 'MISSING_CREDENTIAL');
  assert.equal((await run('success', {}, { dshPath: path.join(root, 'not-existing-dsh.exe') })).result.error.code, 'DSH_LAUNCHER_ERROR');
  assert.equal((await run('success', {}, { timeoutSeconds: 0 })).result.error.code, 'INVALID_TIMEOUT');
});

test('rejects a junction/symlink that escapes the task workspace', async t => {
  const dir = temporary(t);
  const workspace = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const outcome = await run('success', { working_directory: workspace, allowed_paths: [path.join(workspace, 'escape/new.txt')] });
  assert.equal(outcome.result.error.code, 'INVALID_TASK');
});

test('CLI accepts BOM UTF-8 tasks and emits one normalized JSON result', t => {
  const dir = temporary(t);
  const file = path.join(dir, 'task with spaces.json');
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(makeTask('unicode'))}`);
  const outcome = spawnSync(process.execPath, [cli, '--task-file', file], { env: { ...process.env, ...offlineEnv }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(outcome.stdout).final_text, '\u8fde\u63a5\u6b63\u5e38\u3002');
  fs.writeFileSync(file, '{ broken JSON');
  const bad = spawnSync(process.execPath, [cli, '--task-file', file], { env: { ...process.env, ...offlineEnv }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, 'INVALID_TASK_INPUT');
});

test('output limit terminates the run', async () => {
  const { result } = await run('limit');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'OUTPUT_LIMIT');
});

test('timeout kills DSH and its descendant process', async t => {
  const log = path.join(temporary(t), 'events.jsonl');
  const outcome = await run('hang', {}, { timeoutSeconds: 1, env: { ...offlineEnv, DSH_FAKE_LOG: log } });
  assert.equal(outcome.exitCode, 124);
  assert.equal(outcome.result.error.code, 'TIMEOUT');
  const child = records(log).find(item => item.event === 'child');
  assert.ok(child);
  await until(() => !alive(child.pid) && !alive(child.child_pid), 'process-tree cleanup');
});

test('AbortSignal cancels active and not-yet-started tasks', async t => {
  const log = path.join(temporary(t), 'events.jsonl');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = run('hang', {}, { signal: controller.signal, env: { ...offlineEnv, DSH_FAKE_LOG: log } });
  await until(() => records(log).some(item => item.event === 'child'), 'fixture child');
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.result.status, 'canceled');
  const child = records(log).find(item => item.event === 'child');
  await until(() => !alive(child.pid) && !alive(child.child_pid), 'canceled process cleanup');
  const early = await run('success', {}, { signal: controller.signal });
  assert.deepEqual(early.result.status_history.map(item => item.status), ['submitted', 'canceled']);
});

test('throwing status observer does not leave a DSH process running', async () => {
  const outcome = await run('hang', {}, { onStatus: () => { throw new Error('observer failure'); } });
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.result.status, 'failed');
});

test('Windows PowerShell wrapper forwards flags, unicode and failure codes', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests/test-invoke-dsh.ps1')],
    { cwd: root, env: { ...process.env, ...offlineEnv }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /4 scenarios passed/);
});

test('MCP SDK initializes, lists the tool and validates success/error structured results', async t => {
  const { client, call } = await connect(t);
  assert.equal(client.getServerVersion().name, 'deepseek-dsh');
  const { tools } = await client.listTools();
  assert.equal(tools[0].name, 'delegate_to_deepseek');
  assert.deepEqual(tools[0].inputSchema, (await import('../tools/dsh-mcp/task-runner.mjs')).taskSchema);
  const ok = await call(makeTask());
  assert.equal(ok.isError, false); valid(ok.structuredContent);
  assert.deepEqual(JSON.parse(ok.content[0].text), ok.structuredContent);
  const failed = await call(makeTask('failure'));
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, 'PI_AI_ERROR');
  const invalid = await call(makeTask('success', { mode: 'workspace_write', allowed_paths: [] }));
  assert.equal(invalid.structuredContent.error.code, 'INVALID_TASK');
  await assert.rejects(client.callTool({ name: 'wrong-tool', arguments: {} }), /Unknown tool/);
});

test('MCP calls are serialized within one server', async t => {
  const log = path.join(temporary(t), 'events.jsonl');
  const { call } = await connect(t, { DSH_FAKE_LOG: log });
  const results = await Promise.all(['first', 'second'].map(task_id => call(makeTask('slow', { task_id }))));
  results.forEach(item => assert.equal(item.isError, false));
  const lifecycle = records(log).map(item => `${item.event}:${item.task_id}`);
  assert.deepEqual(lifecycle, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('MCP cancellation cleans up and skips queued canceled tasks', async t => {
  const log = path.join(temporary(t), 'events.jsonl');
  const { call } = await connect(t, { DSH_FAKE_LOG: log });
  const running = new AbortController();
  const queued = new AbortController();
  t.after(() => { running.abort(); queued.abort(); });
  const first = call(makeTask('hang', { task_id: 'running' }), { signal: running.signal });
  const firstRejection = assert.rejects(first);
  await until(() => records(log).some(item => item.event === 'child'), 'running MCP task');
  const second = call(makeTask('success', { task_id: 'queued' }), { signal: queued.signal });
  const secondRejection = assert.rejects(second);
  queued.abort(); await secondRejection;
  running.abort(); await firstRejection;
  const next = await call(makeTask('success', { task_id: 'next' }));
  assert.equal(next.isError, false);
  assert.equal(records(log).some(item => item.task_id === 'queued'), false);
  const child = records(log).find(item => item.event === 'child');
  await until(() => !alive(child.pid) && !alive(child.child_pid), 'MCP canceled process cleanup');
});

test('MCP stdin disconnect terminates active DSH and its descendants', async t => {
  const log = path.join(temporary(t), 'events.jsonl');
  const { client, transport, call } = await connect(t, { DSH_FAKE_LOG: log });
  const serverPid = transport.pid;
  const pending = call(makeTask('hang'));
  const rejection = assert.rejects(pending);
  await until(() => records(log).some(item => item.event === 'child'), 'DSH child before disconnect');
  await client.close(); await rejection;
  const child = records(log).find(item => item.event === 'child');
  await until(() => !alive(serverPid) && !alive(child.pid) && !alive(child.child_pid), 'server disconnect cleanup');
});
