/**
 * Unit test for the light lane (`scripts/dev/light-lane.mjs`, logic in
 * `heavy-queue-core.mjs`). Locks: at most EQX_LIGHT_CAP typecheck / lint runs
 * hold a slot; the rest wait first-come first-served and the wait message
 * names the holders; a dead or 20-min-stale lease stops counting and is swept
 * (never killed); CI / queued / EQX_LIGHT_SKIP skip the lane; `pnpm heavy
 * status` lists the lane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LIGHT_CAP, LIGHT_STALE_MS, formatStatus, isLightStale, lightCap, lightLaneDecision, lightLeaseDir,
  lightSkip, lightWaitMessage, readTickets, snapshot, sweepLightLeases, writeTicket,
  // @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
} from '../../scripts/dev/heavy-queue-core.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60_000;
const alive = () => true;

interface Lease {
  id: string; pid: number; childPid?: number | null; kind: string; who: string; cwd: string;
  joinedAtMs: number; startedAtMs: number | null;
}
const lease = (id: string, joinedAtMs: number, startedAtMs: number | null, extra: Partial<Lease> = {}): Lease =>
  ({ id, pid: 1000, childPid: null, kind: 'typecheck', who: id, cwd: `/wt/${id}`, joinedAtMs, startedAtMs, ...extra });

describe('skips and cap', () => {
  it('CI, a queued heavy job and EQX_LIGHT_SKIP run straight; nothing else does', () => {
    expect(lightSkip({ CI: 'true' })).toBe('ci');
    expect(lightSkip({ EQX_HEAVY_QUEUE: 'abc' })).toBe('queued');
    expect(lightSkip({ EQX_LIGHT_SKIP: '1' })).toBe('skip');
    expect(lightSkip({ EQX_LIGHT_SKIP: '0' })).toBeNull();
    expect(lightSkip({})).toBeNull();
  });

  it('EQX_LIGHT_CAP defaults to 2 and ignores junk', () => {
    expect(DEFAULT_LIGHT_CAP).toBe(2);
    expect(lightCap({})).toBe(2);
    expect(lightCap({ EQX_LIGHT_CAP: '3' })).toBe(3);
    expect(lightCap({ EQX_LIGHT_CAP: '0' })).toBe(2);
    expect(lightCap({ EQX_LIGHT_CAP: 'x' })).toBe(2);
  });
});

describe('lightLaneDecision', () => {
  const now = T0 + 5 * MIN;

  it('a free slot: go', () => {
    const leases = [lease('a', T0, T0), lease('me', now, null)];
    expect(lightLaneDecision({ meId: 'me', leases, cap: 2, now, isAlive: alive }))
      .toMatchObject({ go: true, reason: 'free-slot' });
  });

  it('both slots busy: wait, and the message names who holds them', () => {
    const leases = [lease('a', T0, T0, { who: 'weapon-cuts' }), lease('b', T0 + MIN, T0 + MIN, { who: 'salvage', kind: 'lint' }), lease('me', now, null)];
    const d = lightLaneDecision({ meId: 'me', leases, cap: 2, now, isAlive: alive });
    expect(d).toMatchObject({ go: false, reason: 'busy' });
    expect(d.holders.map((l: Lease) => l.id)).toEqual(['a', 'b']);
    const msg = lightWaitMessage({ kind: 'typecheck', holders: d.holders, cap: 2, now });
    expect(msg).toContain('typecheck lane busy (2/2): waiting…');
    expect(msg).toMatch(/weapon-cuts +typecheck +running 5m00s/);
    expect(msg).toMatch(/salvage +lint +running 4m00s/);
    expect(lightLaneDecision({ meId: 'me', leases, cap: 3, now, isAlive: alive }).go).toBe(true);
  });

  it('waiters go first-come first-served: of two racers for one slot the later waits', () => {
    const leases = [lease('a', T0, T0), lease('w1', now, null), lease('w2', now + 1, null)];
    expect(lightLaneDecision({ meId: 'w1', leases, cap: 2, now, isAlive: alive }).go).toBe(true);
    expect(lightLaneDecision({ meId: 'w2', leases, cap: 2, now, isAlive: alive }))
      .toMatchObject({ go: false, reason: 'queued', position: 2 });
  });

  it('a dead holder frees its slot (wrapper and child both gone)', () => {
    const leases = [lease('a', T0, T0, { pid: 1, childPid: 2 }), lease('b', T0, T0, { pid: 7 }), lease('me', now, null, { pid: 9 })];
    const isAlive = (pid: number) => pid !== 1 && pid !== 2;
    expect(lightLaneDecision({ meId: 'me', leases, cap: 2, now, isAlive })).toMatchObject({ go: true });
    // Child still alive: the slot stays taken.
    const childLives = (pid: number) => pid !== 1;
    expect(lightLaneDecision({ meId: 'me', leases, cap: 2, now, isAlive: childLives })).toMatchObject({ go: false });
  });

  it('a holder past 20 min stops blocking; a long WAIT is never stale', () => {
    const late = T0 + LIGHT_STALE_MS + 1;
    const leases = [lease('hung', T0, T0), lease('b', late - MIN, late - MIN), lease('me', late, null)];
    expect(LIGHT_STALE_MS).toBe(20 * MIN);
    expect(isLightStale(leases[0], late, alive)).toBe(true);
    expect(isLightStale(leases[0], T0 + LIGHT_STALE_MS, alive)).toBe(false);
    expect(isLightStale(lease('w', T0, null), T0 + 60 * MIN, alive)).toBe(false);
    expect(lightLaneDecision({ meId: 'me', leases, cap: 2, now: late, isAlive: alive })).toMatchObject({ go: true });
  });
});

describe('light lease sweep + status', () => {
  let qdir: string;
  let dir: string;
  beforeEach(() => { qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-lane-')); dir = lightLeaseDir(qdir); });
  afterEach(() => { fs.rmSync(qdir, { recursive: true, force: true }); });

  it('sweeps dead and stale leases only (files, never processes)', () => {
    const now = T0 + 30 * MIN;
    writeTicket(dir, lease('live', T0 + 25 * MIN, T0 + 25 * MIN, { pid: process.pid, who: 'mine' }));
    writeTicket(dir, lease('dead', T0, T0, { pid: 2 ** 30, childPid: 2 ** 30 + 1 }));
    writeTicket(dir, lease('hung', T0, T0, { pid: process.pid }));
    const removed = sweepLightLeases(dir, { now });
    expect(removed.map((l: Lease) => l.id).sort()).toEqual(['dead', 'hung']);
    expect(readTickets(dir).map((l: Lease) => l.id)).toEqual(['live']);
  });

  it('`pnpm heavy status` lists who, what and how long', () => {
    writeTicket(dir, lease('a', T0, T0 + MIN, { who: 'weapon-cuts', kind: 'lint' }));
    writeTicket(dir, lease('b', T0 + 2 * MIN, null, { who: 'salvage' }));
    const snap = snapshot(qdir, T0 + 4 * MIN);
    expect(snap.light).toHaveLength(2);
    const out = formatStatus(snap);
    expect(out).toContain('light lane (typecheck / lint):');
    expect(out).toMatch(/weapon-cuts +lint +running 3m00s/);
    expect(out).toMatch(/salvage +typecheck +waiting 2m00s/);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(formatStatus(snapshot(qdir, T0))).toContain('light lane: (none)');
  });
});
