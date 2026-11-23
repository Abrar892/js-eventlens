'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeEvent, parseStoredLine } = require('./event');

/**
 * Append-only JSONL event store.
 *
 * Design decisions:
 * - One JSONL file (`events.jsonl`), one event per line. Append-only writes
 *   are crash-safe enough for a tiny analytics server: a torn final line is
 *   skipped on load and counted, never fatal.
 * - The store keeps an in-memory copy of every event. For the volumes this
 *   tool targets (thousands to low hundreds of thousands of events) a full
 *   scan is fast, and it keeps the query code free of index-maintenance
 *   complexity. `load()` rebuilds the in-memory copy from disk on startup.
 * - Appends are synchronous. Ingest is a single append per batch, so the
 *   synchronous write keeps ordering exact and the code simple; throughput
 *   is still far above what a local analytics collector needs.
 */
class EventStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'events.jsonl');
    this.events = [];
    this.corruptLines = 0;
  }

  /** Load (or reload) all events from disk into memory. */
  load() {
    this.events = [];
    this.corruptLines = 0;
    if (!fs.existsSync(this.filePath)) return this;
    const content = fs.readFileSync(this.filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const event = parseStoredLine(line);
      if (event) this.events.push(event);
      else this.corruptLines += 1;
    }
    return this;
  }

  /** Validate, normalise and append events. Returns the stored events. */
  append(rawEvents) {
    const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    const stored = list.map((raw) => normalizeEvent(raw));
    fs.mkdirSync(this.dataDir, { recursive: true });
    const payload = stored.map((event) => JSON.stringify(event)).join('\n') + '\n';
    fs.appendFileSync(this.filePath, payload, 'utf8');
    this.events.push(...stored);
    return stored;
  }

  count() {
    return this.events.length;
  }

  /** All distinct event names, sorted. */
  eventNames() {
    return [...new Set(this.events.map((e) => e.event))].sort();
  }

  /** All events matching a predicate, in ingest order. */
  query(predicate) {
    return this.events.filter(predicate);
  }
}

module.exports = { EventStore };
