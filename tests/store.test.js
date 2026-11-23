'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const e1 = { event: 'page_view', distinct_id: 'u1', timestamp: '2026-11-23T10:00:00.000Z', properties: { plan: 'free' } };
const e2 = { event: 'sign_up', distinct_id: 'u1', timestamp: '2026-11-23T10:05:00.000Z', properties: {} };

test('append stores events and load round-trips them', (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir).load();
  assert.equal(store.count(), 0);
  store.append([e1, e2]);
  assert.equal(store.count(), 2);

  const reloaded = new EventStore(dir).load();
  assert.equal(reloaded.count(), 2);
  assert.equal(reloaded.events[0].timestamp, Date.parse(e1.timestamp));
  assert.deepEqual(reloaded.eventNames(), ['page_view', 'sign_up']);
});

test('append rejects invalid events without writing anything', (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir).load();
  assert.throws(() => store.append({ event: 'bad name!', distinct_id: 'u1' }), /invalid event/);
  assert.equal(store.count(), 0);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('load skips corrupt lines and counts them', (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir).load();
  store.append(e1);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), 'this is not json\n{"event": 1}\n');
  store.append(e2);
  const reloaded = new EventStore(dir).load();
  assert.equal(reloaded.count(), 2);
  assert.equal(reloaded.corruptLines, 2);
});

test('query filters in ingest order', (t) => {
  const dir = tempDir(t);
  const store = new EventStore(dir).load();
  store.append([e1, e2, { ...e1, distinct_id: 'u2' }]);
  const views = store.query((e) => e.event === 'page_view');
  assert.equal(views.length, 2);
  assert.equal(views[0].distinct_id, 'u1');
  assert.equal(views[1].distinct_id, 'u2');
});
