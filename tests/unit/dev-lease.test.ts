/**
 * Unit test for the dev-server cap (`scripts/dev/dev-lease.mjs`, logic in
 * `heavy-queue-core.mjs`). Locks: a server + client from one worktree are one
 * setup; the oldest EQX_DEV_CAP setups win (a racer for the last slot
 * refuses); exempt leases never count; dead leases are swept, live ones kept;
 * `pnpm heavy status` lists the live setups.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DEV_CAP, devCap, devCapDecision, devCapExemption, devLeaseDir, devRefusalMessage, formatStatus,
  groupDevSetups, isLeaseLive, readTickets, snapshot, sweepDevLeases, writeTicket,
  // @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
} from '../../scripts/dev/heavy-queue-core.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60_000;

interface Lease { id: string; pid: number; childPid?: number | null; kind: string; port?: number; who: string; worktree: string; startedAtMs: number; exempt?: string | null }
interface Setup { worktree: string; who: string; leases: Lease[] }
const lease = (id: string, worktree: string, startedAtMs: number, extra: Partial<Lease> = {}): Lease =>
  ({ id, pid: 1000, kind: 'server', port: 2567, who: worktree, worktree, startedAtMs, exempt: null, ...extra });

describe('exemptions and cap', () => {
  it('CI, a queued run and EQX_DEV_CAP_SKIP skip the cap; nothing else does', () => {
    expect(devCapExemption({ CI: 'true' })).toBe('ci');
    expect(devCapExemption({ EQX_HEAVY_QUEUE: 'abc' })).toBe('queued');
    expect(devCapExemption({ EQX_DEV_CAP_SKIP: '1' })).toBe('skip');
    expect(devCapExemption({ EQX_DEV_CAP_SKIP: 'playwright' })).toBe('playwright');
    expect(devCapExemption({ EQX_DEV_CAP_SKIP: '0' })).toBeNull();
    expect(devCapExemption({})).toBeNull();
  });

  it('EQX_DEV_CAP defaults to 2 and ignores junk', () => {
    expect(DEFAULT_DEV_CAP).toBe(2);
    expect(devCap({})).toBe(2);
    expect(devCap({ EQX_DEV_CAP: '3' })).toBe(3);
    expect(devCap({ EQX_DEV_CAP: '0' })).toBe(2);
    expect(devCap({ EQX_DEV_CAP: 'x' })).toBe(2);
  });
});

describe('devCapDecision', () => {
  it('a server + client from one worktree are ONE setup', () => {
    const s = groupDevSetups([lease('a', 'wt1', T0), lease('b', 'wt1', T0 + 5, { kind: 'client' }), lease('c', 'wt2', T0 + 1)]);
    expect(s.map((x: Setup) => [x.worktree, x.leases.length])).toEqual([['wt1', 2], ['wt2', 1]]);
  });

  it('a third setup is refused; the pair partner of a live setup is not', () => {
    const live = [lease('a', 'wt1', T0), lease('b', 'wt2', T0 + MIN)];
    const third = lease('c', 'wt3', T0 + 2 * MIN);
    const d = devCapDecision({ meId: 'c', leases: [...live, third], cap: 2 });
    expect(d).toMatchObject({ go: false, reason: 'over-cap' });
    expect(d.others.map((s: Setup) => s.worktree)).toEqual(['wt1', 'wt2']);
    const client = lease('d', 'wt2', T0 + 2 * MIN, { kind: 'client', port: 5173 });
    expect(devCapDecision({ meId: 'd', leases: [...live, client], cap: 2 })).toMatchObject({ go: true, reason: 'same-setup' });
    expect(devCapDecision({ meId: 'c', leases: [...live, third], cap: 3 })).toMatchObject({ go: true, reason: 'under-cap' });
  });

  it('two racers for the last slot: the older wins, the later refuses', () => {
    const leases = [lease('a', 'wt1', T0), lease('b', 'wt2', T0 + 10), lease('c', 'wt3', T0 + 11)];
    expect(devCapDecision({ meId: 'b', leases, cap: 2 }).go).toBe(true);
    expect(devCapDecision({ meId: 'c', leases, cap: 2 }).go).toBe(false);
  });

  it('exempt leases (queued film, Playwright) never count and are never refused', () => {
    const leases = [
      lease('f1', 'film', T0, { exempt: 'queued' }), lease('p1', 'pw', T0, { exempt: 'playwright' }),
      lease('a', 'wt1', T0 + 1), lease('b', 'wt2', T0 + 2),
    ];
    expect(devCapDecision({ meId: 'b', leases, cap: 2 }).go).toBe(true);
    const more = [...leases, lease('q', 'film2', T0 + 3, { exempt: 'queued' })];
    expect(devCapDecision({ meId: 'q', leases: more, cap: 2 })).toMatchObject({ go: true, reason: 'exempt' });
  });

  it('the refusal lists who holds each setup, its ports and age', () => {
    const others = groupDevSetups([lease('a', 'wt1', T0, { who: 'weapon-cuts' }), lease('b', 'wt1', T0, { kind: 'client', port: 5173, who: 'weapon-cuts' })]);
    const msg = devRefusalMessage({ others, cap: 2, now: T0 + 62 * MIN });
    expect(msg).toContain('weapon-cuts');
    expect(msg).toContain('server :2567 + client :5173');
    expect(msg).toContain('up 1h02m');
    expect(msg).toContain('EQX_DEV_CAP_SKIP=1');
  });
});

describe('lease sweep', () => {
  let dir: string;
  beforeEach(() => { dir = devLeaseDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-lease-'))); });
  afterEach(() => { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); });

  it('live while the wrapper OR its child lives', () => {
    const alive = (pid: number) => pid === 7;
    expect(isLeaseLive(lease('a', 'w', T0, { pid: 7 }), alive)).toBe(true);
    expect(isLeaseLive(lease('a', 'w', T0, { pid: 1, childPid: 7 }), alive)).toBe(true);
    expect(isLeaseLive(lease('a', 'w', T0, { pid: 1, childPid: 2 }), alive)).toBe(false);
    expect(isLeaseLive(lease('a', 'w', T0, { pid: 1, childPid: null }), alive)).toBe(false);
  });

  it('removes dead leases only and status lists the live ones', () => {
    writeTicket(dir, lease('live', 'wt1', T0, { pid: process.pid, who: 'mine' }));
    writeTicket(dir, lease('dead', 'wt2', T0, { pid: 2 ** 30, childPid: 2 ** 30 + 1 }));
    const removed = sweepDevLeases(dir);
    expect(removed.map((l: Lease) => l.id)).toEqual(['dead']);
    expect(readTickets(dir).map((l: Lease) => l.id)).toEqual(['live']);
    const snap = snapshot(path.dirname(dir), T0 + 5 * MIN);
    expect(snap.dev).toHaveLength(1);
    expect(formatStatus(snap)).toMatch(/dev servers:\n {2}mine +server :2567 {2}up 5m00s/);
  });

  it('status says so when no dev server runs', () => {
    expect(formatStatus(snapshot(path.dirname(dir), T0))).toContain('dev servers: (none)');
  });
});
