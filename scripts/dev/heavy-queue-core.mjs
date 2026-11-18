/**
 * Heavy-job queue: pure logic + the small file layer (used by heavy-queue.mjs).
 *
 * Many Claude sessions share one desktop. Each used to check "4 GB free" on
 * its own, then all started heavy work at once and the low-memory reaper
 * killed them. The queue lets ONE heavy job run at a time, machine-wide:
 *  - a waiter writes `ticket-<id>.json` into the shared queue dir;
 *  - order is highest effective priority first, then oldest; effective
 *    priority = priority + 1 per 10 min waited (nothing starves);
 *  - the head may start only when nothing is running and free RAM >= the
 *    threshold; it claims the single `running` slot with an exclusive create
 *    (`wx`), so of two racers exactly one wins;
 *  - a `running` file whose pid is dead is stale and any waiter deletes it
 *    at once;
 *  - watchdog: a live holder past its limit (max(3x, estimate + 10 min) of
 *    its --minutes, or 45 min with none) is ended, whole process tree, by any
 *    waiter or by its own wrapper (a reaped shell can leave a hung job behind);
 *  - a queue ticket whose pid is dead (the reaper killed a waiting shell) is
 *    ORPHANED, not deleted: stamped `orphanedAtMs`, left out of the order,
 *    and deleted after ORPHAN_GRACE_MS. A re-run with the same who + kind
 *    adopts it and keeps its joinedAtMs, so it keeps its place.
 *
 * Dependency-free Node ESM. No shebang (CRLF checkouts break vitest imports).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const KINDS = ['film', 'e2e', 'netgate', 'perf', 'suite', 'other'];
export const AGING_MS = 10 * 60_000;
/** Watchdog limit for a running job with no --minutes estimate. */
export const WATCHDOG_NO_ESTIMATE_MIN = 45;
/** Watchdog slack: a job may always run its estimate + this many minutes. */
export const WATCHDOG_SLACK_MIN = 10;
export const RUNNING_FILE = 'running';
/** An unreadable (half-written) `running` file older than this is stale. */
export const GARBLED_GRACE_MS = 30_000;
/** A dead waiter's ticket is kept this long so a re-run can keep its place. */
export const ORPHAN_GRACE_MS = 15 * 60_000;

/** True for a dead waiter's ticket kept for re-join (never in the order). */
export const isOrphaned = (t) => t.orphanedAtMs != null;

/** Base priority + 1 per full 10 min waited. */
export function effectivePriority(t, now) {
  const waited = Math.max(0, now - t.joinedAtMs);
  return t.priority + Math.floor(waited / AGING_MS);
}

