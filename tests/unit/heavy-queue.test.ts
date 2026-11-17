/**
 * Unit test for the machine-wide heavy-job queue
 * (`scripts/dev/heavy-queue-core.mjs` + the `heavy-queue.mjs` CLI).
 * Locks: ordering + aging, the single running slot under a race, stale
 * cleanup that never touches a live holder, dead waiters kept as orphans so a
 * re-run keeps its place, and two real wrappers never overlapping. Lives under `tests/unit/` because that's where vitest looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AGING_MS, ORPHAN_GRACE_MS, adoptOrphan, decide, effectivePriority, formatStatus, holderOverdue,
  orderQueue, readRunning, readTickets, releaseRunning, snapshot, sweepStale, tryClaim, writeTicket,
  // @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
} from '../../scripts/dev/heavy-queue-core.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/dev/heavy-queue.mjs');
const MIN = 60_000;
const T0 = 1_000_000_000_000;

interface Ticket { id: string; pid: number; priority: number; joinedAtMs: number; estimateMin?: number | null; startedAtMs?: number; who?: string; kind?: string; orphanedAtMs?: number; orphaned?: boolean; expired?: boolean; where?: string }
const tk = (id: string, priority: number, joinedAtMs: number, pid = process.pid): Ticket =>
  ({ id, pid, priority, joinedAtMs, who: id, kind: 'other', estimateMin: null });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-queue-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('ordering and aging', () => {
  it('orders by priority, then oldest', () => {
    const q = orderQueue([tk('a', 3, T0), tk('b', 5, T0 + 1000), tk('c', 3, T0 - 1000)], T0 + 2000);
    expect(q.map((t: Ticket) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('ages +1 per 10 min waited so a low priority cannot starve', () => {
    expect(effectivePriority(tk('a', 2, T0), T0 + AGING_MS - 1)).toBe(2);
    expect(effectivePriority(tk('a', 2, T0), T0 + 3 * AGING_MS)).toBe(5);
    const now = T0 + 25 * MIN;
    // p2 waiting 25 min (eff 4) beats a fresh p3; ties with a fresh p4 and wins on age.
    const q = orderQueue([tk('fresh3', 3, now), tk('old2', 2, T0), tk('fresh4', 4, now)], now);
    expect(q.map((t: Ticket) => t.id)).toEqual(['old2', 'fresh4', 'fresh3']);
  });
});

describe('decide', () => {
  const base = { minGb: 4, now: T0 };
  it('only the head starts, only when nothing runs and RAM is free', () => {
    const tickets = [tk('a', 3, T0 - 2), tk('b', 3, T0 - 1)];
    expect(decide({ ...base, meId: 'a', tickets, running: null, freeGb: 8 })).toMatchObject({ go: true, position: 1 });
    expect(decide({ ...base, meId: 'b', tickets, running: null, freeGb: 8 })).toMatchObject({ go: false, position: 2, reason: 'queued' });
    expect(decide({ ...base, meId: 'a', tickets, running: tk('x', 3, T0), freeGb: 8 })).toMatchObject({ go: false, reason: 'busy' });
    expect(decide({ ...base, meId: 'a', tickets, running: null, freeGb: 3.9 })).toMatchObject({ go: false, reason: 'low-ram' });
    expect(decide({ ...base, meId: 'a', tickets, running: null, freeGb: null })).toMatchObject({ go: false, reason: 'low-ram' });
    expect(decide({ ...base, minGb: 0, meId: 'a', tickets, running: null, freeGb: null })).toMatchObject({ go: true });
  });
});

describe('running slot', () => {
  it('race: two waiters that both think they are head — exactly one claims the slot', async () => {
    const a = tk('a', 3, T0);
    const b = tk('b', 3, T0);
    writeTicket(dir, a); writeTicket(dir, b);
    const wins = await Promise.all([a, b].map((t) => Promise.resolve().then(() => tryClaim(dir, t))));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const holder = readRunning(dir);
    const loser = holder.id === 'a' ? 'b' : 'a';
    // The loser now sees the slot busy and waits.
    expect(decide({ meId: loser, tickets: readTickets(dir), running: holder, freeGb: 8, minGb: 4, now: T0 }).go).toBe(false);
    // A non-holder cannot release the slot; the holder can.
    releaseRunning(dir, loser);
    expect(readRunning(dir)).not.toBeNull();
    releaseRunning(dir, holder.id);
    expect(readRunning(dir)).toBeNull();
    expect(tryClaim(dir, holder.id === 'a' ? b : a)).toBe(true);
  });

  it('frees a dead holder at once and orphans a dead waiter, never touches a live one', () => {
    const dead = 2 ** 30; // no such pid
    writeTicket(dir, tk('live', 3, T0));
    writeTicket(dir, tk('gone', 3, T0, dead));
    tryClaim(dir, tk('holder', 3, T0, dead));
    const changed = sweepStale(dir, { now: T0 });
    expect(changed.map((r: Ticket) => r.id).sort()).toEqual(['gone', 'holder']);
    expect(changed.find((r: Ticket) => r.id === 'gone')).toMatchObject({ where: 'queue', orphaned: true });
    expect(readRunning(dir)).toBeNull(); // dead holder: slot released at once
    const kept = readTickets(dir).sort((a: Ticket, b: Ticket) => a.id.localeCompare(b.id));
    expect(kept.map((t: Ticket) => [t.id, t.orphanedAtMs])).toEqual([['gone', T0], ['live', undefined]]);

    // A live holder far past its estimate stays (overdue is display-only).
    tryClaim(dir, { ...tk('slow', 3, T0), estimateMin: 1 }, T0);
    expect(holderOverdue(readRunning(dir), T0 + 10 * MIN)).toBe(true);
    expect(sweepStale(dir, { now: T0 })).toEqual([]);
    expect(readRunning(dir).id).toBe('slow');
  });

  it('overdue: 3x the estimate, or 90 min with none', () => {
    expect(holderOverdue({ ...tk('a', 3, T0), estimateMin: 10, startedAtMs: T0 }, T0 + 29 * MIN)).toBe(false);
    expect(holderOverdue({ ...tk('a', 3, T0), estimateMin: 10, startedAtMs: T0 }, T0 + 31 * MIN)).toBe(true);
    expect(holderOverdue({ ...tk('a', 3, T0), startedAtMs: T0 }, T0 + 91 * MIN)).toBe(true);
  });
});

describe('orphaned tickets (reaped waiter keeps its place)', () => {
  const dead = 2 ** 30;
  const orphanAt = (id: string, joinedAtMs: number, who = id, kind = 'perf') => {
    writeTicket(dir, { ...tk(id, 3, joinedAtMs, dead), who, kind });
    sweepStale(dir, { now: T0 });
  };

  it('stays through the grace, is deleted after it, and is never re-stamped', () => {
    orphanAt('gone', T0 - 5 * MIN);
    expect(sweepStale(dir, { now: T0 + ORPHAN_GRACE_MS })).toEqual([]);
    expect(readTickets(dir)[0].orphanedAtMs).toBe(T0);
    const changed = sweepStale(dir, { now: T0 + ORPHAN_GRACE_MS + 1 });
    expect(changed).toMatchObject([{ id: 'gone', expired: true }]);
    expect(readTickets(dir)).toEqual([]);
  });

  it('is left out of the decide order: never blocks and never wins', () => {
    orphanAt('old', T0 - 60 * MIN);
    writeTicket(dir, tk('me', 3, T0));
    const tickets = readTickets(dir);
    const base = { tickets, running: null, freeGb: 8, minGb: 4, now: T0 };
    expect(decide({ ...base, meId: 'me' })).toMatchObject({ go: true, position: 1 });
    expect(decide({ ...base, meId: 'old' })).toMatchObject({ go: false, reason: 'ticket missing' });
    const snap = snapshot(dir, T0 + MIN);
    expect(snap.queue.map((q: Ticket) => q.id)).toEqual(['me']);
    expect(snap.orphaned).toMatchObject([{ id: 'old', orphanedMs: MIN, expiresInMs: ORPHAN_GRACE_MS - MIN }]);
    expect(formatStatus(snap)).toContain('orphaned: old [perf] 1m00s');
    expect(formatStatus(snap)).toContain('rejoin with same --who to keep place');
  });

  it('a re-run with the same who + kind inherits joinedAtMs and replaces the orphan', () => {
    orphanAt('gone', T0 - 30 * MIN, 'perf-a', 'perf');
    writeTicket(dir, tk('other', 3, T0 - 10 * MIN));
    const fresh = { ...tk('fresh', 3, T0 + MIN), who: 'perf-a', kind: 'perf' };
    expect(adoptOrphan(dir, fresh, T0 + MIN)).toMatchObject({ id: 'gone' });
    expect(fresh.joinedAtMs).toBe(T0 - 30 * MIN);
    writeTicket(dir, fresh);
    expect(readTickets(dir).map((t: Ticket) => t.id).sort()).toEqual(['fresh', 'other']);
    // Kept its age, so it is ahead of the ticket that joined after it.
    expect(decide({ meId: 'fresh', tickets: readTickets(dir), running: null, freeGb: 8, minGb: 4, now: T0 + MIN }))
      .toMatchObject({ go: true, position: 1 });
  });

  it('a different who, a different kind, or an expired orphan is not adopted', () => {
    orphanAt('gone', T0 - 30 * MIN, 'perf-a', 'perf');
    for (const [who, kind, now] of [['perf-b', 'perf', T0], ['perf-a', 'e2e', T0], ['perf-a', 'perf', T0 + ORPHAN_GRACE_MS + 1]] as const) {
      const t = { ...tk('x', 3, now), who, kind };
      expect(adoptOrphan(dir, t, now)).toBeUndefined();
      expect(t.joinedAtMs).toBe(now);
    }
    expect(readTickets(dir).map((t: Ticket) => t.id)).toEqual(['gone']);
  });
});

describe('CLI', () => {
  it('two wrappers started together never overlap and leave the dir clean', async () => {
    const log = path.join(dir, 'log.txt');
    const job = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'end\\n'),700)`;
    const env = { ...process.env, HEAVY_QUEUE_DIR: path.join(dir, 'q'), HEAVY_QUEUE_MIN_GB: '0', HEAVY_QUEUE_POLL_MS: '100' };
    const runOne = () => new Promise<number>((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, 'run', '--kind', 'other', '--', process.execPath, '-e', job], { env, stdio: 'ignore' });
      p.on('exit', (c) => resolve(c ?? 1));
    });
    const codes = await Promise.all([runOne(), runOne()]);
    expect(codes).toEqual([0, 0]);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
    expect(fs.readdirSync(path.join(dir, 'q'))).toEqual([]);
  }, 20_000);
});
