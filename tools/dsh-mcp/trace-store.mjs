import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const terminal = new Set(['completed', 'failed', 'canceled']);
const sensitive = /^(authorization|cookie|set-cookie|api[-_]?key|.*secret.*|.*password.*|access[-_]?token|refresh[-_]?token|id[-_]?token|credential)$/i;

export function traceDirectory(env = process.env) {
  return path.resolve(env.DSH_TRACE_DIR || path.join(root, 'local/observability'));
}

export function sanitize(value, env = process.env, depth = 0) {
  if (depth > 10) return '[truncated]';
  if (typeof value === 'string') {
    let text = value;
    for (const name of ['DEEPSEEK_RELAY_API_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
      if (env[name]) text = text.split(env[name]).join('[REDACTED]');
    }
    return text.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]').slice(0, 32000);
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, env, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [sanitize(key, env), sensitive.test(key) && !/^(input_tokens|output_tokens|total_tokens|inputTokens|outputTokens|totalTokens)$/.test(key)
      ? '[REDACTED]' : sanitize(item, env, depth + 1)]));
  return value;
}

export function readRun(directory, runId) {
  if (!runPattern.test(runId)) throw new Error('Invalid run ID.');
  const file = path.join(directory, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const submitted = events.find(event => event.kind === 'submitted');
  if (!submitted) return null;
  const result = events.findLast(event => event.kind === 'result')?.result;
  const acceptance = events.findLast(event => event.kind === 'verification')?.verification;
  return {
    ...submitted, events, result: result || null,
    status: result?.status || (events.some(event => event.kind === 'working') ? 'working' : 'submitted'),
    acceptance: acceptance || { verdict: 'pending', reviewer: null, evidence: [] },
    finished_at: result?.finished_at || null, duration_ms: result?.duration_ms ?? null,
  };
}

export function listRuns(directory, limit = 200) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => runPattern.test(name.slice(0, -6)) && name.endsWith('.jsonl'))
    .map(name => ({ id: name.slice(0, -6), modified: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified).slice(0, limit).flatMap(({ id }) => {
      const run = readRun(directory, id);
      if (!run) return [];
      const { events, result, ...summary } = run;
      return [{ ...summary, event_count: events.length, error: result?.error || null, usage: result?.usage || null }];
    });
}

export function recordVerification(directory, runId, verification, env = process.env) {
  const run = readRun(directory, runId);
  if (!run) throw new Error('Run not found.');
  if (!terminal.has(run.status)) throw new Error('Wait for the task to finish before verification.');
  if (!['passed', 'failed'].includes(verification?.verdict) ||
      typeof verification.reviewer !== 'string' || !verification.reviewer.trim() ||
      !Array.isArray(verification.evidence) || !verification.evidence.length ||
      !verification.evidence.every(item => typeof item === 'string' && item.trim())) {
    throw new Error('Verification requires passed/failed, a reviewer, and nonempty evidence.');
  }
  if (verification.verdict === 'passed' && run.status !== 'completed') {
    throw new Error('A failed or canceled execution cannot pass acceptance.');
  }
  const entry = sanitize({ kind: 'verification', at: new Date().toISOString(), verification }, env);
  fs.appendFileSync(path.join(directory, `${runId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return readRun(directory, runId).acceptance;
}

function eventSummary(event, includeContent) {
  const summary = {};
  for (const key of ['type', 'phase', 'turn', 'step', 'sessionId', 'cwd', 'name', 'toolName', 'tool_name', 'toolCallId', 'callId', 'id', 'status', 'isError', 'usage', 'reason']) {
    if (event[key] !== undefined) summary[key] = event[key];
  }
  if (event.tool?.name) summary.toolName = event.tool.name;
  if (typeof event.tool === 'string') summary.toolName = event.tool;
  if (event.toolCall?.name) summary.toolName = event.toolCall.name;
  if (includeContent) summary.detail = event;
  return summary;
}

function attributes(values) {
  return Object.entries(values).filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({ key, value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }));
}

export async function exportLangfuse(run, result, env = process.env) {
  if (!env.LANGFUSE_BASE_URL || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return { enabled: false };
  const base = new URL(env.LANGFUSE_BASE_URL);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Langfuse requires HTTPS except on localhost.');
  }
  const response = await fetch(`${base.href.replace(/\/$/, '')}/api/public/otel/v1/traces`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')}` },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'deepseek-dsh-delegate' }) }, scopeSpans: [{
      scope: { name: 'dsh-delegate', version: '1.1.0' }, spans: [{
        traceId: run.trace_id, spanId: run.span_id, ...(run.parent_span_id ? { parentSpanId: run.parent_span_id } : {}),
        name: `delegate:${run.task_id}`, kind: 1,
        startTimeUnixNano: String(BigInt(Date.parse(run.at)) * 1000000n),
        endTimeUnixNano: String(BigInt(Date.parse(result.finished_at)) * 1000000n),
        attributes: attributes(sanitize({ 'task.id': run.task_id, 'task.run_id': run.run_id,
          'task.parent_id': run.parent_task_id, 'task.delegated_by': run.delegated_by,
          'task.status': result.status, 'dsh.session_id': result.session_id,
          'langfuse.observation.type': 'agent', 'verification.status': 'pending',
          'task.error': result.error,
        }, env)),
        status: { code: result.status === 'completed' ? 1 : 2, message: result.error?.code || '' },
      }],
    }] }] }),
  });
  if (!response.ok) throw new Error(`Langfuse export HTTP ${response.status}.`);
  return { enabled: true, sent: true };
}

