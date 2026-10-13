import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sendAlert } from '../src/cli.mjs';
import { loadConfig, configIdentity } from '../src/config.mjs';
import { connectionHome, loadConnection } from '../src/connection.mjs';
import { checkHealth, MAX_PENDING, runOnce } from '../src/monitor.mjs';

async function fixture(t, threshold = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'uptime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { name: 'Test service', threshold, timeoutMs: 100, stateFile: join(directory, 'state.json') };
  const events = [];
  const send = async (event) => events.push(event);
  const tick = (healthy, overrides = {}) => runOnce({ config, identity: 'test-config', check: async () => healthy, send, ...overrides });
  const state = async () => JSON.parse(await readFile(config.stateFile, 'utf8'));
  return { config, events, send, tick, state };
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('initial healthy baseline and transient failures stay quiet', async (t) => {
  const f = await fixture(t);
  for (const healthy of [true, false, false, true, false, true]) await f.tick(healthy);
  assert.equal(f.events.length, 0);
  assert.equal((await f.state()).failures, 0);
  assert.equal((await f.state()).status, 'up');
});

test('sustained outage sends once, restart preserves it, and recovery sends once', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) await f.tick(false);
  assert.deepEqual(f.events.map((e) => e.kind), ['down']);
  // A fresh runOnce call reads disk state; there is no in-memory status cache.
  await runOnce({ config: f.config, identity: 'test-config', check: async () => false, send: f.send });
  await f.tick(true);
  await f.tick(true);
  assert.deepEqual(f.events.map((e) => e.kind), ['down', 'recovery']);
});

test('a failed send stays queued; later recovery is delivered in observation order', async (t) => {
  const f = await fixture(t, 1);
  const when = new Date('2026-10-13T10:00:00.000Z');
  await assert.rejects(f.tick(false, { now: () => when, send: async () => { throw new Error('offline'); } }), /offline/);
  const queued = (await f.state()).pending[0];
  assert.equal(queued.at, when.toISOString());
  await f.tick(true);
  assert.deepEqual(f.events.map((e) => e.kind), ['down', 'recovery']);
  assert.equal(f.events[0].id, queued.id);
  assert.equal(f.events[0].at, queued.at);
  assert.deepEqual((await f.state()).pending, []);
});

test('failed send retries without creating another outage transition', async (t) => {
  const f = await fixture(t, 1);
  await assert.rejects(f.tick(false, { send: async () => { throw new Error('offline'); } }));
  await f.tick(false);
  await f.tick(false);
  assert.deepEqual(f.events.map((e) => e.kind), ['down']);
});

test('changed configuration blocks until explicit reset, which sends nothing', async (t) => {
  const f = await fixture(t, 1);
  await assert.rejects(f.tick(false, { send: async () => { throw new Error('offline'); } }));
  await assert.rejects(f.tick(true, { identity: 'new-config' }), /configuration changed/);
  assert.equal((await f.state()).pending.length, 1);
  const reset = await f.tick(true, { identity: 'new-config', reset: true,
    check: async () => assert.fail('reset must not check HTTP'), send: async () => assert.fail('reset must not send') });
  assert.equal(reset.reset, true);
  assert.deepEqual((await f.state()).pending, []);
  assert.equal((await f.state()).status, 'unknown');
});

