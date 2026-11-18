/**
 * Heavy-job queue CLI: one heavy job at a time on this machine.
 * Rule + priorities guide: docs/ops/agent-workflow.md "Heavy-job queue".
 * Logic lives in heavy-queue-core.mjs (unit-tested).
 *
 *   node scripts/dev/heavy-queue.mjs run --kind <film|e2e|netgate|perf|suite|other>
 *        [--priority 1-5] [--minutes N] [--who label] -- <command...>
 *   node scripts/dev/heavy-queue.mjs status [--json]
 *
 * The child gets EQX_HEAVY_QUEUE=<ticket id>; heavy scripts refuse to run
 * without it (heavy-queue-guard.mjs).
 * Env: HEAVY_QUEUE_MIN_GB (default 4; 0 skips the RAM check),
 *      HEAVY_QUEUE_DIR (override the shared dir), HEAVY_QUEUE_POLL_MS (default 2000).
 * No shebang on purpose (CRLF checkouts break vitest imports).
 */
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  KINDS, adoptOrphan, decide, devLeaseDir, endOverdue, isOrphaned, killTree, recordRunningChild, watchdogDecision, watchdogMessage, shellJoin, sweepDevLeases, fmtDur, formatStatus, newTicketId, readRunning, readTickets,
  releaseRunning, removeTicket, resolveQueueDir, snapshot, sweepStale, tryClaim, writeTicket,
} from './heavy-queue-core.mjs';

const POLL_MS = Number(process.env.HEAVY_QUEUE_POLL_MS) || 2000;
const STATUS_EVERY_MS = 30_000;
const RAM_EVERY_MS = 10_000;
const MIN_GB = process.env.HEAVY_QUEUE_MIN_GB != null && process.env.HEAVY_QUEUE_MIN_GB !== ''
  ? Number(process.env.HEAVY_QUEUE_MIN_GB) : 4;

const log = (msg) => process.stderr.write(`[heavy-queue] ${msg}\n`);

function logSweep(changed) {
  for (const s of changed) {
    const what = s.orphaned ? 'orphaned' : s.expired ? 'expired orphan' : 'removed stale';
    log(`${what} ${s.where} ticket ${s.who ?? s.id} (pid ${s.pid ?? '?'} gone)`);
  }
}

/** Watchdog: end an overdue running job (every waiter and status run this). */
function enforceWatchdog(dir) {
  const ended = endOverdue(dir);
  if (ended) log(watchdogMessage(ended.holder, ended.decision));
}

function usage(code = 2) {
  log('usage: heavy-queue.mjs run --kind <' + KINDS.join('|') + '> [--priority 1-5] [--minutes N] [--who label] -- <command...>');
  log('       heavy-queue.mjs status [--json]');
  process.exit(code);
}

/** Free physical RAM in GB (Windows: FreePhysicalMemory; POSIX: os.freemem). */
function freeRamGb() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-c', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    const kb = Number((r.stdout || '').trim());
    if (r.status === 0 && Number.isFinite(kb) && kb > 0) return kb / 2 ** 20;
  }
  return os.freemem() / 2 ** 30;
}

function parseRunArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) usage();
  const opts = { kind: null, priority: 3, minutes: null, who: null };
  const flags = argv.slice(0, sep);
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const v = flags[i + 1];
    if (f === '--kind') { opts.kind = v; i++; }
    else if (f === '--priority') { opts.priority = Number(v); i++; }
    else if (f === '--minutes') { opts.minutes = Number(v); i++; }
    else if (f === '--who') { opts.who = v; i++; }
    else { log(`unknown flag ${f}`); usage(); }
  }
  if (!KINDS.includes(opts.kind)) { log(`--kind must be one of ${KINDS.join(', ')}`); usage(); }
  if (!Number.isInteger(opts.priority) || opts.priority < 1 || opts.priority > 5) { log('--priority must be 1-5'); usage(); }
  if (opts.minutes != null && !(opts.minutes > 0)) { log('--minutes must be > 0'); usage(); }
  return { opts, command: argv.slice(sep + 1) };
}

