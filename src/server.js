'use strict';

const http = require('node:http');
const { EventStore } = require('./store');
const { validateEvent } = require('./event');

// query.js and funnel.js are loaded lazily inside their handlers so the
// server module stays usable before those stages land.

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BATCH_EVENTS = 1000;

/**
 * HTTP analytics server (zero dependencies, node:http only).
 *
 * Routes:
 *   GET  /health                    liveness + event count (no auth)
 *   GET  /                         dashboard page (no auth)
 *   GET  /api/events               event names + total count
 *   POST /api/events               ingest one event or { events: [...] }
 *   GET  /api/query/timeseries     ?event&from&to&interval&property&value
 *   GET  /api/query/breakdown      ?event&property&from&to&limit
 *   GET  /api/query/top            ?event&property&from&to&limit
 *   POST /api/funnel               { steps, from, to, window_hours }
 *   GET  /api/retention            ?event&cohort_weeks&weeks
 *
 * Auth: every /api/* route except /health requires
 * `Authorization: Bearer <key>`, where the key is EVENTLENS_API_KEY
 * (default "dev-key-change-me" — set a real key in production).
 * Reads and writes share the one key on purpose: this is a single-tenant
 * local analytics collector, not a multi-tenant SaaS.
 */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds 1 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) throw new Error('empty request body');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

function createServer({ store, apiKey, dashboardHtml }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/health' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', events: store.count(), corrupt_lines: store.corruptLines });
      }
      if (pathname === '/' && req.method === 'GET') {
        const html = dashboardHtml || '<h1>EventLens</h1><p>Dashboard not built yet.</p>';
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }

      if (!pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' });
      }

      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${apiKey}`) {
        return sendJson(res, 401, { error: 'missing or invalid API key' });
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        return sendJson(res, 200, { total: store.count(), events: store.eventNames() });
      }

      if (pathname === '/api/events' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const rawEvents = Array.isArray(body.events) ? body.events : [body];
        if (rawEvents.length === 0) return sendJson(res, 400, { error: 'no events provided' });
        if (rawEvents.length > MAX_BATCH_EVENTS) {
          return sendJson(res, 400, { error: `at most ${MAX_BATCH_EVENTS} events per batch` });
        }
        // Validate everything first: a batch is all-or-nothing, so one bad
        // event never leaves a half-ingested batch behind.
        const rejected = [];
        rawEvents.forEach((raw, index) => {
          const errors = validateEvent(raw);
          if (errors.length > 0) rejected.push({ index, errors });
        });
        if (rejected.length > 0) {
          return sendJson(res, 400, { error: 'invalid events in batch', rejected });
        }
        const stored = store.append(rawEvents);
        return sendJson(res, 201, { accepted: stored.length });
      }

      if (pathname === '/api/query/timeseries' && req.method === 'GET') {
        const { runQuery, parseQueryParams } = require('./query');
        const params = parseQueryParams(url.searchParams);
        return sendJson(res, 200, runQuery(store.events, { ...params, kind: 'timeseries' }));
      }
      if (pathname === '/api/query/breakdown' && req.method === 'GET') {
        const { runQuery, parseQueryParams } = require('./query');
        const params = parseQueryParams(url.searchParams);
        return sendJson(res, 200, runQuery(store.events, { ...params, kind: 'breakdown' }));
      }
      if (pathname === '/api/query/top' && req.method === 'GET') {
        const { runQuery, parseQueryParams } = require('./query');
        const params = parseQueryParams(url.searchParams);
        return sendJson(res, 200, runQuery(store.events, { ...params, kind: 'top' }));
      }

      if (pathname === '/api/funnel' && req.method === 'POST') {
        const { runFunnel } = require('./funnel');
        const body = await readJsonBody(req);
        return sendJson(res, 200, runFunnel(store.events, body));
      }

      if (pathname === '/api/retention' && req.method === 'GET') {
        const { runRetention } = require('./funnel');
        const { parseQueryParams } = require('./query');
        const params = parseQueryParams(url.searchParams);
        return sendJson(res, 200, runRetention(store.events, params));
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err.message === 'request body exceeds 1 MB' || err.message === 'empty request body'
        || err.message === 'request body is not valid JSON') {
        return sendJson(res, 400, { error: err.message });
      }
      // runQuery / runFunnel / runRetention throw plain Errors for bad params.
      if (err instanceof Error && err.message.startsWith('invalid ')) {
        return sendJson(res, 400, { error: err.message });
      }
      console.error(err);
      return sendJson(res, 500, { error: 'internal server error' });
    }
  });
  return server;
}

function startServer({ dataDir, port, apiKey, dashboardHtml }) {
  const store = new EventStore(dataDir).load();
  const server = createServer({ store, apiKey, dashboardHtml });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, store, port: server.address().port }));
  });
}

module.exports = { createServer, startServer, sendJson };
