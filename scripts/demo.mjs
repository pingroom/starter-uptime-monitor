import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce } from '../src/monitor.mjs';

const directory = await mkdtemp(join(tmpdir(), 'uptime-demo-'));
const config = { name: 'Demo service', threshold: 3, stateFile: join(directory, 'state.json') };
console.log('Offline demo: simulated checks and sender; no credentials or network requests.');
try {
  for (const healthy of [true, false, true, false, false, false, false, true, true]) {
    const result = await runOnce({ config, identity: 'offline-demo', check: async () => healthy,
      send: async (event) => console.log(`SIMULATED ALERT: ${event.kind}`) });
    console.log(`Check ${healthy ? 'healthy' : 'failed'} → ${result.status}; failures ${result.failures}.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
