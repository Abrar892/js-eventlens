#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./server');

const DEFAULT_URL = process.env.EVENTLENS_URL || 'http://localhost:3000';
const DEFAULT_KEY = process.env.EVENTLENS_API_KEY || 'dev-key-change-me';

const USAGE = `EventLens — tiny product analytics server

Usage:
  eventlens serve [--port 3000] [--data ./data] [--key <api-key>]
  eventlens send --event <name> --id <distinct-id> [--prop k=v ...] [--time <iso>]
  eventlens events
  eventlens query timeseries --event <name> [--interval hour|day] [--from <date>] [--to <date>]
  eventlens query breakdown --event <name> --property <name> [--limit 10]
  eventlens query top --event <name> --property <name> [--limit 10]
  eventlens funnel --steps a,b,c [--window 24] [--from <date>] [--to <date>]
  eventlens retention --event <name> [--weeks 4]

Options:
  --url <base-url>   Server base URL (default: $EVENTLENS_URL or http://localhost:3000)
  --key <api-key>    API key (default: $EVENTLENS_API_KEY or dev-key-change-me)
  --help             Show this help
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (name === 'help') flags.help = true;
      else if (i + 1 < argv.length) {
        const value = argv[++i];
        // Repeated flags accumulate (e.g. --prop k=v --prop k2=v2).
        if (flags[name] === undefined) flags[name] = value;
        else if (Array.isArray(flags[name])) flags[name].push(value);
        else flags[name] = [flags[name], value];
      } else throw new Error(`flag --${name} requires a value`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function apiCall(method, pathname, { body, url, key } = {}) {
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json && json.error ? json.error : `request failed with HTTP ${res.status}`);
  return json;
}

function parseProps(flagValues) {
  const properties = {};
  const values = Array.isArray(flagValues) ? flagValues : [flagValues];
  for (const item of values) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--prop must be key=value, got "${item}"`);
    const key = item.slice(0, eq);
    const raw = item.slice(eq + 1);
    // Keep numbers and booleans typed; everything else stays a string.
    properties[key] = raw === 'true' ? true : raw === 'false' ? false
      : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return properties;
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || positional.length === 0) {
    console.log(USAGE);
    return;
  }

  const url = flags.url || DEFAULT_URL;
  const key = flags.key || DEFAULT_KEY;
  const [command, subcommand] = positional;

  if (command === 'serve') {
    const port = Number(flags.port || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid --port');
    const dataDir = flags.data || path.join(process.cwd(), 'data');
    const apiKey = flags.key || process.env.EVENTLENS_API_KEY || 'dev-key-change-me';
    let dashboardHtml = null;
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
    const { port: actualPort } = await startServer({ dataDir, port, apiKey, dashboardHtml });
    console.log(`EventLens listening on http://localhost:${actualPort} (data: ${dataDir})`);
    if (apiKey === 'dev-key-change-me') {
      console.log('Warning: using the default dev API key — set EVENTLENS_API_KEY in production.');
    }
    return;
  }

  if (command === 'send') {
    if (!flags.event || !flags.id) throw new Error('send requires --event and --id');
    const event = { event: flags.event, distinct_id: flags.id };
    if (flags.time) event.timestamp = flags.time;
    if (flags.prop) event.properties = parseProps(flags.prop);
    const result = await apiCall('POST', '/api/events', { body: event, url, key });
    console.log(`accepted ${result.accepted} event(s)`);
    return;
  }

  if (command === 'events') {
    const result = await apiCall('GET', '/api/events', { url, key });
    console.log(`total events: ${result.total}`);
    for (const name of result.events) console.log(`  ${name}`);
    return;
  }

  if (command === 'query') {
    if (!flags.event) throw new Error('query requires --event');
    const query = new URLSearchParams({ event: flags.event });
    if (flags.interval) query.set('interval', flags.interval);
    if (flags.from) query.set('from', flags.from);
    if (flags.to) query.set('to', flags.to);
    if (flags.property) query.set('property', flags.property);
    if (flags.limit) query.set('limit', flags.limit);
    const result = await apiCall('GET', `/api/query/${subcommand}?${query}`, { url, key });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'funnel') {
    if (!flags.steps) throw new Error('funnel requires --steps a,b,c');
    const body = { steps: flags.steps.split(',').map((s) => s.trim()) };
    if (flags.window) body.window_hours = Number(flags.window);
    if (flags.from) body.from = flags.from;
    if (flags.to) body.to = flags.to;
    const result = await apiCall('POST', '/api/funnel', { body, url, key });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'retention') {
    if (!flags.event) throw new Error('retention requires --event');
    const query = new URLSearchParams({ event: flags.event });
    if (flags.weeks) query.set('weeks', flags.weeks);
    const result = await apiCall('GET', `/api/retention?${query}`, { url, key });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`unknown command "${command}" — run with --help`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
