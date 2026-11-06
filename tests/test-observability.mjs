import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { executeTask, root, validateResult } from '../tools/dsh-mcp/task-runner.mjs';
import { listRuns, readRun, recordVerification, exportLangfuse, createTrace } from '../tools/dsh-mcp/trace-store.mjs';
import { createDashboard } from '../tools/dsh-mcp/dashboard.mjs';
import { Client } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const template = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/task.json'), 'utf8'));
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh traces '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { DEEPSEEK_RELAY_API_KEY: 'test-secret-value', DSH_TRACE_DIR: directory, DSH_TRACE_ENABLED: '1',
    DSH_TRACE_CONTENT: '1', LANGFUSE_BASE_URL: '', LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' };
  const task = { ...structuredClone(template), working_directory: root,
    metadata: { delegated_by: 'codex', parent_task_id: 'parent-001' } };
  return { directory, env, task, run: overrides => executeTask({ ...task, ...overrides }, {
    env, dshPath: path.join(root, 'tests/fixtures/fake-dsh.mjs'),
  }) };
}

test('persists handoffs, events and independent acceptance without credentials', async t => {
  const setupRun = setup(t);
  const { result } = await setupRun.run({ metadata: { ...setupRun.task.metadata, fixture_scenario: 'secret' } });
  assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
  assert.equal(result.observability.recorded, true);
  const runs = listRuns(setupRun.directory);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].parent_task_id, 'parent-001');
  assert.equal(runs[0].acceptance.verdict, 'pending');
  const stored = readRun(setupRun.directory, result.observability.run_id);
  assert.ok(stored.events.some(event => event.kind === 'dsh_event'));
  assert.equal(JSON.stringify(stored).includes('test-secret-value'), false);
  assert.throws(() => recordVerification(setupRun.directory, runs[0].run_id, { verdict: 'passed', reviewer: 'codex', evidence: [] }));
  recordVerification(setupRun.directory, runs[0].run_id, { verdict: 'passed', reviewer: 'codex', evidence: ['Inspected the returned fixture response.'] });
  assert.equal(readRun(setupRun.directory, runs[0].run_id).acceptance.verdict, 'passed');
});

test('repeated task IDs have distinct runs and failed tasks cannot pass acceptance', async t => {
  const { run, directory } = setup(t);
  const first = await run({ metadata: { fixture_scenario: 'failure' } });
  const second = await run();
  assert.notEqual(first.result.observability.run_id, second.result.observability.run_id);
  assert.equal(listRuns(directory).length, 2);
  assert.throws(() => recordVerification(directory, first.result.observability.run_id,
    { verdict: 'passed', reviewer: 'codex', evidence: ['Checked'] }), /cannot pass/);
  assert.throws(() => readRun(directory, '../../file'), /Invalid run/);
});

test('trace storage failures never change task completion', async t => {
  const { run, env, directory } = setup(t);
  const blocker = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'fixture');
  env.DSH_TRACE_DIR = blocker;
  const { result } = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.observability.recorded, false);
});

test('links DSH string tool names to tool results without persisting arguments', t => {
  const { directory, env, task } = setup(t);
  env.DSH_TRACE_CONTENT = '0';
  const trace = createTrace(task, env);
  trace.event({ type: 'tool_call', callId: 'call-1', tool: 'pwsh', input: { command: 'private command' } });
  trace.event({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'private result' });
  const events = readRun(directory, trace.run.run_id).events.filter(event => event.kind === 'dsh_event');
  assert.deepEqual(events.map(event => event.event.toolName), ['pwsh', 'pwsh']);
  assert.equal(JSON.stringify(events).includes('private'), false);
});

test('localhost dashboard serves runs, prevents foreign requests and records evidence', async t => {
  const { run, directory } = setup(t);
  const { result } = await run();
  const { server, listen } = createDashboard({ directory, port: 0 });
  const address = await listen();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${address.port}`;
  assert.match(await (await fetch(base)).text(), /DSH/);
  assert.equal((await (await fetch(`${base}/api/runs`)).json()).runs.length, 1);
  assert.equal((await fetch(`${base}/api/runs`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/.git/config`)).status, 404);
  const url = `${base}/api/runs/${result.observability.run_id}/verification`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  const response = await fetch(url, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-DSH-Request': 'dashboard' },
    body: JSON.stringify({ verdict: 'passed', reviewer: 'tester', evidence: ['Inspected test fixture.'] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verdict, 'passed');
});

test('Langfuse interface emits OTLP with metadata only and explicit authentication', async t => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const now = new Date().toISOString();
  const run = { task_id: 'sample', run_id: 'run', trace_id: '1'.repeat(32), span_id: '2'.repeat(16), at: now, delegated_by: 'codex' };
  const result = { status: 'completed', session_id: 'session', finished_at: now, final_text: 'private-result' };
  const exported = await exportLangfuse(run, result, { LANGFUSE_BASE_URL: `http://127.0.0.1:${server.address().port}`, LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test' });
  assert.equal(exported.sent, true);
  assert.equal(received.path, '/api/public/otel/v1/traces');
  assert.equal(received.authorization, `Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`);
  assert.equal(received.body.resourceSpans[0].scopeSpans[0].spans[0].traceId, run.trace_id);
  assert.equal(JSON.stringify(received.body).includes('private-result'), false);
  await assert.rejects(exportLangfuse(run, result, { LANGFUSE_BASE_URL: 'http://example.com', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }), /HTTPS/);
});

test('MCP exposes acceptance and shares task trace identifiers with the dashboard', async t => {
  const { directory, env, task } = setup(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'tools/dsh-mcp/server.mjs')],
    env: { ...process.env, ...env, DEEPSEEK_DSH_PATH: path.join(root, 'tests/fixtures/fake-dsh.mjs'), DSH_DASHBOARD_AUTO_START: '0' },
    stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'observability-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'record_deepseek_verification'));
  const reply = await client.callTool({ name: 'delegate_to_deepseek', arguments: task });
  const runId = reply.structuredContent.observability.run_id;
  const verification = await client.callTool({ name: 'record_deepseek_verification', arguments: {
    run_id: runId, verdict: 'passed', reviewer: 'test-caller', evidence: ['Independently checked fixture ok.'],
  } });
  assert.equal(JSON.parse(verification.content[0].text).verdict, 'passed');
  assert.equal(readRun(directory, runId).acceptance.reviewer, 'test-caller');
});
