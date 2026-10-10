import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { executeTask, taskSchema, resultSchema, validateResult, redact } from './task-runner.mjs';

const server = new Server({ name: 'deepseek-dsh', version: '1.0.0' }, { capabilities: { tools: {} } });
const shutdownController = new AbortController();
let queue = Promise.resolve();
let closing = false;

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
  name: 'delegate_to_deepseek',
  description: 'Delegate a bounded task to local DeepSeek Harness and wait for a normalized result. '
    + 'Reads/writes are prompt constraints, not an OS sandbox. completed requires caller semantic verification. '
    + 'No automatic retries. The timeout excludes time waiting in this server\'s serial queue.',
  inputSchema: taskSchema,
  outputSchema: resultSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}] }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== 'delegate_to_deepseek') {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown tool.');
  }
  const signal = AbortSignal.any([extra.signal, shutdownController.signal]);
  const job = queue.then(() => executeTask(request.params.arguments, { signal }));
  queue = job.then(() => undefined, () => undefined);
  const { result } = await job;
  if (!validateResult(result)) throw new McpError(ErrorCode.InternalError, 'Invalid normalized task result.');
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.status !== 'completed',
  };
});

async function shutdown() {
  if (closing) return;
  closing = true;
  shutdownController.abort();
  await server.close();
  await queue;
}

server.onclose = () => { void shutdown(); };
server.onerror = error => { process.stderr.write(`${redact(error.message)}\n`); };
// The SDK transport does not close itself on stdin EOF.
process.stdin.once('end', () => { void shutdown(); });
process.stdin.once('error', () => { void shutdown(); });
process.stdout.once('error', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
await server.connect(new StdioServerTransport());
