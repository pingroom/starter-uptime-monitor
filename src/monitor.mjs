import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MAX_PENDING = 100;

export async function checkHealth(config, signal) {
  try {
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const response = await fetch(config.endpoint, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    });
    const healthy = response.status >= 200 && response.status < 300;
    await response.body?.cancel();
    return healthy;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function initialState(identity) {
  return { version: 1, identity, status: 'unknown', failures: 0, pending: [] };
}

async function readState(path, identity) {
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return initialState(identity);
    throw new Error('State could not be read. Restore a backup or explicitly reset state.');
  }
  if (state?.version !== 1 || !['unknown', 'up', 'down'].includes(state.status)
    || !Number.isSafeInteger(state.failures) || state.failures < 0 || !Array.isArray(state.pending)
    || state.pending.length > MAX_PENDING
    || !state.pending.every((event) => typeof event?.id === 'string' && /^[a-f0-9-]{36}$/.test(event.id)
      && ['down', 'recovery'].includes(event.kind) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at))) {
    throw new Error('State is invalid. Restore a backup or explicitly reset state.');
  }
  if (state.identity !== identity) throw new Error('Monitor configuration changed. Use --reset-state to discard previous state and pending alerts, then start again.');
  return state;
}

export async function runOnce({ config, identity, check = checkHealth, send, signal, reset = false, now = () => new Date() }) {
  await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 });
  const lock = `${config.stateFile}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') return { skipped: true };
    throw error;
  }
  try {
    await writeFile(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }), { mode: 0o600 });
    signal?.throwIfAborted();
    if (reset) {
      await atomicWrite(config.stateFile, initialState(identity));
      return { reset: true };
    }
    const state = await readState(config.stateFile, identity);
    let sent = 0;
    const flush = async () => {
      while (state.pending.length) {
        signal?.throwIfAborted();
        await send(state.pending[0], config);
        state.pending.shift();
        await atomicWrite(config.stateFile, state);
        sent++;
      }
    };
    if (state.pending.length === MAX_PENDING) {
      try { await flush(); }
      catch { throw new Error('Alert queue is full (100). Health checks are paused until queued alerts can be delivered; no queued alert was discarded.'); }
    }
    const healthy = await check(config, signal);
    signal?.throwIfAborted();
    const wasDown = state.status === 'down';
    state.failures = healthy ? 0 : Math.min(state.failures + 1, config.threshold);
    if (healthy) state.status = 'up';
    else if (state.failures >= config.threshold) state.status = 'down';
    const kind = !wasDown && state.status === 'down' ? 'down' : wasDown && healthy ? 'recovery' : null;
    if (kind) state.pending.push({ id: randomUUID(), kind, at: now().toISOString() });
    // Save the observed transition before attempting delivery. Pending events
    // remain ordered when the service changes again during a delivery outage.
    await atomicWrite(config.stateFile, state);
    await flush();
    return { healthy, status: state.status, failures: state.failures, sent };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
