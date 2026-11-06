import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { executeTask, taskSchema, resultSchema, validateResult, redact } from './task-runner.mjs';
import { createTrace, recordVerification, traceDirectory } from './trace-store.mjs';
import { ensureDashboard } from './dashboard-launcher.mjs';
import { buildTask, builderSchema } from './task-builder.mjs';
import { TicketStore } from './ticket-store.mjs';
import { submitTicket, ensureRuntime, verifyRun } from './ticket-service.mjs';

const ticketIdSchema = { type: 'object', additionalProperties: false, required: ['ticket_id'],
  properties: { ticket_id: { type: 'string', minLength: 1 } } };
const retrySchema = { ...ticketIdSchema, required: ['ticket_id', 'assignment_id', 'side_effects_reviewed', 'reason'],
  properties: { ...ticketIdSchema.properties, assignment_id: { type: ['string', 'null'] },
    side_effects_reviewed: { const: true }, reason: { type: 'string', minLength: 1 } } };
const ticketTools = [
  ['build_deepseek_task', 'Build and validate a full task without running it. Defaults to read_only and never expands allowed paths.', builderSchema],
  ['submit_deepseek_task', 'Submit a durable asynchronous ticket and return immediately. Poll get_deepseek_task; completion does not wake an inactive conversation. No automatic retries.', builderSchema],
  ['get_deepseek_task', 'Read a ticket, its assignments, execution result, acceptance and handoff events.', ticketIdSchema],
  ['list_deepseek_tasks', 'List durable tickets and executor liveness.', { type: 'object', additionalProperties: false }],
  ['cancel_deepseek_task', 'Request cancellation. Running work stops asynchronously; side effects are not rolled back.', ticketIdSchema],
  ['retry_deepseek_task', 'Explicitly requeue after inspecting side effects and processes. Requires latest assignment ID (null if never started) and review evidence.', retrySchema],
  ['resolve_deepseek_task', 'Close a reviewed interrupted ticket without rerunning. Release its workspace reservation only after inspecting surviving processes and effects.', retrySchema],
  ['verify_deepseek_task', 'Record independent acceptance against the latest terminal assignment.', {
    ...ticketIdSchema, required: ['ticket_id', 'assignment_id', 'verdict', 'reviewer', 'evidence'], properties: {
      ...ticketIdSchema.properties, assignment_id: { type: 'string' }, verdict: { enum: ['passed', 'failed'] },
      reviewer: { type: 'string', minLength: 1 }, evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    },
  }],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema,
  annotations: { readOnlyHint: /^(build|get|list)_/.test(name), destructiveHint: !/^(build|get|list|verify)_/.test(name), openWorldHint: name === 'submit_deepseek_task' } }));

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
}, {
  name: 'record_deepseek_verification',
  description: 'Record the caller\'s independent acceptance result for a finished DSH run. Evidence is mandatory; completed alone is not acceptance.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['run_id', 'verdict', 'reviewer', 'evidence'], properties: {
    run_id: { type: 'string', format: 'uuid' }, verdict: { enum: ['passed', 'failed'] },
    reviewer: { type: 'string', minLength: 1 }, evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, ...ticketTools] }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'record_deepseek_verification') {
    try {
      const { run_id, ...verification } = request.params.arguments || {};
      const acceptance = verifyRun(traceDirectory(), run_id, verification);
      return { content: [{ type: 'text', text: JSON.stringify(acceptance) }] };
    } catch (error) { throw new McpError(ErrorCode.InvalidParams, redact(error.message)); }
  }
  if (ticketTools.some(tool => tool.name === request.params.name)) {
    try {
      const name = request.params.name, args = request.params.arguments || {};
      let reply;
      if (name === 'build_deepseek_task') reply = buildTask(args);
      else if (name === 'submit_deepseek_task') reply = await submitTicket(buildTask(args));
      else {
        const store = new TicketStore();
        try {
          if (name === 'get_deepseek_task') reply = store.get(args.ticket_id);
          if (name === 'list_deepseek_tasks') reply = { tickets: store.list(), executor: store.health() };
          if (name === 'cancel_deepseek_task') reply = store.cancel(args.ticket_id);
          if (name === 'retry_deepseek_task' || name === 'resolve_deepseek_task') reply = store.retry(args.ticket_id, args.assignment_id,
            args.side_effects_reviewed, args.reason, name === 'resolve_deepseek_task');
          if (name === 'verify_deepseek_task') reply = store.verify(args.ticket_id, args.assignment_id,
            { verdict: args.verdict, reviewer: args.reviewer, evidence: args.evidence });
        } finally { store.close(); }
        if (name === 'retry_deepseek_task') reply.executor = await ensureRuntime();
      }
      return { content: [{ type: 'text', text: JSON.stringify(redact(reply)) }] };
    } catch (error) { throw new McpError(ErrorCode.InvalidParams, redact(error.message)); }
  }
  if (request.params.name !== 'delegate_to_deepseek') {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown tool.');
  }
  const signal = AbortSignal.any([extra.signal, shutdownController.signal]);
  const trace = createTrace(request.params.arguments);
  const job = queue.then(() => executeTask(request.params.arguments, { signal, trace }));
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
if (process.env.DSH_DASHBOARD_AUTO_START === '1') {
  void ensureDashboard().catch(error => process.stderr.write(`DSH dashboard: ${redact(error.message)}\n`));
}
