'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/store');
const { createServer } = require('../src/server');

const API_KEY = 'test-key-123';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir).load();
  const server = createServer({ store, apiKey: API_KEY });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ store, port });
    });
  });
}

async function request(port, method, pathname, { body, key = API_KEY } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

const event = (distinct_id, timestamp) => ({
  event: 'page_view', distinct_id, timestamp, properties: { plan: 'pro' },
});

test('health reports status and count without auth', async (t) => {
  const { port } = await setup(t);
  const res = await request(port, 'GET', '/health', { key: null });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.equal(res.json.events, 0);
});

test('API routes reject missing or wrong keys', async (t) => {
  const { port } = await setup(t);
  assert.equal((await request(port, 'GET', '/api/events', { key: null })).status, 401);
  assert.equal((await request(port, 'GET', '/api/events', { key: 'wrong' })).status, 401);
});

test('ingest accepts a single event and a batch', async (t) => {
  const { store, port } = await setup(t);
  const one = await request(port, 'POST', '/api/events', { body: event('u1', '2026-11-23T10:00:00.000Z') });
  assert.equal(one.status, 201);
  assert.equal(one.json.accepted, 1);

  const batch = await request(port, 'POST', '/api/events', {
    body: { events: [event('u2', '2026-11-23T10:01:00.000Z'), event('u3', '2026-11-23T10:02:00.000Z')] },
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.json.accepted, 2);
  assert.equal(store.count(), 3);
});

test('ingest rejects a batch containing an invalid event, atomically', async (t) => {
  const { store, port } = await setup(t);
  const res = await request(port, 'POST', '/api/events', {
    body: { events: [event('u1', '2026-11-23T10:00:00.000Z'), { event: 'bad name!', distinct_id: 'u2' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.rejected.length, 1);
  assert.equal(res.json.rejected[0].index, 1);
  assert.equal(store.count(), 0);
});

test('ingest rejects malformed JSON and empty bodies', async (t) => {
  const { store, port } = await setup(t);
  const bad = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.equal(store.count(), 0);
});

test('GET /api/events lists names and total', async (t) => {
  const { port } = await setup(t);
  await request(port, 'POST', '/api/events', { body: event('u1', '2026-11-23T10:00:00.000Z') });
  await request(port, 'POST', '/api/events', {
    body: { event: 'sign_up', distinct_id: 'u1', timestamp: '2026-11-23T10:05:00.000Z', properties: {} },
  });
  const res = await request(port, 'GET', '/api/events');
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 2);
  assert.deepEqual(res.json.events, ['page_view', 'sign_up']);
});

test('query endpoints answer over HTTP', async (t) => {
  const { port } = await setup(t);
  await request(port, 'POST', '/api/events', {
    body: { events: [
      event('u1', '2026-11-23T10:15:00.000Z'),
      event('u2', '2026-11-23T11:05:00.000Z'),
    ] },
  });
  const series = await request(port, 'GET', '/api/query/timeseries?event=page_view&interval=day');
  assert.equal(series.status, 200);
  assert.equal(series.json.buckets[0].count, 2);
  assert.equal(series.json.buckets[0].uniques, 2);

  const groups = await request(port, 'GET', '/api/query/breakdown?event=page_view&property=plan');
  assert.equal(groups.status, 200);
  assert.equal(groups.json.groups[0].value, 'pro');
  assert.equal(groups.json.groups[0].count, 2);

  const bad = await request(port, 'GET', '/api/query/timeseries?interval=week');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /invalid/);
});

test('funnel and retention endpoints answer over HTTP', async (t) => {
  const { port } = await setup(t);
  await request(port, 'POST', '/api/events', {
    body: { events: [
      { event: 'page_view', distinct_id: 'u1', timestamp: '2026-11-23T10:00:00.000Z', properties: {} },
      { event: 'sign_up', distinct_id: 'u1', timestamp: '2026-11-23T10:05:00.000Z', properties: {} },
      { event: 'page_view', distinct_id: 'u2', timestamp: '2026-11-23T11:00:00.000Z', properties: {} },
    ] },
  });
  const funnel = await request(port, 'POST', '/api/funnel', {
    body: { steps: ['page_view', 'sign_up'], window_hours: 24 },
  });
  assert.equal(funnel.status, 200);
  assert.deepEqual(funnel.json.reached, [2, 1]);

  const retention = await request(port, 'GET', '/api/retention?event=page_view&weeks=2');
  assert.equal(retention.status, 200);
  assert.equal(retention.json.cohorts.length, 1);
  assert.equal(retention.json.cohorts[0].size, 2);

  const badFunnel = await request(port, 'POST', '/api/funnel', { body: { steps: ['only'] } });
  assert.equal(badFunnel.status, 400);
});

test('unknown routes return 404', async (t) => {
  const { port } = await setup(t);
  assert.equal((await request(port, 'GET', '/nope', { key: null })).status, 404);
  assert.equal((await request(port, 'GET', '/api/nope')).status, 404);
});
