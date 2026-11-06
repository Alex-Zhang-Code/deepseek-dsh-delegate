import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { buildTask } from '../tools/dsh-mcp/task-builder.mjs';
import { TicketStore, conflicting, processAlive } from '../tools/dsh-mcp/ticket-store.mjs';
import { root } from '../tools/dsh-mcp/task-runner.mjs';
import { createDashboard } from '../tools/dsh-mcp/dashboard.mjs';
import { Client } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const input = overrides => ({ task_id: 'test-task', objective: 'Return fixture ok.', working_directory: root,
  acceptance_criteria: ['Fixture output is correct.'], ...overrides });
const task = overrides => buildTask(input(overrides));
const env = directory => ({ ...process.env, DSH_TRACE_DIR: directory, DSH_TRACE_ENABLED: '1',
  DSH_DASHBOARD_AUTO_START: '0', DEEPSEEK_RELAY_API_KEY: 'offline-key',
  DEEPSEEK_DSH_PATH: path.join(root, 'tests/fixtures/fake-dsh.mjs'),
  LANGFUSE_BASE_URL: '', LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' });
async function until(fn, description) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await fn(); if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(40);
  }
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh tickets '));
  const store = new TicketStore(directory);
  const cleanup = [];
  // Close SQLite before deleting temporary files on Windows.
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
    const pids = store.db.prepare('SELECT pid FROM assignments WHERE pid IS NOT NULL').all().map(row => row.pid);
    await until(() => pids.every(pid => pid === process.pid || !processAlive(pid)), 'supervisor final SQLite close');
    store.close(); await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { directory, store, cleanup };
}
function launch(directory, name = 'runtime.mjs', args = []) {
  const child = spawn(process.execPath, [path.join(root, 'tools/dsh-mcp', name), '--directory', directory, ...args], {
    env: env(directory), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.errors = () => stderr;
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(); await until(() => !processAlive(child.pid), 'process stop');
}
function finish(store, assignment, status = 'completed') {
  store.finish(assignment.assignment_id, { status, final_text: 'fixture ok', error: null });
}
const acceptance = { verdict: 'passed', reviewer: 'tester', evidence: ['Inspected fixture result.'] };

test('builder supplies explicit safe defaults and rejects malformed fields without launching', () => {
  const built = task();
  assert.equal(built.mode, 'read_only');
  assert.deepEqual(built.expected_output, { format: 'markdown', requirements: [] });
  for (const changes of [{ working_directory: undefined }, { mode: 'read' }, { expected_output: 'text' },
    { mode: 'workspace_write' }, { allowed_paths: [path.dirname(root)] }, { acceptance_criteria: [' '] }]) {
    assert.throws(() => task(changes), /INVALID_TASK/);
  }
});

test('tickets survive reopen, deduplicate key ordering and reject conflicting bodies', t => {
  const { store, directory } = setup(t);
  const first = store.submit(task());
  const other = new TicketStore(directory);
  try {
    assert.equal(other.get(first.id).status, 'submitted');
    assert.equal(other.submit(Object.fromEntries(Object.entries(task()).reverse())).id, first.id);
    assert.equal(other.submit(task()).deduplicated, true);
    assert.throws(() => other.submit(task({ objective: 'Different' })), /TASK_CONFLICT/);
    assert.equal(other.list().length, 1);
  } finally { other.close(); }
});

test('workspace admission canonicalizes junctions and blocks nested or uncertain workspaces', t => {
  const { directory, store } = setup(t);
  const a = path.join(directory, 'a'), b = path.join(directory, 'b'), alias = path.join(directory, 'alias');
  fs.mkdirSync(a); fs.mkdirSync(path.join(a, 'nested')); fs.mkdirSync(b);
  fs.symlinkSync(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(conflicting(task({ working_directory: a }), task({ working_directory: alias })), true);
  assert.equal(conflicting(task({ working_directory: a }), task({ working_directory: path.join(a, 'nested') })), true);
  store.submit(task({ task_id: 'a', working_directory: a }));
  store.submit(task({ task_id: 'alias', working_directory: alias }));
  store.submit(task({ task_id: 'b', working_directory: b }));
  const first = store.claim(2), second = store.claim(2);
  assert.ok(first && second);
  assert.deepEqual(new Set([store.get(first.ticket_id).task.task_id, store.get(second.ticket_id).task.task_id]), new Set(['a', 'b']));
  assert.equal(store.claim(2), null);
  finish(store, first); finish(store, second);
  assert.equal(store.get(store.claim(2).ticket_id).task.task_id, 'alias');
});

test('recovery retains live supervisors and never replays interrupted work', t => {
  const { store } = setup(t);
  const ticket = store.submit(task());
  const assignment = store.claim(); store.attach(assignment.assignment_id, process.pid);
  store.recover({ launchGraceMs: 0 }); assert.equal(store.get(ticket.id).status, 'working');
  store.db.prepare('UPDATE assignments SET pid=? WHERE id=?').run(2147483647, assignment.assignment_id);
  store.recover({ launchGraceMs: 0 });
  assert.equal(store.get(ticket.id).status, 'interrupted');
  assert.equal(store.claim(), null);
  assert.throws(() => store.retry(ticket.id, assignment.assignment_id, false, 'review'), /reviewed/);
  store.retry(ticket.id, assignment.assignment_id, true, 'Checked processes and side effects; safe to rerun.');
  const next = store.claim(); assert.notEqual(next.assignment_id, assignment.assignment_id);
  assert.equal(store.get(ticket.id).assignments.length, 2);
});

test('cancellation before launch cannot run; stale acceptance cannot close a new attempt', t => {
  const { store } = setup(t);
  const ticket = store.submit(task());
  store.cancel(ticket.id); assert.equal(store.claim(), null);
  store.retry(ticket.id, null, true, 'Task never launched.');
  const first = store.claim(); finish(store, first, 'failed');
  assert.throws(() => store.verify(ticket.id, first.assignment_id, acceptance), /Only completed/);
  store.retry(ticket.id, first.assignment_id, true, 'Inspected failure.');
  const second = store.claim(); finish(store, second);
  assert.throws(() => store.verify(ticket.id, first.assignment_id, acceptance), /latest/);
  assert.throws(() => store.verify(ticket.id, second.assignment_id, { ...acceptance, evidence: [] }), /evidence/);
  assert.equal(store.verify(ticket.id, second.assignment_id, acceptance).verdict, 'passed');
  assert.throws(() => store.retry(ticket.id, second.assignment_id, true, 'again'), /Accepted/);
});

test('interrupted workspace blocks overlapping tasks until explicit reviewed resolution', t => {
  const { store } = setup(t);
  const ticket = store.submit(task()); const assignment = store.claim();
  store.recover({ launchGraceMs: 0 });
  store.submit(task({ task_id: 'next' })); assert.equal(store.claim(4), null);
  store.retry(ticket.id, assignment.assignment_id, true, 'Confirmed all old processes stopped and effects inspected.', true);
  assert.equal(store.get(store.claim(4).ticket_id).task.task_id, 'next');
});

test('assignment supervisor finishes independently after scheduler exits and new scheduler resumes queue', async t => {
  const { store, directory, cleanup } = setup(t);
  const first = store.submit(task({ metadata: { fixture_scenario: 'slow' } }));
  const runtime = launch(directory); let secondRuntime;
  cleanup.push(async () => { await stop(runtime); if (secondRuntime) await stop(secondRuntime); });
  await until(() => store.get(first.id).assignments.at(-1)?.pid, 'supervisor attach');
  await stop(runtime);
  await until(() => store.get(first.id).status === 'completed', 'independent assignment completion');
  const second = store.submit(task({ task_id: 'after-restart' }));
  secondRuntime = launch(directory);
  await until(() => store.get(second.id).status === 'completed', `queue after restart ${secondRuntime.errors()}`);
  assert.equal(store.get(first.id).assignments.length, 1);
  await stop(secondRuntime);
});

test('live cancellation propagates to process tree and cancel/completion race preserves history', async t => {
  const { store, directory, cleanup } = setup(t);
  const ticket = store.submit(task({ metadata: { fixture_scenario: 'hang' } }));
  const claimed = store.claim();
  const worker = launch(directory, 'assignment-worker.mjs', ['--assignment', claimed.assignment_id]);
  cleanup.push(() => stop(worker));
  await until(() => store.get(ticket.id).assignments.at(-1)?.run_id, 'run attachment');
  store.cancel(ticket.id);
  await until(() => ['canceled', 'interrupted'].includes(store.get(ticket.id).status), `cancellation ${worker.errors()}`);
  await until(() => !processAlive(worker.pid), 'worker exit');
  const done = store.get(ticket.id);
  assert.equal(done.assignments[0].result.error.code, 'CANCELED', JSON.stringify(done.assignments[0].result));
  assert.ok(done.events.some(event => event.kind === 'cancel_requested'));
  const late = store.cancel(ticket.id); assert.equal(late.status, 'canceled');
});

test('localhost ticket APIs show attempts and deny foreign or stale mutations', async t => {
  const { store, directory, cleanup } = setup(t);
  const ticket = store.submit(task()), assignment = store.claim(); finish(store, assignment);
  const { server, listen } = createDashboard({ directory, port: 0 });
  const address = await listen(), base = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await (await fetch(`${base}/api/tickets`)).json()).tickets[0].id, ticket.id);
  assert.equal((await (await fetch(`${base}/api/tickets/${ticket.id}`)).json()).assignments.length, 1);
  const url = `${base}/api/tickets/${ticket.id}/verification`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  const options = { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-DSH-Request': 'dashboard' },
    body: JSON.stringify({ assignment_id: assignment.assignment_id, ...acceptance }) };
  assert.equal((await fetch(url, options)).status, 200);
  assert.equal((await fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://example.com' } })).status, 403);
});

test('MCP builds, submits durably, survives client disconnect and records independent acceptance', async t => {
  const { store, directory, cleanup } = setup(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'tools/dsh-mcp/server.mjs')], env: env(directory), stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'ticket-test', version: '1.0.0' });
  await client.connect(transport);
  cleanup.push(async () => {
    await client.close();
    const health = store.health(); if (health.pid && processAlive(health.pid)) {
      process.kill(health.pid); await until(() => !processAlive(health.pid), 'detached runtime cleanup');
    }
  });
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(item => item.name === 'submit_deepseek_task'));
  const built = await client.callTool({ name: 'build_deepseek_task', arguments: input() });
  assert.equal(JSON.parse(built.content[0].text).mode, 'read_only');
  const reply = await client.callTool({ name: 'submit_deepseek_task', arguments: input({ metadata: { fixture_scenario: 'slow' } }) });
  const ticket = JSON.parse(reply.content[0].text);
  await client.close();
  await until(() => store.get(ticket.id).status === 'completed', 'durable task after MCP disconnect');
  const latest = store.get(ticket.id).assignments.at(-1);
  assert.equal(latest.result.final_text, 'fixture ok');
  store.verify(ticket.id, latest.id, acceptance);
  const health = store.health(); process.kill(health.pid);
  await until(() => !processAlive(health.pid), 'MCP detached runtime stop');
});
