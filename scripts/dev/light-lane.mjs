/**
 * Light lane: at most EQX_LIGHT_CAP (default 2) local typecheck / lint runs
 * machine-wide (~1 GB each). Wraps `pnpm typecheck` and `pnpm lint`:
 *
 *   node scripts/dev/light-lane.mjs --kind <typecheck|lint> [--who label] -- <command...>
 *
 * The first argument after `--` is a shell command line (may hold `&&`); any
 * further arguments (e.g. `pnpm lint --fix`) are quoted and appended.
 * Writes a lease into `<main checkout>/.claude/heavy-queue/light/`, waits while
 * both slots are busy (naming the holders), runs the command with your stdio,
 * and removes the lease on exit / Ctrl+C. A crashed run's lease is swept (dead
 * pid); one holding a slot over 20 min stops counting (never killed).
 * No lease at all: CI, EQX_HEAVY_QUEUE (inside a queued heavy job),
 * EQX_LIGHT_SKIP=1 (escape hatch).
 * Logic + tests: heavy-queue-core.mjs, tests/unit/light-lane.test.ts.
 * Rule: docs/ops/agent-workflow.md "Heavy-job queue".
 * No shebang on purpose (CRLF checkouts break vitest imports).
 */
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  LIGHT_KINDS, LIGHT_STALE_MS, fmtDur, isLeaseLive, lightCap, lightLaneDecision, lightLeaseDir, lightSkip, lightWaitMessage,
  newTicketId, readTickets, removeTicket, resolveQueueDir, shellJoin, sweepLightLeases, writeTicket,
} from './heavy-queue-core.mjs';

const POLL_MS = Number(process.env.HEAVY_QUEUE_POLL_MS) || 2000;
const STATUS_EVERY_MS = 30_000;
const log = (msg) => process.stderr.write(`[light-lane] ${msg}\n`);

function usage() {
  log(`usage: light-lane.mjs --kind <${LIGHT_KINDS.join('|')}> [--who label] -- <command...>`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) usage();
const [line, ...extra] = argv.slice(sep + 1);
const commandLine = extra.length ? `${line} ${shellJoin(extra)}` : line;
let kind = null;
let who = null;
for (let i = 0; i < sep; i++) {
  if (argv[i] === '--kind') kind = argv[++i];
  else if (argv[i] === '--who') who = argv[++i];
  else { log(`unknown flag ${argv[i]}`); usage(); }
}
if (!LIGHT_KINDS.includes(kind)) usage();

let dir = null;
let lease = null;
if (!lightSkip()) {
  try {
    dir = lightLeaseDir(resolveQueueDir());
  } catch (e) {
    log(`no lease (${e.message}); running unlaned`);
  }
}

let child = null;
const cleanup = () => { if (dir && lease) removeTicket(dir, lease.id); };
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

if (dir) {
  const joined = Date.now();
  lease = {
    id: newTicketId(joined),
    pid: process.pid,
    childPid: null,
    kind,
    who: who || path.basename(process.cwd()),
    cwd: process.cwd(),
    joinedAt: new Date(joined).toISOString(),
    joinedAtMs: joined,
    startedAtMs: null,
    command: commandLine,
  };
  // Write first, then decide: two racers see each other and the later waits.
  writeTicket(dir, lease);
  const cap = lightCap();
  let toldAt = 0;
  for (;;) {
    const now = Date.now();
    for (const l of sweepLightLeases(dir, { now })) {
      if (l.id === lease.id) continue;
      const why = isLeaseLive(l) ? `held a slot over ${LIGHT_STALE_MS / 60_000} min; process left alone` : 'pid gone';
      log(`dropped ${l.who} [${l.kind}] lease (${why})`);
    }
    let leases = readTickets(dir);
    if (!leases.some((l) => l.id === lease.id)) { writeTicket(dir, lease); leases = [...leases, lease]; }
    const d = lightLaneDecision({ meId: lease.id, leases, cap, now });
    if (d.go) break;
    if (toldAt === 0 || now - toldAt >= STATUS_EVERY_MS) {
      toldAt = now;
      process.stderr.write(`${lightWaitMessage({ kind, holders: d.holders, cap, now })}`
        + `${d.position > 1 ? `\n  (#${d.position} in line)` : ''}  [waited ${fmtDur(now - joined)}]\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  lease.startedAtMs = Date.now();
  lease.startedAt = new Date(lease.startedAtMs).toISOString();
  writeTicket(dir, lease);
  if (toldAt) log(`slot free after ${fmtDur(lease.startedAtMs - joined)}; running ${kind}`);
}

child = spawn(commandLine, { stdio: 'inherit', shell: true, windowsHide: true });
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