async function cmdRun(argv) {
  const { opts, command } = parseRunArgs(argv);
  const dir = resolveQueueDir();
  const now = Date.now();
  const ticket = {
    id: newTicketId(now),
    pid: process.pid,
    who: opts.who || path.basename(process.cwd()),
    cwd: process.cwd(),
    kind: opts.kind,
    priority: opts.priority,
    estimateMin: opts.minutes,
    joinedAt: new Date(now).toISOString(),
    joinedAtMs: now,
    command: command.join(' '),
  };

  let child = null;
  let holding = false;
  const cleanup = () => {
    removeTicket(dir, ticket.id);
    if (holding) releaseRunning(dir, ticket.id);
  };
  const killChild = () => {
    if (!child || child.exitCode != null) return;
    // Our own child tree only, never anyone else's process.
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => { killChild(); cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143); });
    } catch { /* signal not supported here */ }
  }
  process.on('uncaughtException', (e) => { log(`crash: ${e && e.stack || e}`); killChild(); cleanup(); process.exit(1); });

  logSweep(sweepStale(dir));
  const adopted = adoptOrphan(dir, ticket, now);
  writeTicket(dir, ticket);
  if (adopted) log(`rejoined as ${ticket.who}, kept place (joined ${fmtDur(now - ticket.joinedAtMs)} ago)`);
  log(`joined queue as ${ticket.who} [${ticket.kind}] p${ticket.priority} (${dir})`);

  let freeGb = null;
  let ramAt = 0;
  let statusAt = Date.now();
  for (;;) {
    logSweep(sweepStale(dir));
    enforceWatchdog(dir);
    const t = Date.now();
    let tickets = readTickets(dir);
    const mine = tickets.find((x) => x.id === ticket.id);
    if (!mine || isOrphaned(mine)) { // wiped or wrongly orphaned: rejoin, keep age
      writeTicket(dir, ticket);
      tickets = [...tickets.filter((x) => x.id !== ticket.id), ticket];
    }
    const running = readRunning(dir, t);
    const state = { meId: ticket.id, tickets, running, minGb: MIN_GB, now: t };
    // A RAM reading older than RAM_EVERY_MS is never trusted for the go decision.
    let d = decide({ ...state, freeGb: t - ramAt < RAM_EVERY_MS ? freeGb : null });
    // Measure RAM only when it is the last thing in the way (PowerShell is slow).
    if (d.reason === 'low-ram' && t - ramAt >= RAM_EVERY_MS) {
      freeGb = freeRamGb(); ramAt = t;
      d = decide({ ...state, freeGb });
    }
    if (d.go && tryClaim(dir, ticket, t)) {
      holding = true;
      removeTicket(dir, ticket.id);
      break;
    }
    if (t - statusAt >= STATUS_EVERY_MS) {
      statusAt = t;
      const who = running ? (running.garbled ? '(claiming)' : `${running.who} [${running.kind}] ${fmtDur(t - running.startedAtMs)}`) : 'none';
      const ram = freeGb == null ? '?' : `${freeGb.toFixed(1)} GB`;
      log(`waiting ${fmtDur(t - ticket.joinedAtMs)} · #${d.position}/${tickets.filter((x) => !isOrphaned(x)).length} · running: ${who} · free RAM ${ram}${d.reason === 'low-ram' ? ` < ${MIN_GB} GB` : ''}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const waited = Date.now() - ticket.joinedAtMs;
  log(`running (waited ${fmtDur(waited)}${freeGb != null ? `, free RAM ${freeGb.toFixed(1)} GB` : ''}): ${ticket.command}`);
  // EQX_HEAVY_QUEUE tells the heavy scripts' guard (heavy-queue-guard.mjs) this run is queued.
  // POSIX: detached makes the child lead its own process group, so the
  // watchdog can kill the whole tree.
  child = spawn(shellJoin(command), {
    stdio: 'inherit', shell: true, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, EQX_HEAVY_QUEUE: ticket.id },
  });
  if (child.pid) recordRunningChild(dir, ticket.id, child.pid);
  // Own watchdog: fires even with no waiters (e.g. the shell above us was reaped).
  const startedAtMs = readRunning(dir)?.startedAtMs ?? Date.now();
  const selfCheck = setInterval(() => {
    const d = watchdogDecision({ ...ticket, startedAtMs }, Date.now());
    if (d.action !== 'end') return;
    clearInterval(selfCheck);
    log(watchdogMessage(ticket, d));
    if (child.pid) killTree(child.pid, process.platform === 'win32' ? undefined : child.pid);
    cleanup();
    process.exit(124);
  }, Math.min(POLL_MS * 5, 30_000));
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { log(`spawn failed: ${e.message}`); resolve(1); });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
  });
  clearInterval(selfCheck);
  log(`done (exit ${code}) after ${fmtDur(Date.now() - ticket.joinedAtMs - waited)}; slot released`);
  cleanup();
  process.exit(code);
}

function cmdStatus(argv) {
  const dir = resolveQueueDir();
  sweepStale(dir);
  enforceWatchdog(dir);
  sweepDevLeases(devLeaseDir(dir));
  const snap = snapshot(dir);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
  else process.stdout.write(`${formatStatus(snap)}\n`);
}

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'run') await cmdRun(rest);
else if (sub === 'status') cmdStatus(rest);
else usage(sub === '--help' || sub === '-h' ? 0 : 2);
