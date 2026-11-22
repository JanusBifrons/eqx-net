/**
 * Missile detonation waits for the drawn missile (off-pilot event timing,
 * slice 3/6). `missile_detonated` carries no tick; the missile is drawn on the
 * missile stream's display delay, so the old "remove at once, blast at the
 * server point" made the drawn missile vanish mid-flight with the blast ahead
 * of it. Now the missile keeps flying until the missile read point reaches
 * the newest snapshot tick at arrival, then explodes once at the detonation
 * point. Mock clocks only: the real per-frame steps, driven by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderMirror } from '../../core/contracts/IRenderer';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages';
import {
  applyMissileSnapshot, clearMissileDetonations, holdMissileDetonation,
  resetMissileDisplayDelay, resolveMissileDisplayPose, stepMissileDisplayDelay,
} from './MissileMirror';
import { STAMPED_HOLD_MARGIN_MS, matchedHoldMs } from '../net/navalHitHold.js';
import {
  noteSwarmStreamStamp, resetSwarmDisplayDelay, resetSwarmTickClock, setSwarmDisplayDelayMode,
  setSwarmDisplayDelayMs, setSwarmDisplaySpeed, stepSwarmDisplayDelay, swarmArrivalStampMs,
} from '../net/swarmInterpolation.js';

const FRAME_MS = 1000 / 60;
const TICK_MS = 1000 / 60;
const START_MS = 1000;
const LINK_MS = 40;
/** Missiles ride every third tick (the JSON snapshot cadence). */
const JSON_EVERY = 3;
/** 5 u a tick = 300 u/s along +x. */
const U_PER_TICK = 5;
const ID = 7;
const SPLASH = 40;

function slice(tick: number): NonNullable<SnapshotMessage['missiles']> {
  return [{
    id: ID, x: tick * U_PER_TICK, y: 0, vx: U_PER_TICK * 60, vy: 0, angle: 0, angvel: 0,
    ownerId: 'player-a', weaponId: 'heat-seeker', lifePct: 1,
  }];
}

interface Run {
  /** Wall ms the detonation event arrived. */
  arrivedMs: number;
  /** Wall ms (frame) the explosion was queued, NaN if never. */
  explodedMs: number;
  explosions: Array<{ x: number; y: number; splashRadius: number; missileId: number }>;
  /** Drawn x on the last frame the missile was drawn. */
  lastDrawnX: number;
  /** Frames the missile was still drawn after the event arrived. */
  drawnAfterEvent: number;
  /** Largest backwards step of the drawn x (a snap back). */
  maxBackStep: number;
  delayAtEventMs: number;
}

/**
 * The missile flies; the server detonates it at `detTick` (x = detTick·5) and
 * the event arrives in the same flush as that tick's snapshot (no missile in
 * the slice). Off pilot the delay is sized by a link outage early on.
 */
function run(mode: 'pilot' | 'offPilot', pilotDelayMs: number, detTick: number, opts: {
  /** Ticks sent in [startMs, endMs) (rel) are lost on both streams. */
  outage?: { startMs: number; endMs: number };
  /** Right after the event: forget the drone tick clock and stop every
   *  stream (no read point any more). */
  dropTimelineAfterEvent?: boolean;
  durationMs?: number; afterEvent?: (mirror: RenderMirror, now: number) => void;
} = {}): Run {
  setSwarmDisplayDelayMode(mode);
  setSwarmDisplayDelayMs(pilotDelayMs);
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const out: Run = {
    arrivedMs: Number.NaN, explodedMs: Number.NaN, explosions: [], lastDrawnX: Number.NaN,
    drawnAfterEvent: 0, maxBackStep: 0, delayAtEventMs: Number.NaN,
  };
  let tick = 0;
  let prevX = Number.NaN;
  const durationMs = opts.durationMs ?? detTick * TICK_MS + 6000;
  for (let f = 1; f * FRAME_MS <= durationMs; f++) {
    const rel = f * FRAME_MS;
    const now = START_MS + rel;
    while (tick * TICK_MS + LINK_MS <= rel) {
      const sentMs = tick * TICK_MS;
      const lost = (opts.outage !== undefined && sentMs >= opts.outage.startMs && sentMs < opts.outage.endMs)
        || (opts.dropTimelineAfterEvent === true && tick > detTick);
      if (lost) { tick++; continue; }
      noteSwarmStreamStamp(100 + tick, swarmArrivalStampMs(100 + tick, now));
      if (tick % JSON_EVERY === 0) {
        applyMissileSnapshot(tick < detTick ? slice(tick) : [], mirror, 100 + tick, now);
      }
      if (tick === detTick) {
        out.arrivedMs = now;
        out.delayAtEventMs = mirror.swarmDisplayDelayMs ?? Number.NaN;
        holdMissileDetonation(mirror, ID, detTick * U_PER_TICK, 0, SPLASH, now);
        opts.afterEvent?.(mirror, now);
        if (opts.dropTimelineAfterEvent === true) resetSwarmTickClock();
      }
      tick++;
    }
    stepSwarmDisplayDelay(FRAME_MS, now);
    stepMissileDisplayDelay(mirror, FRAME_MS, now);
    const pending = mirror.pendingMissileExplosions;
    if (pending && pending.length > 0) {
      for (const e of pending) out.explosions.push({ ...e });
      if (Number.isNaN(out.explodedMs)) out.explodedMs = now;
      pending.length = 0;
    }
    const pose = resolveMissileDisplayPose(mirror, ID, now);
    if (pose) {
      if (!Number.isNaN(prevX)) out.maxBackStep = Math.max(out.maxBackStep, prevX - pose.x);
      prevX = pose.x;
      out.lastDrawnX = pose.x;
      if (!Number.isNaN(out.arrivedMs)) out.drawnAfterEvent++;
    }
  }
  return out;
}

