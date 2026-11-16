import { describe, expect, it } from 'vitest';
import type { GameClock } from '../../core/clock/GameClock.js';
import { FIELD_WAKES_PER_TICK } from '../../core/terrain/chunkStreamer.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { CutFieldSubsystem, toRestFrame } from './CutFieldSubsystem.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

function setup(recs: Record<string, Partial<SwarmEntityRecord>>) {
  const posted: WorkerCmd[] = [];
  const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
  const registry = { get: (id: string) => (recs[id] as SwarmEntityRecord | undefined) ?? null, all: () => [] } as unknown as SwarmEntityRegistry;
  const sub = new CutFieldSubsystem('t', clock, registry, {} as SwarmSpawner, {
    shipSlots: () => [], sab: () => new Float32Array(0), post: (c) => posted.push(c), evict: () => {},
  });
  return { sub, posted };
}

describe('CutFieldSubsystem.wakeRock (a mining laser waking a field rock)', () => {
  it('wakes a sleeping field rock once and unfixes its body', () => {
    const recs: Record<string, Partial<SwarmEntityRecord>> = { r: { fieldRock: true } };
    const { sub, posted } = setup(recs);
    expect(sub.wakeRock('r', 'laser', 1)).toBe(true);
    expect(recs['r']!.fieldAwake).toBe(true);
    expect(sub.wakeRock('r', 'laser', 1)).toBe(true);
    expect(posted).toEqual([{ type: 'UNFIX_BODY', entityId: 'r' }]);
  });

  it('refuses anything that is not a field rock', () => {
    const { sub, posted } = setup({ a: {} });
    expect(sub.wakeRock('a', 'laser', 1)).toBe(false);
    expect(sub.wakeRock('missing', 'laser', 1)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('shares the per-tick wake cap, and the next tick wakes again', () => {
    const recs: Record<string, Partial<SwarmEntityRecord>> = {};
    for (let i = 0; i <= FIELD_WAKES_PER_TICK; i++) recs[`r${i}`] = { fieldRock: true };
    const { sub } = setup(recs);
    for (let i = 0; i < FIELD_WAKES_PER_TICK; i++) expect(sub.wakeRock(`r${i}`, 'laser', 5)).toBe(true);
    expect(sub.wakeRock(`r${FIELD_WAKES_PER_TICK}`, 'laser', 5)).toBe(false);
    expect(sub.wakeRock(`r${FIELD_WAKES_PER_TICK}`, 'laser', 6)).toBe(true);
  });
});

describe('toRestFrame (F1b: an awake rock samples its ore where it was cut)', () => {
  it('maps a point on a moved, turned rock back onto the same spot of the rock as cut', () => {
    const rest = { x: 1_000, y: -500 }, local = { x: 30, y: -12 };
    const pose = { x: 1_340, y: -260 }, a = 0.9;
    // The point `local` on the rock, in the world after the rock moved and turned by `a`.
    const wx = pose.x + local.x * Math.cos(a) - local.y * Math.sin(a);
    const wy = pose.y + local.x * Math.sin(a) + local.y * Math.cos(a);
    const p = toRestFrame(rest.x, rest.y, pose.x, pose.y, a, wx, wy, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(rest.x + local.x, 9);
    expect(p.y).toBeCloseTo(rest.y + local.y, 9);
  });

  it('is the identity for a rock still at rest', () => {
    expect(toRestFrame(5, 6, 5, 6, 0, 17, -3, { x: 0, y: 0 })).toEqual({ x: 17, y: -3 });
  });
});

describe('CutFieldSubsystem change record (mined pool, consumed rocks)', () => {
  /** A real streamer over a fake spawner: one ship in the `look` field's lane,
   *  flown away (its chunks unload after the linger) and back (they re-cut). */
  function field() {
    let now = 0;
    const recs = new Map<string, SwarmEntityRecord>();
    const sab = new Float32Array(slotBase(1));
    const clock = { now: () => now, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
    const registry = { get: (id: string) => recs.get(id) ?? null, all: () => [] } as unknown as SwarmEntityRegistry;
    const spawner = {
      spawnAsteroid: (a: { id: string; fieldKey: number }) => {
        recs.set(a.id, { id: a.id, fieldRock: true, fieldKey: a.fieldKey, resources: 100, resourcesMax: 100 } as SwarmEntityRecord);
        return true;
      },
    } as unknown as SwarmSpawner;
    const sub = new CutFieldSubsystem('look', clock, registry, spawner, {
      shipSlots: () => [0], sab: () => sab, post: () => {}, evict: (rec) => { recs.delete(rec.id); },
    });
    const at = (x: number, y: number) => { sab[slotBase(0) + SLOT_X_OFF] = x; sab[slotBase(0) + SLOT_Y_OFF] = y; };
    const settle = () => { for (let i = 0; i < 40; i++) sub.streamer.step(); };
    /** Fly away until everything unloads, then come back and re-cut. */
    const awayAndBack = () => {
      at(9e6, 9e6); now += 60_000; settle();
      expect(recs.size, 'all chunks unloaded').toBe(0);
      at(-30_120, 26_501); now += 1; settle();
    };
    at(-30_120, 26_501); settle();
    return { sub, recs, awayAndBack };
  }

  it('a mined rock keeps what is left in it across an unload and re-cut', () => {
    const { recs, awayAndBack } = field();
    const [mined, untouched] = [...recs.values()];
    expect(mined && untouched).toBeTruthy();
    mined!.resources = 37;
    awayAndBack();
    expect(recs.get(mined!.id)!.resources).toBe(37);
    expect(recs.get(untouched!.id)!.resources).toBe(100);
  });

  it('a consumed rock is never cut whole again', () => {
    const { sub, recs, awayAndBack } = field();
    const gone = [...recs.values()][0]!;
    sub.markConsumed(gone.fieldKey!);
    expect(sub.isConsumed(gone.fieldKey!)).toBe(true);
    const before = recs.size;
    awayAndBack();
    expect(recs.has(gone.id)).toBe(false);
    expect(recs.size).toBe(before - 1);
  });
});
