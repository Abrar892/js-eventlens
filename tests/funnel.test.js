'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFunnel, runRetention } = require('../src/funnel');

const T = (iso) => Date.parse(iso);

function funnelEvents() {
  return [
    // u1 completes all three steps inside the window
    { event: 'page_view', distinct_id: 'u1', timestamp: T('2026-11-23T10:00:00Z'), properties: {} },
    { event: 'sign_up', distinct_id: 'u1', timestamp: T('2026-11-23T10:05:00Z'), properties: {} },
    { event: 'purchase', distinct_id: 'u1', timestamp: T('2026-11-23T10:30:00Z'), properties: {} },
    // u2 drops off after sign_up
    { event: 'page_view', distinct_id: 'u2', timestamp: T('2026-11-23T11:00:00Z'), properties: {} },
    { event: 'sign_up', distinct_id: 'u2', timestamp: T('2026-11-23T11:10:00Z'), properties: {} },
    // u3 only views
    { event: 'page_view', distinct_id: 'u3', timestamp: T('2026-11-23T12:00:00Z'), properties: {} },
    // u4 does purchase BEFORE sign_up: out of order, must not count past step 1
    { event: 'page_view', distinct_id: 'u4', timestamp: T('2026-11-23T13:00:00Z'), properties: {} },
    { event: 'purchase', distinct_id: 'u4', timestamp: T('2026-11-23T13:05:00Z'), properties: {} },
    // u5 finishes step 3 after the 1h window: counted at steps 1-2 only
    { event: 'page_view', distinct_id: 'u5', timestamp: T('2026-11-23T14:00:00Z'), properties: {} },
    { event: 'sign_up', distinct_id: 'u5', timestamp: T('2026-11-23T14:05:00Z'), properties: {} },
    { event: 'purchase', distinct_id: 'u5', timestamp: T('2026-11-23T16:00:00Z'), properties: {} },
  ];
}

test('funnel counts per-user ordered progression inside the window', () => {
  const result = runFunnel(funnelEvents(), {
    steps: ['page_view', 'sign_up', 'purchase'],
    window_hours: 1,
  });
  assert.equal(result.total_users, 5);
  assert.deepEqual(result.reached, [5, 3, 1]);
  assert.deepEqual(result.conversion_from_start, [100, 60, 20]);
  assert.deepEqual(result.conversion_step, [100, 60, 33.3]);
});

test('funnel with a wide window counts the late purchase', () => {
  const result = runFunnel(funnelEvents(), {
    steps: ['page_view', 'sign_up', 'purchase'],
    window_hours: 24,
  });
  assert.deepEqual(result.reached, [5, 3, 2]);
});

test('funnel validates steps and window', () => {
  assert.throws(() => runFunnel([], { steps: ['only_one'] }), /invalid steps/);
  assert.throws(() => runFunnel([], { steps: ['a', 'b'], window_hours: 0 }), /invalid window_hours/);
  assert.throws(() => runFunnel([], { steps: ['a', 'b'], window_hours: 721 }), /invalid window_hours/);
});

test('funnel on empty input reports zero users', () => {
  const result = runFunnel([], { steps: ['a', 'b'] });
  assert.equal(result.total_users, 0);
  assert.deepEqual(result.reached, [0, 0]);
  assert.deepEqual(result.conversion_from_start, [0, 0]);
});

function retentionEvents() {
  // Week of Mon 2026-11-16: u1, u2 sign up; u1 active again in week 2, u2 not.
  // Week of Mon 2026-11-23: u3 signs up and is active that same week only.
  return [
    { event: 'sign_up', distinct_id: 'u1', timestamp: T('2026-11-17T10:00:00Z'), properties: {} },
    { event: 'sign_up', distinct_id: 'u2', timestamp: T('2026-11-18T10:00:00Z'), properties: {} },
    { event: 'page_view', distinct_id: 'u1', timestamp: T('2026-11-24T10:00:00Z'), properties: {} },
    { event: 'sign_up', distinct_id: 'u3', timestamp: T('2026-11-24T10:00:00Z'), properties: {} },
    { event: 'page_view', distinct_id: 'u3', timestamp: T('2026-11-24T11:00:00Z'), properties: {} },
  ];
}

test('retention cohorts group by first-seen week and track return activity', () => {
  const result = runRetention(retentionEvents(), { event: 'sign_up', weeks: 2 });
  assert.equal(result.cohorts.length, 2);
  assert.equal(result.cohorts[0].cohort, '2026-11-16');
  assert.equal(result.cohorts[0].size, 2);
  assert.deepEqual(result.cohorts[0].retention, [100, 50]); // u1 returns, u2 does not
  assert.equal(result.cohorts[1].cohort, '2026-11-23');
  assert.equal(result.cohorts[1].size, 1);
  assert.deepEqual(result.cohorts[1].retention, [100, 0]);
});

test('retention requires an event and validates weeks', () => {
  assert.throws(() => runRetention([], {}), /invalid event/);
  assert.throws(() => runRetention([], { event: 'sign_up', weeks: 0 }), /invalid weeks/);
  assert.throws(() => runRetention([], { event: 'sign_up', weeks: 13 }), /invalid weeks/);
});

test('retention on empty input returns no cohorts', () => {
  assert.deepEqual(runRetention([], { event: 'sign_up' }).cohorts, []);
});
