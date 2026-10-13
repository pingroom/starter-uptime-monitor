import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function integer(env, name, fallback, min, max) {
  const raw = env[name] || String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(raw);
}

export function loadConfig(env = process.env) {
  let endpoint;
  try { endpoint = new URL(env.HEALTH_URL); } catch { throw new Error('Set HEALTH_URL to an absolute HTTP or HTTPS health endpoint.'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('HEALTH_URL must use HTTP(S), without embedded username/password or a fragment.');
  }
  const name = (env.SERVICE_NAME || 'Service').trim();
  if (!name || [...name].length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('SERVICE_NAME must contain 1–40 visible characters.');
  return {
    endpoint: endpoint.href, name,
    threshold: integer(env, 'FAILURE_THRESHOLD', 3, 1, 100),
    timeoutMs: integer(env, 'CHECK_TIMEOUT_MS', 5000, 100, 120000),
    intervalMs: integer(env, 'POLL_INTERVAL_MS', 60000, 1000, 86400000),
    stateFile: env.STATE_FILE ? resolve(env.STATE_FILE) : fileURLToPath(new URL('../.monitor/state.json', import.meta.url)),
  };
}

export function configIdentity(config, connection) {
  // Persist only the digest; URLs, query strings and bearer tokens stay out of state.
  return createHash('sha256').update(JSON.stringify({
    endpoint: config.endpoint, name: config.name, threshold: config.threshold,
    timeoutMs: config.timeoutMs, room: connection.room, token: connection.token,
  })).digest('hex');
}
