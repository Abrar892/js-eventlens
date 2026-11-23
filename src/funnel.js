'use strict';

const { parseTime } = require('./query');

/**
 * Funnel analysis and retention cohorts. Pure functions over an event array.
 *
 * Funnel design decisions:
 * - Conversion is counted per user (distinct_id), not per event: a user who
 *   views a page ten times still counts once at that step.
 * - Steps must happen in order, each after the previous one, and every step
 *   must fall within `window_hours` of the user's first step. The window is
 *   anchored to step 1 (not to the previous step) so a funnel means "did the
 *   whole journey inside one session-length window".
 * - Only the first occurrence of step 1 inside the range starts a user's
 *   funnel attempt; re-entries are ignored.
 *
 * Retention design decisions:
 * - A cohort is the calendar week (Monday start, UTC) of a user's first
 *   occurrence of the given event. Retention in week N means the user did
 *   ANY event in that week, not just the cohort event — the question is
 *   "did they come back", not "did they repeat this exact action".
 * - Retention is a percentage of the cohort size, rounded to one decimal.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;

function weekStartMs(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay(); // 0 = Sunday
  const offsetDays = (day + 6) % 7; // days since Monday
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - offsetDays * 24 * 3600 * 1000;
  return monday;
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 10) {
    throw new Error('invalid steps: funnel requires 2-10 event names');
  }
  for (const step of steps) {
    if (typeof step !== 'string' || step.length === 0) {
      throw new Error('invalid steps: every step must be a non-empty event name');
    }
  }
}

function runFunnel(events, params) {
  validateSteps(params.steps);
  const from = params.from !== undefined ? parseTime(String(params.from), 'from') : undefined;
  const to = params.to !== undefined ? parseTime(String(params.to), 'to') : undefined;
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error('invalid range: from must not be after to');
  }
  const windowHours = params.window_hours === undefined ? 24 : Number(params.window_hours);
  if (!Number.isFinite(windowHours) || windowHours < 1 || windowHours > 720) {
    throw new Error('invalid window_hours: must be between 1 and 720');
  }
  const windowMs = windowHours * 3600 * 1000;

  const byUser = new Map();
  for (const e of events) {
    if (from !== undefined && e.timestamp < from) continue;
    if (to !== undefined && e.timestamp > to) continue;
    if (!byUser.has(e.distinct_id)) byUser.set(e.distinct_id, []);
    byUser.get(e.distinct_id).push(e);
  }

  const reached = params.steps.map(() => 0);
  for (const userEvents of byUser.values()) {
    userEvents.sort((a, b) => a.timestamp - b.timestamp);
    let cursor = -Infinity; // timestamp the next step must follow
    let anchor = null; // timestamp of step 1
    for (let i = 0; i < params.steps.length; i++) {
      const stepEvent = userEvents.find((e) => e.event === params.steps[i] && e.timestamp > cursor);
      if (!stepEvent) break;
      if (i === 0) anchor = stepEvent.timestamp;
      else if (stepEvent.timestamp - anchor > windowMs) break;
      reached[i] += 1;
      cursor = stepEvent.timestamp;
    }
  }

  const total = reached[0];
  return {
    steps: params.steps,
    window_hours: windowHours,
    total_users: total,
    reached,
    conversion_from_start: reached.map((count) => (total === 0 ? 0 : Math.round((count / total) * 1000) / 10)),
    conversion_step: reached.map((count, i) => {
      if (i === 0) return 100;
      const prev = reached[i - 1];
      return prev === 0 ? 0 : Math.round((count / prev) * 1000) / 10;
    }),
  };
}

function runRetention(events, params) {
  if (!params.event) throw new Error('invalid event: retention requires an event name');
  const weeks = params.weeks === undefined ? 4 : Number(params.weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) {
    throw new Error('invalid weeks: must be an integer between 1 and 12');
  }

  const firstSeen = new Map(); // distinct_id -> first timestamp of the cohort event
  const activityByUser = new Map(); // distinct_id -> sorted timestamps of any event
  for (const e of events) {
    if (!activityByUser.has(e.distinct_id)) activityByUser.set(e.distinct_id, []);
    activityByUser.get(e.distinct_id).push(e.timestamp);
    if (e.event === params.event) {
      const prev = firstSeen.get(e.distinct_id);
      if (prev === undefined || e.timestamp < prev) firstSeen.set(e.distinct_id, e.timestamp);
    }
  }

  const cohorts = new Map(); // weekStart -> Set of users
  for (const [user, ts] of firstSeen) {
    const start = weekStartMs(ts);
    if (!cohorts.has(start)) cohorts.set(start, new Set());
    cohorts.get(start).add(user);
  }

  const result = [...cohorts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, users]) => {
      const retention = [];
      for (let w = 0; w < weeks; w++) {
        const weekStart = start + w * WEEK_MS;
        const weekEnd = weekStart + WEEK_MS;
        let active = 0;
        for (const user of users) {
          const stamps = activityByUser.get(user) || [];
          if (stamps.some((ts) => ts >= weekStart && ts < weekEnd)) active += 1;
        }
        retention.push(Math.round((active / users.size) * 1000) / 10);
      }
      return {
        cohort: new Date(start).toISOString().slice(0, 10),
        size: users.size,
        retention,
      };
    });

  return { event: params.event, weeks, cohorts: result };
}

module.exports = { runFunnel, runRetention, weekStartMs };
