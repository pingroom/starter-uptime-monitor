import { spawn } from 'node:child_process';
import { cliPath } from '../src/cli.mjs';
import { connectionHome } from '../src/connection.mjs';

const child = spawn(process.execPath, [cliPath, 'pair', '--agent-label', 'Uptime-monitor-starter'], {
  stdio: 'inherit', env: { ...process.env, PINGROOM_HOME: connectionHome() },
});
child.once('error', () => { console.error('Could not start PingRoom CLI. Run npm ci first.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