describe('MissileMirror — detonation waits for the drawn missile', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    resetSwarmDisplayDelay();
    resetMissileDisplayDelay();
    setSwarmDisplaySpeed(1);
  });
  afterEach(() => {
    resetSwarmTickClock();
    resetSwarmDisplayDelay();
    resetMissileDisplayDelay();
    setSwarmDisplayDelayMode('pilot');
    setSwarmDisplaySpeed(1);
  });

  // Detonation 10 s in: the delay has long settled at its target.
  const DET_TICK = 600;
  const DET_X = DET_TICK * U_PER_TICK;
  /** Off pilot: a 1.9 s outage at 1 s sizes the delay to ~2 s (gap + margin). */
  const OUTAGE = { startMs: 1000, endMs: 2900 };

  const CASES = [
    { label: 'piloting, drawn 150 ms behind', mode: 'pilot', outage: undefined, lo: 140, hi: 160 },
    { label: 'off pilot, drawn 2 s behind', mode: 'offPilot', outage: OUTAGE, lo: 1900, hi: 2100 },
  ] as const;

  for (const c of CASES) {
    it(`${c.label}: flies on until the read point reaches it, then explodes once at the detonation point`, () => {
      const r = run(c.mode, 150, DET_TICK, { outage: c.outage });
      expect(r.delayAtEventMs).toBeGreaterThanOrEqual(c.lo);
      expect(r.delayAtEventMs).toBeLessThanOrEqual(c.hi);
      // Exactly one blast, at the server's detonation point, full size.
      expect(r.explosions).toEqual([{ x: DET_X, y: 0, splashRadius: SPLASH, missileId: ID }]);
      // Not on arrival: one display delay later (the stamp is the arrival
      // tick, so the read point reaches it `delay` after arrival).
      const waitedMs = r.explodedMs - r.arrivedMs;
      expect(waitedMs).toBeGreaterThanOrEqual(r.delayAtEventMs - FRAME_MS);
      expect(waitedMs).toBeLessThanOrEqual(r.delayAtEventMs + FRAME_MS);
      // The missile was drawn right up to the blast, arriving at the point,
      // never stepping back.
      expect(r.drawnAfterEvent).toBeGreaterThanOrEqual(Math.floor(r.delayAtEventMs / FRAME_MS) - 1);
      expect(Math.abs(r.lastDrawnX - DET_X)).toBeLessThanOrEqual(U_PER_TICK * 2);
      expect(r.maxBackStep).toBe(0);
    });

    it(`${c.label}: with no read point any more it is released at the deadline`, () => {
      const r = run(c.mode, 150, DET_TICK, { outage: c.outage, dropTimelineAfterEvent: true });
      const holdMs = Math.min(r.delayAtEventMs + STAMPED_HOLD_MARGIN_MS, matchedHoldMs(c.mode === 'offPilot'));
      expect(r.explosions).toEqual([{ x: DET_X, y: 0, splashRadius: SPLASH, missileId: ID }]);
      const waitedMs = r.explodedMs - r.arrivedMs;
      expect(waitedMs).toBeGreaterThanOrEqual(holdMs);
      expect(waitedMs).toBeLessThanOrEqual(holdMs + FRAME_MS);
    });
  }

  it('a welcome / sector change clears a held detonation: no blast, missile gone', () => {
    let missilesAfterClear = -1;
    const r = run('offPilot', 150, DET_TICK, {
      outage: OUTAGE,
      afterEvent: (mirror) => {
        clearMissileDetonations(mirror);
        missilesAfterClear = mirror.missiles?.size ?? 0;
      },
    });
    expect(missilesAfterClear).toBe(0);
    expect(r.explosions).toEqual([]);
    expect(r.drawnAfterEvent).toBe(0);
  });

  it('clearing leaves missiles that have not detonated', () => {
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    applyMissileSnapshot(slice(0), mirror, 100, START_MS);
    clearMissileDetonations(mirror);
    expect(mirror.missiles?.has(ID)).toBe(true);
  });

  it('before the drone tick clock seeds (or for an unknown missile) it explodes at once', () => {
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    applyMissileSnapshot(slice(0), mirror, 100, START_MS);
    holdMissileDetonation(mirror, ID, 12, 34, SPLASH, START_MS);
    expect(mirror.missiles?.has(ID)).toBe(false);
    holdMissileDetonation(mirror, 99, 1, 2, SPLASH, START_MS);
    expect(mirror.pendingMissileExplosions).toEqual([
      { x: 12, y: 34, splashRadius: SPLASH, missileId: ID },
      { x: 1, y: 2, splashRadius: SPLASH, missileId: 99 },
    ]);
  });
});
