import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvFile } from 'node:process';
import { sendAlert } from '../src/cli.mjs';
import { loadConfig, configIdentity } from '../src/config.mjs';
import { loadConnection } from '../src/connection.mjs';
import { runOnce } from '../src/monitor.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw new Error('The .env file could not be loaded.'); }
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !['--loop', '--reset-state'].includes(flag)) || flags.length !== new Set(flags).size || flags.length > 1) {
    throw new Error('Usage: npm start [-- --loop | -- --reset-state]');
  }
  const config = loadConfig();
  const connection = await loadConnection();
  const identity = configIdentity(config, connection);
  do {
    try {
      const result = await runOnce({ config, identity, signal: controller.signal, reset: flags.includes('--reset-state'),
        send: (event) => sendAlert(event, config, connection, { signal: controller.signal }) });
      console.log(result.skipped ? 'Skipped: another check holds the state lock.'
        : result.reset ? 'State reset. Previous pending alerts were discarded; no check or ping was sent.'
          : `HTTP check ${result.healthy ? 'healthy' : 'failed'}; status ${result.status}; consecutive failures ${result.failures}; alerts sent ${result.sent}.`);
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error(error.message);
      if (!flags.includes('--loop')) { process.exitCode = 1; break; }
    }
    if (!flags.includes('--loop')) break;
    await delay(config.intervalMs, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch (error) {
  if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
