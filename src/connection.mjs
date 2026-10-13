import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function connectionHome(env = process.env) {
  return env.PINGROOM_HOME || fileURLToPath(new URL('../.pingroom', import.meta.url));
}

export async function loadConnection(env = process.env) {
  const token = env.PINGROOM_TOKEN?.trim();
  const room = env.PINGROOM_ROOM?.trim();
  if (token || room || env.CI) {
    if (!token || !room) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; environment values cannot be mixed with a saved connection.');
    return { token, room, apiUrl: 'https://api.pingroom.io' };
  }
  let saved;
  try { saved = JSON.parse(await readFile(join(connectionHome(env), 'credentials.json'), 'utf8')); }
  catch { throw new Error('No readable starter connection. Run npm run pair, or set PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  if (typeof saved.token !== 'string' || !saved.token || typeof saved.room?.invite_code !== 'string' || !saved.room.invite_code) {
    throw new Error('The saved connection needs a token and home room. Run npm run pair and choose a room.');
  }
  let origin;
  try { origin = new URL(saved.api_url || 'https://api.pingroom.io').origin; } catch { throw new Error('The saved connection has an invalid API origin.'); }
  if (origin !== 'https://api.pingroom.io') throw new Error('This starter uses api.pingroom.io. Pair with the production API.');
  return { token: saved.token, room: saved.room.invite_code, apiUrl: origin };
}
