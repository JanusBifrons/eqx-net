/**
 * A fence that stops a missile (`wall_hit`, kind `missile`) flashes with the
 * missile's held detonation, not on arrival (off-pilot event timing, slice
 * 4b/6): same stamp, same per-frame release against the missile read point.
 * A bolt's `wall_hit` shows at once. Mock clocks: the real per-frame steps,
 * driven by hand (as `MissileMirror.detonation.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '../../core/contracts/IRenderer';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages';
import {
  applyMissileSnapshot, clearMissileDetonations, holdMissileDetonation, resetMissileDisplayDelay,
  stepMissileDisplayDelay,
} from './MissileMirror';
import { clearWallHits, heldWallHitCount } from './missileWallHits';
import { registerImpactFxHandlers } from '../net/handlers/impactFxHandlers';
import {
  noteSwarmStreamStamp, resetSwarmDisplayDelay, resetSwarmTickClock, setSwarmDisplayDelayMode,
  setSwarmDisplayDelayMs, setSwarmDisplaySpeed, stepSwarmDisplayDelay, swarmArrivalStampMs,
} from '../net/swarmInterpolation.js';

const FRAME_MS = 1000 / 60;
const TICK_MS = 1000 / 60;
const START_MS = 1000;
const LINK_MS = 40;
const ID = 7;
const DET_TICK = 600;
const WALL_X = DET_TICK * 5 + 2;

function slice(tick: number): NonNullable<SnapshotMessage['missiles']> {
  return [{
    id: ID, x: tick * 5, y: 0, vx: 300, vy: 0, angle: 0, angvel: 0,
    ownerId: 'player-a', weaponId: 'heat-seeker', lifePct: 1,
  }];
}

/** A `wall_hit` handler wired to `mirror` (the real one). */
function wallHitHandler(mirror: RenderMirror, now: () => number): (msg: unknown) => void {
  let cb: (msg: unknown) => void = () => {};
  const room = {
    onMessage: (type: string, fn: (msg: unknown) => void) => { if (type === 'wall_hit') cb = fn; },
  } as unknown as Room;
  registerImpactFxHandlers(room, { mirror, now, holdBlastWithHit: () => false });
  return cb;
}

interface Run { arrivedMs: number; wallHitMs: number; explodedMs: number; wallHits: number; delayMs: number }

/** The missile flies into a fence at DET_TICK: `wall_hit` then
 *  `missile_detonated` arrive with that tick's snapshot. */
function run(mode: 'pilot' | 'offPilot', opts: { outage?: { startMs: number; endMs: number }; clearAfter?: boolean } = {}): Run {
  setSwarmDisplayDelayMode(mode);
  setSwarmDisplayDelayMs(150);
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null, pendingEffectTriggers: [] };
  let now = START_MS;
  const onWallHit = wallHitHandler(mirror, () => now);
  const out: Run = { arrivedMs: Number.NaN, wallHitMs: Number.NaN, explodedMs: Number.NaN, wallHits: 0, delayMs: Number.NaN };
  let tick = 0;
  for (let f = 1; f * FRAME_MS <= DET_TICK * TICK_MS + 6000; f++) {
    const rel = f * FRAME_MS;
    now = START_MS + rel;
    while (tick * TICK_MS + LINK_MS <= rel) {
      const sent = tick * TICK_MS;
      if (opts.outage !== undefined && sent >= opts.outage.startMs && sent < opts.outage.endMs) { tick++; continue; }
      noteSwarmStreamStamp(100 + tick, swarmArrivalStampMs(100 + tick, now));
      if (tick % 3 === 0) applyMissileSnapshot(tick < DET_TICK ? slice(tick) : [], mirror, 100 + tick, now);
      if (tick === DET_TICK) {
        out.arrivedMs = now;
        out.delayMs = mirror.swarmDisplayDelayMs ?? Number.NaN;
        onWallHit({ type: 'wall_hit', x: WALL_X, y: 0, kind: 'missile' });
        holdMissileDetonation(mirror, ID, DET_TICK * 5, 0, 40, now);
        if (opts.clearAfter === true) clearMissileDetonations(mirror);
      }
      tick++;
    }
    stepSwarmDisplayDelay(FRAME_MS, now);
    stepMissileDisplayDelay(mirror, FRAME_MS, now);
    const trig = mirror.pendingEffectTriggers!;
    if (trig.length > 0) {
      if (Number.isNaN(out.wallHitMs)) out.wallHitMs = now;
      out.wallHits += trig.length;
      trig.length = 0;
    }
    const ex = mirror.pendingMissileExplosions;
    if (ex && ex.length > 0) {
      if (Number.isNaN(out.explodedMs)) out.explodedMs = now;
      ex.length = 0;
    }
  }
  return out;
}

describe('missile wall_hit waits with its detonation', () => {
  beforeEach(() => {
    resetSwarmTickClock(); resetSwarmDisplayDelay(); resetMissileDisplayDelay(); clearWallHits();
    setSwarmDisplaySpeed(1);
  });
  afterEach(() => {
    resetSwarmTickClock(); resetSwarmDisplayDelay(); resetMissileDisplayDelay(); clearWallHits();
    setSwarmDisplayDelayMode('pilot'); setSwarmDisplaySpeed(1);
  });

  const CASES = [
    { label: 'piloting (150 ms)', mode: 'pilot', outage: undefined, lo: 140, hi: 160 },
    { label: 'off pilot (2 s)', mode: 'offPilot', outage: { startMs: 1000, endMs: 2900 }, lo: 1900, hi: 2100 },
  ] as const;

  for (const c of CASES) {
    it(`${c.label}: flashes once, the frame the drawn missile explodes`, () => {
      const r = run(c.mode, { outage: c.outage });
      expect(r.delayMs).toBeGreaterThanOrEqual(c.lo);
      expect(r.delayMs).toBeLessThanOrEqual(c.hi);
      expect(r.wallHits).toBe(1);
      expect(r.wallHitMs).toBe(r.explodedMs);
      expect(r.wallHitMs - r.arrivedMs).toBeGreaterThanOrEqual(r.delayMs - FRAME_MS);
      expect(heldWallHitCount()).toBe(0);
    });
  }

  it('a welcome / sector change drops it: no flash', () => {
    const r = run('offPilot', { outage: { startMs: 1000, endMs: 2900 }, clearAfter: true });
    expect(r.wallHits).toBe(0);
    expect(heldWallHitCount()).toBe(0);
  });

  it('a bolt flashes at once; a missile with no drawn missile or timeline too', () => {
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null, pendingEffectTriggers: [] };
    const onWallHit = wallHitHandler(mirror, () => START_MS);
    onWallHit({ type: 'wall_hit', x: 1, y: 2, kind: 'bolt' });
    onWallHit({ type: 'wall_hit', x: 3, y: 4, kind: 'missile' });
    expect(mirror.pendingEffectTriggers).toEqual([
      { kind: 'wall-hit', worldX: 1, worldY: 2 }, { kind: 'wall-hit', worldX: 3, worldY: 4 },
    ]);
    expect(heldWallHitCount()).toBe(0);
  });
});
