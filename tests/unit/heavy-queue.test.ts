/**
 * Unit test for the machine-wide heavy-job queue
 * (`scripts/dev/heavy-queue-core.mjs` + the `heavy-queue.mjs` CLI).
 * Locks: ordering + aging, the single running slot under a race, stale
 * cleanup that never touches a live holder, and two real wrappers never
 * overlapping. Lives under `tests/unit/` because that's where vitest looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AGING_MS, decide, effectivePriority, holderOverdue, orderQueue, readRunning,
  readTickets, releaseRunning, sweepStale, tryClaim, writeTicket,
  // @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
} from '../../scripts/dev/heavy-queue-core.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/dev/heavy-queue.mjs');
const MIN = 60_000;
const T0 = 1_000_000_000_000;

interface Ticket { id: string; pid: number; priority: number; joinedAtMs: number; estimateMin?: number | null; startedAtMs?: number; who?: string; kind?: string }
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

  it('sweeps dead-pid tickets and a dead holder, never a live one', () => {
    const dead = 2 ** 30; // no such pid
    writeTicket(dir, tk('live', 3, T0));
    writeTicket(dir, tk('gone', 3, T0, dead));
    tryClaim(dir, tk('holder', 3, T0, dead));
    const removed = sweepStale(dir);
    expect(removed.map((r: Ticket) => r.id).sort()).toEqual(['gone', 'holder']);
    expect(readTickets(dir).map((t: Ticket) => t.id)).toEqual(['live']);
    expect(readRunning(dir)).toBeNull();

    // A live holder far past its estimate stays (overdue is display-only).
    tryClaim(dir, { ...tk('slow', 3, T0), estimateMin: 1 }, T0);
    expect(holderOverdue(readRunning(dir), T0 + 10 * MIN)).toBe(true);
    expect(sweepStale(dir)).toEqual([]);
    expect(readRunning(dir).id).toBe('slow');
  });

  it('overdue: 3x the estimate, or 90 min with none', () => {
    expect(holderOverdue({ ...tk('a', 3, T0), estimateMin: 10, startedAtMs: T0 }, T0 + 29 * MIN)).toBe(false);
    expect(holderOverdue({ ...tk('a', 3, T0), estimateMin: 10, startedAtMs: T0 }, T0 + 31 * MIN)).toBe(true);
    expect(holderOverdue({ ...tk('a', 3, T0), startedAtMs: T0 }, T0 + 91 * MIN)).toBe(true);
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
