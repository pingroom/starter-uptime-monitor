import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const cliPath = createRequire(import.meta.url).resolve('@pingroom/cli/bin/pingroom.js');

export async function sendAlert(event, config, connection, { signal } = {}) {
  const message = event.kind === 'down'
    ? `${config.name}: DOWN at ${event.at} (${config.threshold} failed checks).`
    : `${config.name}: RECOVERED at ${event.at}.`;
  const home = await mkdtemp(join(tmpdir(), 'pingroom-uptime-'));
  try {
    await exec(process.execPath, [cliPath, 'ping', '--json', '--title', 'Uptime monitor',
      '--message', message, '--data', JSON.stringify({ event_id: event.id, status: event.kind, observed_at: event.at }),
    ], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true',
        PINGROOM_NO_UPDATE_CHECK: '1', PINGROOM_HOME: home,
        PINGROOM_TOKEN: connection.token, PINGROOM_ROOM: connection.room, PINGROOM_API_URL: connection.apiUrl },
      signal, timeout: 15000, maxBuffer: 65536,
    });
  } catch {
    throw new Error('PingRoom delivery failed; the alert remains queued for the next check.');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
