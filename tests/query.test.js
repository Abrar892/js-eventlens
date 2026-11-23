'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timeseries, breakdown, top, runQuery, parseQueryParams } = require('../src/query');

const T = (iso) => Date.parse(iso);

function events() {
  return [
    { event: 'page_view', distinct_id: 'u1', timestamp: T('2026-11-23T10:15:00Z'), properties: { plan: 'free', page: '/home' } },
    { event: 'page_view', distinct_id: 'u1', timestamp: T('2026-11-23T10:45:00Z'), properties: { plan: 'free', page: '/pricing' } },
    { event: 'page_view', distinct_id: 'u2', timestamp: T('2026-11-23T11:05:00Z'), properties: { plan: 'pro', page: '/home' } },
    { event: 'page_view', distinct_id: 'u3', timestamp: T('2026-11-24T09:00:00Z'), properties: { plan: 'pro', page: '/home' } },
    { event: 'sign_up', distinct_id: 'u2', timestamp: T('2026-11-23T11:10:00Z'), properties: { plan: 'pro' } },
    { event: 'page_view', distinct_id: 'u4', timestamp: T('2026-11-23T12:00:00Z'), properties: { page: '/home' } },
  ];
}

test('timeseries buckets by day with counts and uniques', () => {
  const result = timeseries(events(), { event: 'page_view', interval: 'day' });
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].bucket, '2026-11-23T00:00:00.000Z');
  assert.equal(result.buckets[0].count, 4);
  assert.equal(result.buckets[0].uniques, 3); // u1 counted once despite 2 views
  assert.equal(result.buckets[1].count, 1);
});

test('timeseries buckets by hour and fills empty buckets', () => {
  const result = timeseries(events(), {
    event: 'page_view',
    interval: 'hour',
    from: T('2026-11-23T10:00:00Z'),
    to: T('2026-11-23T12:00:00Z'),
  });
  assert.equal(result.buckets.length, 3);
  assert.deepEqual(result.buckets.map((b) => b.count), [2, 1, 1]);
});

test('timeseries respects event name and property value filters', () => {
  const byEvent = timeseries(events(), { event: 'sign_up', interval: 'day' });
  assert.equal(byEvent.buckets[0].count, 1);
  const byPlan = timeseries(events(), { event: 'page_view', interval: 'day', property: 'plan', value: 'pro' });
  assert.deepEqual(byPlan.buckets.map((b) => b.count), [1, 1]);
});

test('timeseries on empty input returns no buckets', () => {
  assert.deepEqual(timeseries([], { event: 'page_view', interval: 'day' }).buckets, []);
});

test('breakdown groups by property with uniques and sorts by count', () => {
  const result = breakdown(events(), { event: 'page_view', property: 'plan', limit: 10 });
  assert.equal(result.groups[0].value, 'free');
  assert.equal(result.groups[0].count, 2);
  assert.equal(result.groups[1].value, 'pro');
  assert.equal(result.groups[1].count, 2);
  assert.equal(result.groups[2].value, '(missing)');
  assert.equal(result.groups[2].count, 1);
});

test('breakdown requires a property and top honours the limit', () => {
  assert.throws(() => breakdown(events(), { event: 'page_view' }), /invalid property/);
  const result = top(events(), { event: 'page_view', property: 'page', limit: 1 });
  assert.equal(result.values.length, 1);
  assert.equal(result.values[0].value, '/home');
  assert.equal(result.values[0].count, 4);
});

test('runQuery requires an event and rejects unknown kinds', () => {
  assert.throws(() => runQuery(events(), { kind: 'timeseries' }), /invalid event/);
  assert.throws(() => runQuery(events(), { kind: 'nope', event: 'page_view' }), /invalid kind/);
});

test('parseQueryParams validates interval, limit and range', () => {
  assert.throws(() => parseQueryParams(new URLSearchParams('interval=week')), /invalid interval/);
  assert.throws(() => parseQueryParams(new URLSearchParams('limit=0')), /invalid limit/);
  assert.throws(() => parseQueryParams(new URLSearchParams('limit=101')), /invalid limit/);
  assert.throws(
    () => parseQueryParams(new URLSearchParams('from=2026-11-24&to=2026-11-23')),
    /invalid range/,
  );
  const parsed = parseQueryParams(new URLSearchParams('event=page_view&from=2026-11-23T00:00:00Z&limit=5'));
  assert.equal(parsed.event, 'page_view');
  assert.equal(parsed.from, T('2026-11-23T00:00:00Z'));
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.interval, 'day');
});
