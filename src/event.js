'use strict';

/**
 * Event model: validation and normalisation for a single analytics event.
 *
 * An event is a plain object:
 *   { event: "page_view", distinct_id: "user-42",
 *     timestamp: "2026-11-23T10:00:00.000Z", properties: { plan: "pro" } }
 *
 * Design decisions:
 * - Validation happens at the boundary (ingest) so the store and every
 *   query can trust the shape of what it reads back.
 * - Timestamps are normalised to epoch milliseconds on ingest, which makes
 *   bucketing and window math integer arithmetic instead of date parsing.
 * - Properties are restricted to JSON scalars. Nested objects and arrays
 *   are rejected: analytics properties should be flat dimensions, and
 *   rejecting nesting keeps aggregation code (and the on-disk format) simple.
 */

const MAX_EVENT_NAME_LENGTH = 128;
const MAX_DISTINCT_ID_LENGTH = 256;
const MAX_PROPERTIES = 50;
const MAX_PROPERTY_KEY_LENGTH = 64;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const EVENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Validate a raw event. Returns an array of error strings; empty means valid.
 * Does not mutate the input.
 */
function validateEvent(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return ['event must be a JSON object'];

  if (typeof raw.event !== 'string' || raw.event.length === 0) {
    errors.push('event name must be a non-empty string');
  } else if (raw.event.length > MAX_EVENT_NAME_LENGTH) {
    errors.push(`event name must be at most ${MAX_EVENT_NAME_LENGTH} characters`);
  } else if (!EVENT_NAME_PATTERN.test(raw.event)) {
    errors.push('event name must start with a letter or digit and contain only letters, digits, ".", "_" or "-"');
  }

  if (typeof raw.distinct_id !== 'string' || raw.distinct_id.length === 0) {
    errors.push('distinct_id must be a non-empty string');
  } else if (raw.distinct_id.length > MAX_DISTINCT_ID_LENGTH) {
    errors.push(`distinct_id must be at most ${MAX_DISTINCT_ID_LENGTH} characters`);
  }

  if (raw.timestamp !== undefined && raw.timestamp !== null) {
    const ms = Date.parse(raw.timestamp);
    if (Number.isNaN(ms)) errors.push('timestamp must be an ISO 8601 date string');
    else if (ms > Date.now() + 5 * 60 * 1000) errors.push('timestamp must not be more than 5 minutes in the future');
  }

  if (raw.properties !== undefined && raw.properties !== null) {
    if (!isPlainObject(raw.properties)) {
      errors.push('properties must be a JSON object');
    } else {
      const keys = Object.keys(raw.properties);
      if (keys.length > MAX_PROPERTIES) {
        errors.push(`at most ${MAX_PROPERTIES} properties allowed`);
      }
      for (const key of keys) {
        if (key.length === 0 || key.length > MAX_PROPERTY_KEY_LENGTH) {
          errors.push(`property key "${key}" must be 1-${MAX_PROPERTY_KEY_LENGTH} characters`);
        }
        const value = raw.properties[key];
        if (!isScalar(value)) {
          errors.push(`property "${key}" must be a string, number, boolean or null`);
        } else if (typeof value === 'number' && !Number.isFinite(value)) {
          errors.push(`property "${key}" must be a finite number`);
        } else if (typeof value === 'string' && value.length > 1024) {
          errors.push(`property "${key}" must be at most 1024 characters`);
        }
      }
    }
  }

  if (errors.length === 0) {
    const size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    if (size > MAX_SERIALIZED_BYTES) {
      errors.push(`event must be at most ${MAX_SERIALIZED_BYTES} bytes when serialised`);
    }
  }
  return errors;
}

/**
 * Normalise a validated event into its canonical stored form.
 * Throws on invalid input — call validateEvent first when unsure.
 */
function normalizeEvent(raw) {
  const errors = validateEvent(raw);
  if (errors.length > 0) throw new Error(`invalid event: ${errors.join('; ')}`);
  return {
    event: raw.event,
    distinct_id: raw.distinct_id,
    timestamp: raw.timestamp ? Date.parse(raw.timestamp) : Date.now(),
    properties: raw.properties ? { ...raw.properties } : {},
  };
}

/** Parse one stored JSONL line back into a canonical event, or null if corrupt. */
function parseStoredLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (!isPlainObject(parsed)) return null;
    if (typeof parsed.event !== 'string' || typeof parsed.distinct_id !== 'string') return null;
    if (typeof parsed.timestamp !== 'number' || !Number.isFinite(parsed.timestamp)) return null;
    if (!isPlainObject(parsed.properties)) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = { validateEvent, normalizeEvent, parseStoredLine, isPlainObject };