test('concurrent checks never overlap under one state lock', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const active = f.tick(true, { check: async () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
  await started;
  assert.deepEqual(await f.tick(false, { check: async () => assert.fail('overlapping check') }), { skipped: true });
  release(true);
  await active;
  assert.equal((await f.tick(true)).skipped, undefined);
});

test('a full alert queue pauses new checks, preserves alerts, and resumes after delivery', async (t) => {
  const f = await fixture(t, 1);
  await f.tick(true);
  const state = await f.state();
  state.pending = Array.from({ length: MAX_PENDING }, (_, i) => ({
    id: randomUUID(), kind: i % 2 ? 'recovery' : 'down', at: '2026-10-13T10:00:00.000Z',
  }));
  await writeFile(f.config.stateFile, JSON.stringify(state));
  await assert.rejects(f.tick(true, { check: async () => assert.fail('queue is full'), send: async () => { throw new Error('offline'); } }), /queue is full/);
  assert.equal((await f.state()).pending.length, MAX_PENDING);
  await f.tick(true);
  assert.equal(f.events.length, MAX_PENDING);
  assert.equal((await f.state()).pending.length, 0);
});

test('corrupt state is preserved and blocks monitoring', async (t) => {
  const f = await fixture(t);
  await writeFile(f.config.stateFile, '{broken');
  await assert.rejects(f.tick(true), /State could not be read/);
  assert.equal(await readFile(f.config.stateFile, 'utf8'), '{broken');
  assert.equal(f.events.length, 0);
});

test('HTTP health check accepts only 2xx, rejects redirects, and times out', { timeout: 10000 }, async (t) => {
  let redirectTargetHits = 0;
  const url = await serverFor(t, (req, res) => {
    if (req.url === '/ok') { res.writeHead(204); return res.end(); }
    if (req.url === '/fail') { res.writeHead(503); return res.end('sensitive body'); }
    if (req.url === '/redirect') { res.writeHead(302, { Location: `${url}/target` }); return res.end(); }
    if (req.url === '/target') { redirectTargetHits++; return res.end('secret'); }
    // /hang deliberately never responds.
  });
  // Cold fetch initialization can exceed 100 ms on a shared CI runner. Only
  // the deliberately unresponsive route should use the short request deadline.
  const check = (path, timeoutMs = 5000) => checkHealth({ endpoint: `${url}${path}`, timeoutMs });
  assert.equal(await check('/ok'), true);
  assert.equal(await check('/fail'), false);
  assert.equal(await check('/redirect'), false);
  const started = performance.now();
  assert.equal(await check('/hang', 100), false);
  assert.ok(performance.now() - started >= 80, 'the unresponsive request must wait for its deadline');
  assert.equal(redirectTargetHits, 0);
});

test('aborting a health check does not record a false failure', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const url = await serverFor(t, () => controller.abort());
  await assert.rejects(f.tick(false, { config: { ...f.config, endpoint: url, timeoutMs: 1000 }, check: checkHealth, signal: controller.signal }));
  await assert.rejects(readFile(f.config.stateFile), { code: 'ENOENT' });
});

test('the real pinned CLI sends timestamped alerts without endpoint or response body', async (t) => {
  const received = [];
  const apiUrl = await serverFor(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, token: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, id: 'test-notification' }));
  });
  const event = { id: randomUUID(), kind: 'down', at: '2026-10-13T10:00:00.000Z' };
  await sendAlert(event, { name: 'API', threshold: 3, endpoint: 'https://secret.example/?token=never-send' },
    { apiUrl, room: 'TESTROOM', token: 'mock-token' });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/api/agent/rooms/TESTROOM/notifications');
  assert.equal(received[0].token, 'Bearer mock-token');
  assert.equal(received[0].body.message, 'API: DOWN at 2026-10-13T10:00:00.000Z (3 failed checks).');
  assert.equal(received[0].body.data.event_id, event.id);
  assert.doesNotMatch(JSON.stringify(received), /never-send|sensitive body/);
});

test('real CLI delivery errors keep the persistent alert queued', async (t) => {
  const f = await fixture(t, 1);
  const apiUrl = await serverFor(t, (_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"message":"denied"}');
  });
  await assert.rejects(f.tick(false, { send: (event) => sendAlert(event, f.config, { apiUrl, room: 'TESTROOM', token: 'mock-token' }) }), /delivery failed/);
  assert.equal((await f.state()).pending.length, 1);
});

test('config identity catches target and policy changes but allows polling interval changes', () => {
  const base = loadConfig({ HEALTH_URL: 'https://example.test/health' });
  const connection = { room: 'TESTROOM', token: 'mock-token' };
  const identity = configIdentity(base, connection);
  for (const changed of [{ endpoint: 'https://other.test/' }, { name: 'Other' }, { threshold: 4 }, { timeoutMs: 2000 }]) {
    assert.notEqual(configIdentity({ ...base, ...changed }, connection), identity);
  }
  assert.notEqual(configIdentity(base, { ...connection, token: 'new-token' }), identity);
  assert.notEqual(configIdentity(base, { ...connection, room: 'OTHER' }), identity);
  assert.equal(configIdentity({ ...base, intervalMs: 2000 }, connection), identity);
  assert.throws(() => loadConfig({ HEALTH_URL: 'https://user:secret@example.test' }), /username/);
  assert.throws(() => loadConfig({ HEALTH_URL: 'https://example.test', FAILURE_THRESHOLD: '0' }), /FAILURE_THRESHOLD/);
});

test('environment credentials never blend with saved connection and pairing is starter-local', async () => {
  await assert.rejects(loadConnection({ PINGROOM_TOKEN: 'token', PINGROOM_HOME: '/never-read' }), /both/);
  await assert.rejects(loadConnection({ PINGROOM_ROOM: 'ROOM', PINGROOM_HOME: '/never-read' }), /both/);
  assert.equal(connectionHome({}), fileURLToPath(new URL('../.pingroom', import.meta.url)));
  assert.equal(connectionHome({ PINGROOM_HOME: '/explicit' }), '/explicit');
});
