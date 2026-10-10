import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tools/dsh-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { executeTask, root, validateResult } from '../tools/dsh-mcp/task-runner.mjs';

const task = JSON.parse(fs.readFileSync(path.join(root, 'examples/dsh-connectivity.task.json'), 'utf8'));
task.working_directory = root;
const expected = '\u8fde\u63a5\u6b63\u5e38\u3002';
function verify(result) {
  assert.equal(validateResult(result), true);
  assert.equal(result.status, 'completed', result.error?.code || 'Task did not complete.');
  assert.equal(result.final_text.trim(), expected);
  assert.equal(result.events?.some(event => event.type.startsWith('tool')), false);
}
test('live shared runner: no-tools connectivity task', async () => {
  const outcome = await executeTask(task, { includeEvents: true });
  verify(outcome.result);
  assert.equal(outcome.exitCode, 0);
});
test('live MCP SDK: delegate_to_deepseek', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'tools/dsh-mcp/server.mjs')], cwd: root, env: { ...process.env }, stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'dsh-live-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await client.listTools();
    const reply = await client.callTool({ name: 'delegate_to_deepseek', arguments: task }, undefined, { timeout: 150000 });
    assert.equal(reply.isError, false, reply.structuredContent?.error?.code);
    const result = reply.structuredContent;
    assert.equal(result.status, 'completed');
    assert.equal(result.final_text.trim(), expected);
    assert.equal(result.verification.semantic, 'required_by_caller');
  } finally { await client.close(); }
});
