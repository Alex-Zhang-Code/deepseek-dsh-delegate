import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listRuns, readRun, recordVerification, sanitize, traceDirectory } from './trace-store.mjs';
import { TicketStore } from './ticket-store.mjs';
import { ensureRuntime, verifyRun } from './ticket-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (res, code, value) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

export function createDashboard({ directory = traceDirectory(), port = 8766 } = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    let store;
    try {
      const hosts = new Set([`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`]);
      if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Localhost host required.' });
      const origin = req.headers.origin;
      if (origin && ![...hosts].some(host => origin === `http://${host}`)) return json(res, 403, { error: 'Cross-origin requests are denied.' });
      store = new TicketStore(directory);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { service: 'dsh-observatory', version: 2, directory, executor: store.health() });
      if (req.method === 'GET' && url.pathname === '/api/tickets') return json(res, 200, { tickets: store.list(), executor: store.health() });
      const ticketMatch = /^\/api\/tickets\/([A-Za-z0-9._-]+)(?:\/(cancel|retry|resolve|verification))?$/.exec(url.pathname);
      if (ticketMatch && req.method === 'GET' && !ticketMatch[2]) return json(res, 200, store.get(ticketMatch[1]));
      if (ticketMatch?.[2] && req.method === 'POST') {
        if (!origin || req.headers['x-dsh-request'] !== 'dashboard' || !req.headers['content-type']?.startsWith('application/json')) {
          return json(res, 403, { error: 'Same-origin JSON request required.' });
        }
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) return json(res, 413, { error: 'Request too large.' }); }
        const input = JSON.parse(body), action = ticketMatch[2], id = ticketMatch[1];
        let reply;
        if (action === 'cancel') reply = store.cancel(id);
        else if (action === 'verification') reply = store.verify(id, input.assignment_id, input);
        else {
          reply = store.retry(id, input.assignment_id, input.side_effects_reviewed, input.reason, action === 'resolve');
          if (action === 'retry') reply.executor = await ensureRuntime(directory);
        }
        return json(res, 200, reply);
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, { runs: listRuns(directory) });
      const match = /^\/api\/runs\/([0-9a-f-]+)(\/verification)?$/i.exec(url.pathname);
      if (match && req.method === 'GET' && !match[2]) {
        const run = readRun(directory, match[1]);
        const assignment = store.findRun(match[1]);
        if (run && assignment) run.acceptance = store.get(assignment.ticket_id).assignments.find(item => item.id === assignment.id).acceptance;
        return json(res, run ? 200 : 404, run || { error: 'Run not found.' });
      }
      if (match?.[2] && req.method === 'POST') {
        if (!origin || req.headers['x-dsh-request'] !== 'dashboard' || !req.headers['content-type']?.startsWith('application/json')) {
          return json(res, 403, { error: 'Same-origin JSON request required.' });
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 65536) return json(res, 413, { error: 'Request too large.' });
        }
        return json(res, 200, verifyRun(directory, match[1], JSON.parse(body)));
      }
      const assets = {
        '/': ['dashboard/index.html', 'text/html; charset=utf-8'],
        '/app.js': ['dashboard/app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['dashboard/style.css', 'text/css; charset=utf-8'],
        '/lucide.js': ['node_modules/lucide/dist/umd/lucide.js', 'text/javascript; charset=utf-8'],
      };
      const asset = assets[url.pathname];
      if (req.method !== 'GET' || !asset) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(here, asset[0])));
    } catch (error) { json(res, 400, { error: sanitize(error.message) }); }
    finally { store?.close(); }
  });
  return { server, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address()));
  }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, directory: { type: 'string' } } });
  const port = Number(values.port || process.env.DSH_DASHBOARD_PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  const { listen } = createDashboard({ port, directory: values.directory || traceDirectory() });
  const address = await listen();
  try { await ensureRuntime(values.directory || traceDirectory()); }
  catch (error) { process.stderr.write(`${sanitize(error.message)}\n`); }
  process.stdout.write(`DSH dashboard http://127.0.0.1:${address.port}\n`);
}
