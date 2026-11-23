'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventStore } = require('../src/store');
const { createServer } = require('../src/server');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const API_KEY = 'cli-test-key';

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 10000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

function setupServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore(dir).load();
  const server = createServer({ store, apiKey: API_KEY });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ store, port });
    });
  });
}

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /eventlens serve/);
  assert.match(stdout, /eventlens funnel/);
});

test('unknown command exits non-zero with an error', async () => {
  const { code, stderr } = await runCli(['explode']);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown command/);
});

test('send + events round-trip against a live server', async (t) => {
  const { store, port } = await setupServer(t);
  const env = { EVENTLENS_URL: `http://127.0.0.1:${port}`, EVENTLENS_API_KEY: API_KEY };
  const sent = await runCli(['send', '--event', 'page_view', '--id', 'u1', '--prop', 'plan=pro', '--prop', 'n=3'], env);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /accepted 1 event/);
  assert.equal(store.count(), 1);
  assert.equal(store.events[0].properties.plan, 'pro');
  assert.equal(store.events[0].properties.n, 3);

  const listed = await runCli(['events'], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /total events: 1/);
  assert.match(listed.stdout, /page_view/);
});

test('query timeseries works through the CLI', async (t) => {
  const { port } = await setupServer(t);
  const env = { EVENTLENS_URL: `http://127.0.0.1:${port}`, EVENTLENS_API_KEY: API_KEY };
  await runCli(['send', '--event', 'page_view', '--id', 'u1', '--time', '2026-11-23T10:00:00.000Z'], env);
  const result = await runCli(['query', 'timeseries', '--event', 'page_view', '--interval', 'day'], env);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.buckets[0].count, 1);
});

test('send with a bad key fails', async (t) => {
  const { port } = await setupServer(t);
  const env = { EVENTLENS_URL: `http://127.0.0.1:${port}`, EVENTLENS_API_KEY: 'wrong-key' };
  const result = await runCli(['send', '--event', 'page_view', '--id', 'u1'], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /API key/);
});
