'use strict';

/**
 * Aggregation queries over stored events. Pure functions over an event
 * array — no I/O, so they are unit-testable without a running server and
 * reusable from both the HTTP routes and the CLI.
 *
 * Three query kinds:
 * - timeseries: counts (and unique users) per hour/day bucket.
 * - breakdown: counts grouped by one property's value.
 * - top: the N most frequent values of one property.
 *
 * Design decisions:
 * - Buckets align to UTC interval boundaries (floor to the hour/day), so
 *   two queries over the same range always produce comparable series.
 * - A missing `from`/`to` defaults to the range of the matching events,
 *   so a query without dates still returns a useful series instead of
 *   erroring out.
 * - `value` filters on one property equality, letting callers ask e.g.
 *   "page_view where plan=pro over time" without a second query type.
 */

const INTERVALS = { hour: 3600 * 1000, day: 24 * 3600 * 1000 };
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function parseTime(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid ${name}: not a date or epoch milliseconds`);
  return ms;
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new Error(`invalid limit: must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

/** Parse URLSearchParams from a query route into a params object. */
function parseQueryParams(searchParams) {
  const params = {
    event: searchParams.get('event') || undefined,
    from: parseTime(searchParams.get('from'), 'from'),
    to: parseTime(searchParams.get('to'), 'to'),
    interval: searchParams.get('interval') || 'day',
    property: searchParams.get('property') || undefined,
    value: searchParams.get('value') || undefined,
    limit: parseLimit(searchParams.get('limit')),
  };
  if (params.interval && !INTERVALS[params.interval]) {
    throw new Error('invalid interval: must be "hour" or "day"');
  }
  if (params.from !== undefined && params.to !== undefined && params.from > params.to) {
    throw new Error('invalid range: from must not be after to');
  }
  return params;
}

function filterEvents(events, params) {
  return events.filter((e) => {
    if (params.event && e.event !== params.event) return false;
    if (params.from !== undefined && e.timestamp < params.from) return false;
    if (params.to !== undefined && e.timestamp > params.to) return false;
    if (params.property && params.value !== undefined
      && String(e.properties[params.property] ?? '') !== params.value) return false;
    return true;
  });
}

function timeseries(events, params) {
  const filtered = filterEvents(events, params);
  const bucketMs = INTERVALS[params.interval || 'day'];
  if (filtered.length === 0) return { event: params.event, interval: params.interval || 'day', buckets: [] };

  const from = params.from !== undefined ? params.from : Math.min(...filtered.map((e) => e.timestamp));
  const to = params.to !== undefined ? params.to : Math.max(...filtered.map((e) => e.timestamp));
  const firstBucket = Math.floor(from / bucketMs) * bucketMs;
  const lastBucket = Math.floor(to / bucketMs) * bucketMs;

  const buckets = new Map();
  for (let start = firstBucket; start <= lastBucket; start += bucketMs) {
    buckets.set(start, { bucket: new Date(start).toISOString(), count: 0, uniques: new Set() });
  }
  for (const e of filtered) {
    const start = Math.floor(e.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(start);
    if (!bucket) continue; // event outside an explicit from/to range edge
    bucket.count += 1;
    bucket.uniques.add(e.distinct_id);
  }
  return {
    event: params.event,
    interval: params.interval || 'day',
    buckets: [...buckets.values()].map((b) => ({ bucket: b.bucket, count: b.count, uniques: b.uniques.size })),
  };
}

function groupByProperty(events, params) {
  if (!params.property) throw new Error('invalid property: breakdown and top queries require a property');
  const filtered = filterEvents(events, params);
  const groups = new Map();
  for (const e of filtered) {
    const key = e.properties[params.property];
    const label = key === undefined ? '(missing)' : String(key);
    const group = groups.get(label) || { value: label, count: 0, uniques: new Set() };
    group.count += 1;
    group.uniques.add(e.distinct_id);
    groups.set(label, group);
  }
  return [...groups.values()]
    .map((g) => ({ value: g.value, count: g.count, uniques: g.uniques.size }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

function breakdown(events, params) {
  return {
    event: params.event,
    property: params.property,
    groups: groupByProperty(events, params).slice(0, params.limit || DEFAULT_LIMIT),
  };
}

function top(events, params) {
  return {
    event: params.event,
    property: params.property,
    values: groupByProperty(events, params).slice(0, params.limit || DEFAULT_LIMIT),
  };
}

/** Dispatch a query by kind. Throws Error('invalid ...') on bad params. */
function runQuery(events, params) {
  if (!params.event) throw new Error('invalid event: a query requires an event name');
  switch (params.kind) {
    case 'timeseries': return timeseries(events, params);
    case 'breakdown': return breakdown(events, params);
    case 'top': return top(events, params);
    default: throw new Error(`invalid kind: unknown query kind "${params.kind}"`);
  }
}

module.exports = { parseQueryParams, parseTime, parseLimit, filterEvents, timeseries, breakdown, top, runQuery };