/** Queue order: highest effective priority, then oldest, then id. */
export function orderQueue(tickets, now) {
  return [...tickets].sort((a, b) =>
    effectivePriority(b, now) - effectivePriority(a, now)
    || a.joinedAtMs - b.joinedAtMs
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True while `pid` exists. EPERM means it exists but is not ours: alive. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** Stale = its owner process is gone (an overdue live one is the watchdog's). */
export function isStale(t, isAlive = isPidAlive) {
  return !isAlive(t.pid);
}

/** Minutes a job may run: max(3x estimate, estimate + 10), or 45 with none. */
export function watchdogLimitMin(estimateMin) {
  if (!(estimateMin > 0)) return WATCHDOG_NO_ESTIMATE_MIN;
  return Math.max(3 * estimateMin, estimateMin + WATCHDOG_SLACK_MIN);
}

/**
 * Watchdog decision for the running holder `r` (pure). `action` is 'end' once
 * it has run strictly longer than its limit, else 'keep'.
 */
export function watchdogDecision(r, now) {
  const startedAtMs = r.startedAtMs ?? r.joinedAtMs;
  const limitMin = watchdogLimitMin(r.estimateMin);
  const limitMs = limitMin * 60_000;
  const runMs = now - startedAtMs;
  return {
    action: runMs > limitMs ? 'end' : 'keep',
    limitMin, limitMs, runMs, endsAtMs: startedAtMs + limitMs,
  };
}

/** Past its watchdog limit (the watchdog ends it). */
export function holderOverdue(r, now) {
  return watchdogDecision(r, now).action === 'end';
}

/** The one log line for a job the watchdog ended. */
export function watchdogMessage(r, d) {
  const est = r.estimateMin ? `est ${r.estimateMin}m` : 'no estimate';
  return `watchdog ended overdue job: ${r.who} [${r.kind}] pid ${r.pid}, ran ${fmtDur(d.runMs)} vs ${est}`
    + ` (limit ${d.limitMin}m); re-queue with a realistic --minutes if it really needs longer`;
}

/**
 * Kill `pid` and its whole process tree. Windows: taskkill /T /F. POSIX: the
 * process group of `groupPid` (the wrapper spawns its child detached, so the
 * child leads its own group), then `pid` itself.
 */
export function killTree(pid, groupPid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  for (const target of [groupPid != null ? -groupPid : null, -pid, pid]) {
    if (target == null) continue;
    try { process.kill(target, 'SIGKILL'); } catch { /* gone or not a group */ }
  }
}

/**
 * May `meId` start now? `running` is the holder ticket, `{garbled:true}` for
 * an unreadable slot, or null. `freeGb` may be null when not yet measured.
 */
export function decide({ meId, tickets, running, freeGb, minGb, now }) {
  const order = orderQueue(tickets.filter((t) => !isOrphaned(t)), now);
  const position = order.findIndex((t) => t.id === meId) + 1;
  if (position === 0) return { go: false, position: 0, reason: 'ticket missing' };
  if (running) return { go: false, position, reason: 'busy' };
  if (position > 1) return { go: false, position, reason: 'queued' };
  if (minGb > 0 && (freeGb == null || freeGb < minGb)) {
    return { go: false, position, reason: 'low-ram' };
  }
  return { go: true, position, reason: 'head' };
}

/**
 * The orphan a new run with this who + kind takes over (oldest first), or
 * undefined. Expired orphans never match.
 */
export function findAdoptable(tickets, { who, kind }, now) {
  return tickets
    .filter((t) => isOrphaned(t) && t.who === who && t.kind === kind
      && now - t.orphanedAtMs <= ORPHAN_GRACE_MS)
    .sort((a, b) => a.joinedAtMs - b.joinedAtMs)[0];
}

// ── file layer ────────────────────────────────────────────────────────────

/** `<main checkout>/.claude/<name>`: per-machine state shared by every
 *  worktree (the heavy queue; the phone lane, phone-lane-core.mjs). */
export function resolveSharedClaudeDir(name, cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd, encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`${name}: not in a git checkout (${(r.stderr || '').trim()})`);
  }
  return path.join(path.dirname(r.stdout.trim()), '.claude', name);
}

/** `<main checkout>/.claude/heavy-queue`, shared by every worktree. */
export function resolveQueueDir(cwd = process.cwd(), env = process.env) {
  if (env.HEAVY_QUEUE_DIR) return path.resolve(env.HEAVY_QUEUE_DIR);
  return resolveSharedClaudeDir('heavy-queue', cwd);
}

/** Join argv for a shell, quoting args that need it. */
export function shellJoin(args) {
  return args.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ');
}

export function newTicketId(now = Date.now(), pid = process.pid) {
  return `${now.toString(36)}-${pid}-${Math.random().toString(36).slice(2, 6)}`;
}

const ticketFile = (dir, id) => path.join(dir, `ticket-${id}.json`);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Write atomically (tmp + rename) so readers never see half a ticket. */
export function writeTicket(dir, t) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${t.id}`);
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
  fs.renameSync(tmp, ticketFile(dir, t.id));
}

export function removeTicket(dir, id) {
  try { fs.unlinkSync(ticketFile(dir, id)); } catch { /* already gone */ }
}

export function readTickets(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith('ticket-') || !n.endsWith('.json')) continue;
    const t = readJson(path.join(dir, n));
    if (t && typeof t.id === 'string') out.push(t);
  }
  return out;
}

/** The holder ticket, `{garbled:true, ageMs}` if unreadable, or null if free. */
export function readRunning(dir, now = Date.now()) {
  const file = path.join(dir, RUNNING_FILE);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const r = readJson(file);
  if (r && typeof r.id === 'string') return r;
  return { garbled: true, ageMs: now - st.mtimeMs };
}

/** Claim the single slot. Exclusive create: of N racers exactly one wins. */
export function tryClaim(dir, t, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(path.join(dir, RUNNING_FILE), 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ ...t, startedAtMs: now, startedAt: new Date(now).toISOString() }, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Free the slot, but only if it is still `id`'s. */
export function releaseRunning(dir, id) {
  const file = path.join(dir, RUNNING_FILE);
  const r = readJson(file);
  if (r && r.id === id) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

/**
 * Orphan queue tickets whose owner pid is dead (delete them once past
 * ORPHAN_GRACE_MS); free the running slot at once if its holder is dead. Never
 * touches a live process. Returns what it changed (for logging): `where` is
 * 'queue' with `orphaned` or `expired`, or 'running'.
 */
export function sweepStale(dir, { isAlive = isPidAlive, now = Date.now() } = {}) {
  const removed = [];
  for (const t of readTickets(dir)) {
    if (isOrphaned(t)) {
      if (now - t.orphanedAtMs > ORPHAN_GRACE_MS) {
        removeTicket(dir, t.id); removed.push({ ...t, where: 'queue', expired: true });
      }
    } else if (isStale(t, isAlive)) {
      const o = { ...t, orphanedAtMs: now };
      writeTicket(dir, o); removed.push({ ...o, where: 'queue', orphaned: true });
    }
  }
  const r = readRunning(dir, now);
  if (r) {
    const file = path.join(dir, RUNNING_FILE);
    if (r.garbled) {
      if (r.ageMs > GARBLED_GRACE_MS) {
        try { fs.unlinkSync(file); removed.push({ id: '?', where: 'running', garbled: true }); } catch { /* gone */ }
      }
    } else if (isStale(r, isAlive)) {
      // Re-read right before unlinking so a fresh claim by someone else survives.
      const again = readJson(file);
      if (again && again.id === r.id) {
        try { fs.unlinkSync(file); removed.push({ ...r, where: 'running' }); } catch { /* gone */ }
      }
    }
  }
  return removed;
}

/**
 * Watchdog: end a live running job past its limit (watchdogDecision): kill its
 * whole process tree, then free the slot if it is still that job's. Run by
 * every waiter, like sweepStale. Returns `{ holder, decision }` when it ended
 * one, else null. `kill` is injectable for tests.
 */
export function endOverdue(dir, { now = Date.now(), isAlive = isPidAlive, kill = killTree } = {}) {
  const r = readRunning(dir, now);
  if (!r || r.garbled) return null;
  const decision = watchdogDecision(r, now);
  if (decision.action !== 'end') return null;
  if (isAlive(r.pid) || (r.childPid != null && isAlive(r.childPid))) kill(r.pid, r.childPid);
  const file = path.join(dir, RUNNING_FILE);
  const again = readJson(file);
  if (again && again.id === r.id) {
    try { fs.unlinkSync(file); } catch { /* gone */ }
  }
  return { holder: r, decision };
}

/** Record the holder's child pid in the slot (POSIX group kill). Owner only. */
export function recordRunningChild(dir, id, childPid) {
  const file = path.join(dir, RUNNING_FILE);
  const r = readJson(file);
  if (!r || r.id !== id) return;
  const tmp = path.join(dir, `.tmp-running-${id}`);
  fs.writeFileSync(tmp, JSON.stringify({ ...r, childPid }, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Re-join: if an orphan with `t`'s who + kind is within grace, `t` takes its
 * joinedAtMs (so its age and place) and the orphan file is removed. Call after
 * sweepStale and before writeTicket. Returns the adopted orphan or undefined.
 */
export function adoptOrphan(dir, t, now = Date.now()) {
  const o = findAdoptable(readTickets(dir), t, now);
  if (!o) return undefined;
  t.joinedAtMs = o.joinedAtMs;
  t.joinedAt = o.joinedAt ?? new Date(o.joinedAtMs).toISOString();
  removeTicket(dir, o.id);
  return o;
}

// ── dev-server leases (dev-lease.mjs) ─────────────────────────────────────
// Hand-started dev servers are NOT queued (a play session would block films);
// instead each one holds a lease in `<queue dir>/dev/` (same ticket files) and
// at most EQX_DEV_CAP (default 2) dev SETUPS run machine-wide. A server and a
// client from the same worktree are one setup. A lease is live while its
// wrapper or its child process lives; a dead one is swept, never killed.

export const DEV_KINDS = ['server', 'client'];
export const DEFAULT_DEV_CAP = 2;

/** `<queue dir>/dev`: one lease ticket per running dev server/client. */
export const devLeaseDir = (queueDir) => path.join(queueDir, 'dev');

/** Why this start skips the cap (it still writes a lease), or null. */
export function devCapExemption(env = process.env) {
  if (env.CI) return 'ci';
  if (env.EQX_HEAVY_QUEUE) return 'queued';
  const skip = env.EQX_DEV_CAP_SKIP;
  if (skip && skip !== '0') return skip === '1' ? 'skip' : skip;
  return null;
}

/** EQX_DEV_CAP as a positive integer, else the default. */
export function devCap(env = process.env) {
  const n = Number(env.EQX_DEV_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DEV_CAP;
}

/** Live while the wrapper or the command it started is alive. */
export function isLeaseLive(l, isAlive = isPidAlive) {
  return isAlive(l.pid) || (l.childPid != null && isAlive(l.childPid));
}

/** Leases grouped into setups (one per worktree), oldest setup first. */
export function groupDevSetups(leases) {
  const byKey = new Map();
  for (const l of leases) {
    const key = l.worktree ?? l.cwd;
    let s = byKey.get(key);
    if (!s) { s = { worktree: key, who: l.who, startedAtMs: l.startedAtMs, firstId: l.id, leases: [] }; byKey.set(key, s); }
    s.leases.push(l);
    if (l.startedAtMs < s.startedAtMs || (l.startedAtMs === s.startedAtMs && l.id < s.firstId)) {
      s.startedAtMs = l.startedAtMs; s.firstId = l.id; s.who = l.who;
    }
  }
  return [...byKey.values()].sort((a, b) => a.startedAtMs - b.startedAtMs
    || (a.firstId < b.firstId ? -1 : a.firstId > b.firstId ? 1 : 0));
}

/**
 * May lease `meId` (already written, so two racers see each other) run?
 * Only live, non-exempt leases count; the oldest `cap` setups win, so of two
 * racers for the last slot the later one refuses. `others` = the other setups.
 */
export function devCapDecision({ meId, leases, cap }) {
  const me = leases.find((l) => l.id === meId);
  const setups = groupDevSetups(leases.filter((l) => !l.exempt));
  const key = me ? (me.worktree ?? me.cwd) : undefined;
  const idx = setups.findIndex((s) => s.worktree === key);
  const others = setups.filter((s) => s.worktree !== key);
  if (!me || me.exempt) return { go: true, reason: me ? 'exempt' : 'lease missing', others };
  if (idx < cap) return { go: true, reason: setups[idx].leases.length > 1 ? 'same-setup' : 'under-cap', others };
  return { go: false, reason: 'over-cap', others };
}

/** Delete leases whose processes are all dead. Never touches a process. */
export function sweepDevLeases(dir, { isAlive = isPidAlive } = {}) {
  const removed = [];
  for (const l of readTickets(dir)) {
    if (!isLeaseLive(l, isAlive)) { removeTicket(dir, l.id); removed.push(l); }
  }
  return removed;
}

/** One line per setup: who, kinds + ports, age, worktree. */
export function formatDevSetup(s, now) {
  const parts = s.leases.map((l) => `${l.kind}${l.port ? ` :${l.port}` : ''}`).join(' + ');
  const ex = s.leases.every((l) => l.exempt) ? ` [exempt: ${s.leases[0].exempt}]` : '';
  return `${String(s.who).slice(0, 25).padEnd(25)} ${parts}  up ${fmtDur(now - s.startedAtMs)}${ex}  (${s.worktree})`;
}

export function devRefusalMessage({ others, cap, now }) {
  return [
    `[dev-lease] refused: ${others.length} dev setups already run on this machine (cap EQX_DEV_CAP=${cap}):`,
    ...others.map((s) => `  ${formatDevSetup(s, now)}`),
    '  Stop your own dev server when done, or reuse a running one (point at its ports).',
    '  See docs/ops/agent-workflow.md "Heavy-job queue". Debug escape: EQX_DEV_CAP_SKIP=1',
  ].join('\n');
}

// ── formatting ────────────────────────────────────────────────────────────

export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Status snapshot (also the `--json` shape). */
export function snapshot(dir, now = Date.now()) {
  const running = readRunning(dir, now);
  const all = readTickets(dir);
  const orphaned = all.filter(isOrphaned).sort((a, b) => a.joinedAtMs - b.joinedAtMs).map((t) => ({
    id: t.id, who: t.who, kind: t.kind, pid: t.pid, priority: t.priority,
    waitedMs: now - t.joinedAtMs, orphanedMs: now - t.orphanedAtMs,
    expiresInMs: Math.max(0, t.orphanedAtMs + ORPHAN_GRACE_MS - now), command: t.command,
  }));
  const queue = orderQueue(all.filter((t) => !isOrphaned(t)), now).map((t, i) => ({
    position: i + 1,
    id: t.id, who: t.who, kind: t.kind, pid: t.pid, cwd: t.cwd,
    priority: t.priority, effectivePriority: effectivePriority(t, now),
    waitedMs: now - t.joinedAtMs, estimateMin: t.estimateMin ?? null,
    command: t.command,
  }));
  let run = null;
  if (running && running.garbled) run = { garbled: true };
  else if (running) {
    const wd = watchdogDecision(running, now);
    run = {
      id: running.id, who: running.who, kind: running.kind, pid: running.pid,
      cwd: running.cwd, priority: running.priority,
      runningMs: now - running.startedAtMs, estimateMin: running.estimateMin ?? null,
      overdue: wd.action === 'end', limitMin: wd.limitMin, command: running.command,
    };
  }
  // Live dev-server setups (the caller sweeps dead leases first).
  const dev = groupDevSetups(readTickets(devLeaseDir(dir))).map((s) => ({
    who: s.who, worktree: s.worktree, upMs: now - s.startedAtMs,
    leases: s.leases.map((l) => ({ kind: l.kind, port: l.port ?? null, pid: l.pid, exempt: l.exempt ?? null })),
  }));
  return { dir, running: run, queue, orphaned, dev };
}

export function formatStatus(snap) {
  const lines = [];
  const r = snap.running;
  if (!r) lines.push('running: (none)');
  else if (r.garbled) lines.push('running: (slot being claimed)');
  else {
    lines.push(`running: ${r.who} [${r.kind}] p${r.priority} for ${fmtDur(r.runningMs)}`
      + `${r.estimateMin ? ` / est ${r.estimateMin}m` : ''} pid ${r.pid}`
      + (r.overdue ? ` · OVERDUE, past its ${r.limitMin}m limit` : ` · ends at ${r.limitMin}m if still running`));
  }
  if (snap.queue.length === 0) lines.push('queue: (empty)');
  else {
    lines.push('  #  who                       kind     prio  waited   est');
    for (const q of snap.queue) {
      const prio = q.effectivePriority === q.priority ? `${q.priority}` : `${q.priority}>${q.effectivePriority}`;
      lines.push(`  ${String(q.position).padEnd(2)} ${String(q.who).slice(0, 25).padEnd(25)} ${q.kind.padEnd(8)} ${prio.padEnd(5)} `
        + `${fmtDur(q.waitedMs).padEnd(8)} ${q.estimateMin ? `${q.estimateMin}m` : '-'}`);
    }
  }
  for (const o of snap.orphaned ?? []) {
    lines.push(`orphaned: ${o.who} [${o.kind}] ${fmtDur(o.orphanedMs)} (joined ${fmtDur(o.waitedMs)} ago),`
      + ` rejoin with same --who to keep place (expires in ${fmtDur(o.expiresInMs)})`);
  }
  if (!snap.dev || snap.dev.length === 0) lines.push('dev servers: (none)');
  else {
    lines.push('dev servers:');
    for (const d of snap.dev) lines.push(`  ${formatDevSetup({ ...d, startedAtMs: 0 }, d.upMs)}`);
  }
  return lines.join('\n');
}
