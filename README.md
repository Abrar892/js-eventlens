# EventLens

A tiny, zero-dependency product analytics server in Node.js. Send it events
over HTTP, then ask it questions: how many page views per day, which plan
converts best, where users drop off in the signup funnel, and whether last
month's cohort came back.

No database, no dependencies, no build step. Events live in one append-only
JSONL file; everything else is plain `node:http` and `node:test`.

## Quick start

```bash
# Start the server (data lands in ./data/events.jsonl)
node src/cli.js serve --port 3000

# Send an event
node src/cli.js send --event page_view --id user-42 --prop plan=pro

# Or with curl
curl -X POST localhost:3000/api/events \
  -H "Authorization: Bearer dev-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"event":"page_view","distinct_id":"user-42","properties":{"plan":"pro"}}'

# Daily counts for an event
node src/cli.js query timeseries --event page_view --interval day

# Where do users drop off between viewing, signing up and paying?
node src/cli.js funnel --steps page_view,sign_up,purchase --window 24

# Did the cohort that signed up come back?
node src/cli.js retention --event sign_up --weeks 4
```

Open http://localhost:3000 in a browser for a minimal dashboard (enter the
API key, pick an event, see daily counts and a property breakdown).

## What it can answer

| Question | How |
| --- | --- |
| How many events per hour / day? | `query timeseries --event <name> --interval hour\|day` |
| Which value of a property is most common? | `query top --event <name> --property <name>` |
| How does a property split the traffic? | `query breakdown --event <name> --property <name>` |
| How far do users get through steps A → B → C? | `funnel --steps a,b,c [--window <hours>]` |
| Do users return in later weeks? | `retention --event <name> [--weeks <n>]` |

All queries accept `--from` / `--to` date filters. The HTTP API mirrors the
CLI one-to-one: `GET /api/query/timeseries`, `GET /api/query/breakdown`,
`GET /api/query/top`, `POST /api/funnel`, `GET /api/retention`,
`GET /api/events`, `GET /health`.

## Design decisions

- **Append-only JSONL store.** One event per line, written in a single
  append per batch. A torn final line (crash mid-write) is skipped on load
  and counted in `/health` instead of killing the server. The whole store
  is kept in memory, so queries are plain array scans — fast enough for
  the volumes a local collector sees, and free of index-maintenance code.
- **Validation at the boundary.** Events are validated and normalised on
  ingest (name pattern, flat scalar properties, timestamps as epoch ms), so
  the store and every query can trust the shape of what they read. A batch
  is all-or-nothing: one bad event rejects the whole batch, never leaves a
  half-ingested one behind.
- **Funnels count users, not events.** A user who views a page ten times
  counts once at that step. Steps must happen in order, each after the
  previous one, and all within the window anchored to step 1.
- **Retention cohorts are calendar weeks.** A cohort is the Monday-start
  week of a user's first occurrence of the event; "active" in a later week
  means the user did *any* event that week — the question is whether they
  came back, not whether they repeated the exact action.
- **One shared API key.** Reads and writes use the same bearer key
  (`EVENTLENS_API_KEY`, default `dev-key-change-me`). This is a
  single-tenant local collector, not multi-tenant SaaS, so one key keeps
  the auth surface honest instead of pretending at per-user permissions.

## Project layout

```
src/
  event.js       event validation + normalisation
  store.js       append-only JSONL store
  query.js       timeseries / breakdown / top-N aggregation
  funnel.js      funnel analysis + retention cohorts
  server.js      HTTP server (ingest, queries, auth)
  cli.js         CLI client (serve, send, query, funnel, retention)
  dashboard.html minimal browser dashboard
tests/           node:test suites (unit + HTTP + CLI integration)
```

## Running tests

```bash
npm test
```

42 tests: event validation, store round-trips and corrupt-line handling,
aggregation math, funnel ordering/window edge cases, retention cohorts,
HTTP auth and ingest, and CLI end-to-end against a live server.

## Configuration

| Setting | Env / flag | Default |
| --- | --- | --- |
| API key | `EVENTLENS_API_KEY` / `--key` | `dev-key-change-me` |
| Server URL (CLI) | `EVENTLENS_URL` / `--url` | `http://localhost:3000` |
| Data directory | `--data` on `serve` | `./data` |
| Port | `--port` on `serve` | `3000` |

## Limits

- Batches are capped at 1000 events and 1 MB per request.
- Events are capped at 50 flat scalar properties and 64 KB serialised.
- The in-memory store suits thousands to low hundreds of thousands of
  events; it is not a replacement for a real analytics warehouse.

## License

MIT — see [LICENSE](LICENSE).
