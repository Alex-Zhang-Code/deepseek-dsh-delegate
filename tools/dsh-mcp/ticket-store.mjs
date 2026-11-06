import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertTask } from './task-builder.mjs';
import { canonicalPath, redact } from './task-runner.mjs';
import { sanitize, traceDirectory } from './trace-store.mjs';

const now = () => new Date().toISOString();
const decode = value => value ? JSON.parse(value) : null;
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function overlaps(left, right) {
  if (process.platform === 'win32') { left = left.toLowerCase(); right = right.toLowerCase(); }
  const relative = path.relative(left, right);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function conflicting(a, b) {
  // Canonicalize again at admission, since a queued workspace may have been moved.
  const left = canonicalPath(a.working_directory), right = canonicalPath(b.working_directory);
  return overlaps(left, right) || overlaps(right, left) || Boolean(a.session_id && a.session_id === b.session_id);
}

export class TicketStore {
  constructor(directory = traceDirectory()) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, 'tickets.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        task TEXT NOT NULL, status TEXT NOT NULL, current_assignment TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, number INTEGER NOT NULL,
        status TEXT NOT NULL, pid INTEGER, heartbeat TEXT, started_at TEXT NOT NULL,
        finished_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
        run_id TEXT, result TEXT, acceptance TEXT);
      CREATE TABLE IF NOT EXISTS ticket_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, at TEXT NOT NULL,
        kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assignment_ticket ON assignments(ticket_id);
      CREATE INDEX IF NOT EXISTS events_ticket ON ticket_events(ticket_id);
      CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER, heartbeat TEXT, workers INTEGER);`);
  }
  close() { this.db.close(); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id, kind, detail = {}) {
    this.db.prepare('INSERT INTO ticket_events(ticket_id,at,kind,detail) VALUES (?,?,?,?)')
      .run(id, now(), kind, JSON.stringify(sanitize(detail)));
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id=? OR task_id=?').get(id, id);
    if (!row) throw new Error('Ticket not found.');
    const assignments = this.db.prepare('SELECT * FROM assignments WHERE ticket_id=? ORDER BY number').all(row.id)
      .map(item => ({ ...item, cancel_requested: Boolean(item.cancel_requested), result: decode(item.result),
        acceptance: decode(item.acceptance) || { verdict: 'pending', reviewer: null, evidence: [] } }));
    return { ...row, task: decode(row.task), assignments,
      events: this.db.prepare('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY seq').all(row.id)
        .map(item => ({ ...item, detail: decode(item.detail) })) };
  }
  list(limit = 200) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000.');
    return this.db.prepare('SELECT id FROM tickets ORDER BY updated_at DESC LIMIT ?').all(limit)
      .map(({ id }) => { const { task, assignments, events, ...row } = this.get(id);
        const last = assignments.at(-1);
        return { ...row, objective: task.objective, working_directory: task.working_directory,
          mode: task.mode, attempts: assignments.length, run_id: last?.run_id || null,
          run_ids: assignments.map(item => item.run_id).filter(Boolean),
          acceptance: last?.acceptance || { verdict: 'pending' }, error: last?.result?.error || null }; });
  }
  submit(task) {
    assertTask(task);
    const normalized = { allowed_paths: [], forbidden_actions: [], context: '', timeout_seconds: 120, metadata: {}, ...task };
    const body = stable(normalized);
    if (process.env.DEEPSEEK_RELAY_API_KEY && body.includes(process.env.DEEPSEEK_RELAY_API_KEY)) {
      throw new Error('Do not place credentials in task contents.');
    }
    const fingerprint = createHash('sha256').update(body).digest('hex');
    return this.tx(() => {
      const existing = this.db.prepare('SELECT id,fingerprint FROM tickets WHERE task_id=?').get(task.task_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(`TASK_CONFLICT: task_id already has fingerprint ${existing.fingerprint}`);
        return { ...this.get(existing.id), deduplicated: true };
      }
      const id = randomUUID(), at = now();
      this.db.prepare('INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?)')
        .run(id, task.task_id, fingerprint, body, 'submitted', null, at, at);
      this.event(id, 'submitted', { delegated_by: task.metadata?.delegated_by || 'caller' });
      return { ...this.get(id), deduplicated: false };
    });
  }
  heartbeat(workers) {
    this.db.prepare('INSERT OR REPLACE INTO runtime VALUES (1,?,?,?)').run(process.pid, now(), workers);
  }
  acquireRuntime(workers) {
    return this.tx(() => {
      const previous = this.db.prepare('SELECT pid FROM runtime WHERE id=1').get();
      if (previous?.pid !== process.pid && processAlive(previous?.pid)) return false;
      this.heartbeat(workers);
      return true;
    });
  }
  health() {
    const runtime = this.db.prepare('SELECT * FROM runtime WHERE id=1').get();
    return { ...runtime, alive: Boolean(runtime && processAlive(runtime.pid) && Date.now() - Date.parse(runtime.heartbeat) < 10000) };
  }
  recover({ launchGraceMs = 30000 } = {}) {
    return this.tx(() => {
      for (const row of this.db.prepare("SELECT * FROM assignments WHERE status='working'").all()) {
        if (row.pid ? processAlive(row.pid) : Date.now() - Date.parse(row.started_at) < launchGraceMs) continue;
        this.db.prepare("UPDATE assignments SET status='interrupted',finished_at=? WHERE id=?").run(now(), row.id);
        this.db.prepare("UPDATE tickets SET status='interrupted',updated_at=? WHERE current_assignment=?").run(now(), row.id);
        this.event(row.ticket_id, 'interrupted', { assignment_id: row.id, message: 'Supervisor disappeared; inspect side effects and processes before explicit retry or resolution.' });
      }
    });
  }
  claim(maxWorkers = 1) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) throw new Error('workers must be 1..4.');
    return this.tx(() => {
      const active = this.db.prepare("SELECT task,status FROM tickets WHERE status IN ('working','interrupted')").all();
      if (active.filter(row => row.status === 'working').length >= maxWorkers) return null;
      const queued = this.db.prepare("SELECT * FROM tickets WHERE status='submitted' ORDER BY created_at,id").all();
      for (const row of queued) {
        const task = decode(row.task);
        try {
          assertTask(task);
          if (active.some(item => conflicting(task, decode(item.task)))) continue;
        } catch { continue; } // Invalid/moved workspaces remain visible and cancellable.
        const id = randomUUID(), at = now();
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE ticket_id=?').get(row.id).n;
        this.db.prepare('INSERT INTO assignments(id,ticket_id,number,status,started_at) VALUES (?,?,?,?,?)')
          .run(id, row.id, count + 1, 'working', at);
        this.db.prepare("UPDATE tickets SET status='working',current_assignment=?,updated_at=? WHERE id=?").run(id, at, row.id);
        this.event(row.id, 'assigned', { assignment_id: id, number: count + 1 });
        return { ticket_id: row.id, assignment_id: id };
      }
      return null;
    });
  }
  attach(assignmentId, pid) {
    return this.tx(() => {
      const row = this.assignment(assignmentId);
      if (row.status !== 'working' || row.pid) throw new Error('Assignment already owned or terminal.');
      this.db.prepare('UPDATE assignments SET pid=?,heartbeat=? WHERE id=?').run(pid, now(), assignmentId);
      return this.get(row.ticket_id);
    });
  }
  assignment(id) {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id=?').get(id);
    if (!row) throw new Error('Assignment not found.');
    return row;
  }
  pulse(id) { this.db.prepare('UPDATE assignments SET heartbeat=? WHERE id=?').run(now(), id); return this.assignment(id); }
  setRun(id, runId) { this.db.prepare('UPDATE assignments SET run_id=? WHERE id=?').run(runId, id); }
  finish(id, result) {
    return this.tx(() => {
      const row = this.assignment(id);
      if (row.pid && row.pid !== process.pid) throw new Error('Only the owning supervisor may finish this assignment.');
      if (row.status !== 'working') return false;
      const status = result.error?.code === 'PROCESS_CLEANUP_FAILED' ? 'interrupted' : result.status;
      if (!['completed', 'failed', 'canceled', 'interrupted'].includes(status)) throw new Error('Invalid final status.');
      this.db.prepare('UPDATE assignments SET status=?,result=?,finished_at=? WHERE id=?')
        .run(status, JSON.stringify(redact(result)), now(), id);
      this.db.prepare('UPDATE tickets SET status=?,updated_at=? WHERE current_assignment=?').run(status, now(), id);
      this.event(row.ticket_id, 'finished', { assignment_id: id, status, error: result.error });
      return true;
    });
  }
  cancel(id) {
    return this.tx(() => {
      const ticket = this.get(id);
      if (ticket.status === 'submitted') this.db.prepare("UPDATE tickets SET status='canceled',updated_at=? WHERE id=?").run(now(), ticket.id);
      else if (ticket.status === 'working') this.db.prepare('UPDATE assignments SET cancel_requested=1 WHERE id=?').run(ticket.current_assignment);
      else return ticket;
      this.event(ticket.id, 'cancel_requested', { assignment_id: ticket.current_assignment });
      return this.get(ticket.id);
    });
  }
  retry(id, assignmentId, reviewed, reason, resolve = false) {
    if (reviewed !== true || typeof reason !== 'string' || !reason.trim()) throw new Error('Explicit side_effects_reviewed=true and review evidence are required.');
    return this.tx(() => {
      const ticket = this.get(id);
      if (!['failed', 'canceled', 'interrupted', 'completed'].includes(ticket.status) || ticket.current_assignment !== assignmentId) {
        throw new Error('Wait for a terminal ticket and name its latest assignment (null if never started).');
      }
      const last = ticket.assignments.at(-1);
      if (resolve && ticket.status !== 'interrupted') throw new Error('Only interrupted tickets need reviewed resolution.');
      if (last?.acceptance.verdict === 'passed' && !resolve) throw new Error('Accepted tickets require a new task_id.');
      if (ticket.status === 'interrupted' && last?.pid && processAlive(last.pid)) throw new Error('Previous supervisor is still alive.');
      this.db.prepare('UPDATE tickets SET status=?,updated_at=? WHERE id=?').run(resolve ? 'canceled' : 'submitted', now(), ticket.id);
      this.event(ticket.id, resolve ? 'resolved' : 'retry_requested', { assignment_id: assignmentId, reason });
      return this.get(ticket.id);
    });
  }
  verify(id, assignmentId, verification) {
    return this.tx(() => {
      const ticket = this.get(id), last = ticket.assignments.at(-1);
      if (!last || last.id !== assignmentId || !['completed', 'failed', 'canceled'].includes(ticket.status)) throw new Error('Only the latest terminal assignment can be verified.');
      if (!['passed', 'failed'].includes(verification?.verdict) || !verification.reviewer?.trim() ||
          !Array.isArray(verification.evidence) || !verification.evidence.length ||
          !verification.evidence.every(value => typeof value === 'string' && value.trim())) throw new Error('Reviewer and nonempty evidence are required.');
      if (verification.verdict === 'passed' && ticket.status !== 'completed') throw new Error('Only completed execution can pass acceptance.');
      const accepted = sanitize({ ...verification, at: now() });
      this.db.prepare('UPDATE assignments SET acceptance=? WHERE id=?').run(JSON.stringify(accepted), assignmentId);
      this.db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(now(), ticket.id);
      this.event(ticket.id, 'verification', { assignment_id: assignmentId, ...accepted });
      return accepted;
    });
  }
  findRun(runId) { return this.db.prepare('SELECT ticket_id,id FROM assignments WHERE run_id=?').get(runId); }
}
