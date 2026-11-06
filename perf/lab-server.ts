/* eslint-disable no-console -- a CLI: it prints the phone link. */
/**
 * Serves the perf lab on the LAN (plan prancy-squishing-donut P3b).
 *
 *   pnpm perf:lab
 *
 * Starts one isolated game server + Vite pair (2768 / 5374, temp DB, test
 * rooms on) and prints the link to open on a phone. Each scene the device
 * finishes is saved to `perf/ledger/devices/` with the server's tick numbers
 * for the same window. Ctrl-C stops everything.
 */
import { networkInterfaces } from 'node:os';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CaptureServers } from '../showcase/servers.js';

const lan = Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address))?.address ?? 'localhost';

const runDir = path.resolve('perf', '.run', 'lab');
mkdirSync(runDir, { recursive: true });
const ports = { server: 2768, vite: 5374 };
const servers = new CaptureServers(process.cwd(), runDir, ports, { EQX_PERF_LEDGER_DIR: path.resolve('perf', 'ledger', 'devices') });

const stop = (): void => { servers.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await servers.ensure('lean');
console.log(`PERF LAB URL: http://${lan}:${ports.vite}/__perf-lab__/index.html`);
console.log('Readings land in perf/ledger/devices/. Ctrl-C to stop.');
setInterval(() => { /* stay up */ }, 60_000);
