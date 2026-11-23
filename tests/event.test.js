'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvent, normalizeEvent, parseStoredLine } = require('../src/event');

const valid = {
  event: 'page_view',
  distinct_id: 'user-1',
  timestamp: '2026-11-23T10:00:00.000Z',
  properties: { plan: 'pro', count: 3, active: true, note: null },
};

test('valid event passes validation', () => {
  assert.deepEqual(validateEvent(valid), []);
});

test('missing event name and distinct_id are rejected', () => {
  assert.ok(validateEvent({}).length >= 2);
  assert.ok(validateEvent({ event: 'x' }).some((e) => e.includes('distinct_id')));
  assert.ok(validateEvent({ distinct_id: 'x' }).some((e) => e.includes('event name')));
});

test('event names must match the allowed pattern', () => {
  assert.ok(validateEvent({ ...valid, event: 'bad name!' }).length > 0);
  assert.ok(validateEvent({ ...valid, event: '.leading-dot' }).length > 0);
  assert.deepEqual(validateEvent({ ...valid, event: 'sign_up.completed-v2' }), []);
});

test('unparseable and far-future timestamps are rejected', () => {
  assert.ok(validateEvent({ ...valid, timestamp: 'not-a-date' }).length > 0);
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.ok(validateEvent({ ...valid, timestamp: future }).length > 0);
});

test('nested property values are rejected; scalars are accepted', () => {
  assert.ok(validateEvent({ ...valid, properties: { nested: { a: 1 } } }).length > 0);
  assert.ok(validateEvent({ ...valid, properties: { list: [1, 2] } }).length > 0);
  assert.deepEqual(validateEvent({ ...valid, properties: { s: 'x', n: 1, b: false, z: null } }), []);
});

test('more than 50 properties are rejected', () => {
  const properties = {};
  for (let i = 0; i < 51; i++) properties[`p${i}`] = 1;
  assert.ok(validateEvent({ ...valid, properties }).length > 0);
});

test('normalizeEvent converts timestamps to epoch ms and defaults properties', () => {
  const normalized = normalizeEvent(valid);
  assert.equal(normalized.timestamp, Date.parse('2026-11-23T10:00:00.000Z'));
  assert.deepEqual(normalizeEvent({ event: 'x', distinct_id: 'y' }).properties, {});
});

test('normalizeEvent throws on invalid input', () => {
  assert.throws(() => normalizeEvent({ event: 'bad name!' }), /invalid event/);
});

test('parseStoredLine returns null for corrupt lines', () => {
  assert.equal(parseStoredLine(''), null);
  assert.equal(parseStoredLine('not json'), null);
  assert.equal(parseStoredLine('{"event": 1}'), null);
  assert.deepEqual(
    parseStoredLine(JSON.stringify({ ...valid, timestamp: Date.parse(valid.timestamp) })),
    { ...valid, timestamp: Date.parse(valid.timestamp) },
  );
});
