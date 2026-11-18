/**
 * Dev-server lease: a light machine-wide cap on hand-started dev servers.
 * Wraps `pnpm dev:server`, `dev:server:nowatch` and `dev:client`:
 *
 *   node scripts/dev/dev-lease.mjs --kind <server|client> [--who label] -- <command...>
 *
 * Writes a lease into `<main checkout>/.claude/heavy-queue/dev/`, refuses if
 * that would make more than EQX_DEV_CAP (default 2) live dev setups (a server
 * + client from one worktree = one setup), then runs the command with your
 * stdio and removes the lease on exit / Ctrl+C. Dev servers are never queued.
 * Exempt from the cap (lease still written, shown as exempt): EQX_HEAVY_QUEUE
 * (a queued film / e2e / netgate owns the machine), EQX_DEV_CAP_SKIP (debug
 * escape; Playwright's webServers set it to `playwright`). CI: no lease at all.
 * Logic + tests: heavy-queue-core.mjs, tests/unit/dev-lease.test.ts.
 * Rule: docs/ops/agent-workflow.md "Heavy-job queue".
 * No shebang on purpose (CRLF checkouts break vitest imports).
 */
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  DEV_KINDS, devCap, devCapDecision, devCapExemption, devLeaseDir, devRefusalMessage, isPidAlive,
  newTicketId, readTickets, removeTicket, resolveQueueDir, shellJoin, sweepDevLeases, writeTicket,
} from './heavy-queue-core.mjs';

const log = (msg) => process.stderr.write(`[dev-lease] ${msg}\n`);

function usage() {
  log(`usage: dev-lease.mjs --kind <${DEV_KINDS.join('|')}> [--who label] -- <command...>`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) usage();
const command = argv.slice(sep + 1);
let kind = null;
let who = null;
for (let i = 0; i < sep; i++) {
  if (argv[i] === '--kind') kind = argv[++i];
  else if (argv[i] === '--who') who = argv[++i];
  else { log(`unknown flag ${argv[i]}`); usage(); }
}
if (!DEV_KINDS.includes(kind)) usage();

/** The port this command will listen on, as far as we can tell. */
function guessPort() {
  if (kind === 'server') return Number(process.env.PORT) || 2567;
  const i = command.findIndex((a) => a === '--port' || a.startsWith('--port='));
  if (i >= 0) return Number(command[i].includes('=') ? command[i].split('=')[1] : command[i + 1]) || null;
  return 5173;
}

let dir = null;
let lease = null;
if (!process.env.CI) {
  try {
    dir = devLeaseDir(resolveQueueDir());
  } catch (e) {
    log(`no lease (${e.message}); running uncapped`);
  }
}

if (dir) {
  const now = Date.now();
  const exempt = devCapExemption();
  lease = {
    id: newTicketId(now),
    pid: process.pid,
    childPid: null,
    kind,
    port: guessPort(),
    who: who || path.basename(process.cwd()),
    worktree: process.cwd(),
    cwd: process.cwd(),
    exempt,
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    command: command.join(' '),
  };
  for (const l of sweepDevLeases(dir, { isAlive: isPidAlive })) {
    log(`removed stale lease ${l.who} [${l.kind}] (pid ${l.pid} gone)`);
  }
  // Write first, then decide: two racers see each other and the later refuses.
  writeTicket(dir, lease);
  const cap = devCap();
  const d = devCapDecision({ meId: lease.id, leases: readTickets(dir), cap });
  if (!d.go) {
    removeTicket(dir, lease.id);
    process.stderr.write(`${devRefusalMessage({ others: d.others, cap, now })}\n`);
    process.exit(1);
  }
}

const cleanup = () => { if (dir && lease) removeTicket(dir, lease.id); };
let child = null;
const killChild = () => {
  if (!child || child.exitCode != null) return;
  // Our own child tree only, never anyone else's process.
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
  else child.kill('SIGTERM');
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => { killChild(); cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  } catch { /* signal not supported here */ }
}

child = spawn(shellJoin(command), { stdio: 'inherit', shell: true, windowsHide: true });
if (dir && lease && child.pid) {
  lease.childPid = child.pid; // the lease stays live if only the wrapper is killed
  writeTicket(dir, lease);
}
const code = await new Promise((resolve) => {
  child.on('error', (e) => { log(`spawn failed: ${e.message}`); resolve(1); });
  child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
});
cleanup();
process.exit(code);