export function createTrace(task, env = process.env) {
  if (env.DSH_TRACE_ENABLED === '0') return null;
  const directory = traceDirectory(env);
  const runId = randomUUID();
  const meta = task?.metadata || {};
  const run = sanitize({
    kind: 'submitted', at: new Date().toISOString(), run_id: runId,
    trace_id: /^[0-9a-f]{32}$/i.test(meta.trace_id) && !/^0+$/.test(meta.trace_id) ? meta.trace_id : randomBytes(16).toString('hex'),
    span_id: randomBytes(8).toString('hex'),
    parent_span_id: /^[0-9a-f]{16}$/i.test(meta.parent_span_id) && !/^0+$/.test(meta.parent_span_id) ? meta.parent_span_id : null,
    parent_task_id: typeof meta.parent_task_id === 'string' ? meta.parent_task_id : null,
    delegated_by: meta.delegated_by || 'caller', assigned_to: 'DeepSeek Harness',
    task_id: typeof task?.task_id === 'string' ? task.task_id : 'unknown',
    objective: typeof task?.objective === 'string' ? task.objective : '',
    working_directory: task?.working_directory, mode: task?.mode,
    acceptance_criteria: Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : [],
  }, env);
  const file = path.join(directory, `${runId}.jsonl`);
  const toolNames = new Map();
  let recorded = true;
  const write = entry => {
    try {
      fs.appendFileSync(file, `${JSON.stringify(sanitize({ at: new Date().toISOString(), ...entry }, env))}\n`, { mode: 0o600 });
    } catch (error) {
      if (recorded) process.stderr.write(`DSH trace unavailable: ${sanitize(error.message, env)}\n`);
      recorded = false;
    }
  };
  try { fs.mkdirSync(directory, { recursive: true }); } catch { /* The write below reports the failure. */ }
  write(run);
  return {
    run,
    write,
    event(event) {
      const summary = eventSummary(event, env.DSH_TRACE_CONTENT === '1');
      if (summary.callId && summary.toolName) toolNames.set(summary.callId, summary.toolName);
      if (summary.callId && !summary.toolName && toolNames.has(summary.callId)) summary.toolName = toolNames.get(summary.callId);
      write({ kind: 'dsh_event', event: summary });
    },
    async finish(result) {
      const observable = { run_id: runId, trace_id: run.trace_id, span_id: run.span_id, recorded };
      result.observability = observable;
      write({ kind: 'result', result });
      observable.recorded = recorded;
      try {
        const exported = await exportLangfuse(run, result, env);
        if (exported.enabled) write({ kind: 'export', target: 'langfuse', status: 'sent' });
      } catch (error) { write({ kind: 'export', target: 'langfuse', status: 'failed', message: sanitize(error.message, env) }); }
    },
  };
}
