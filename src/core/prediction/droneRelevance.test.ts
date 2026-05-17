/**
 * Option A (2026-05-17, diag a3f5na) unit lock — two halves:
 *
 *  1. `partitionDronesByRelevance` is a pure, deterministic split: hostile OR
 *     within-radius OR recently-large-corrected ⇒ NEAR (re-sim during replay);
 *     everything else ⇒ FAR (frozen at the replay anchor).
 *  2. `AiController.tick`'s optional `shouldTick` gate skips exactly the
 *     filtered-out entities with NO behaviour mutation, and omitting it is
 *     observably identical to passing an always-true predicate (back-compat —
 *     the per-frame live loop must be byte-identical to pre-Option-A).
 *
 * The end-to-end scaling win is locked separately + host-robustly in
 * `tests/integration/reconcilerReplayScaling.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  partitionDronesByRelevance,
  DRONE_RELEVANCE_RADIUS,
  DRONE_SNAP_RELEVANCE_U,
  DRONE_RESIM_BUDGET,
  type DroneRelevanceInput,
} from './droneRelevance.js';
import { HITSCAN_RANGE } from '../combat/Weapons.js';
import { AiController, type AiIntentSink } from '../ai/AiController.js';
import { HostileDroneBehaviour } from '../ai/HostileDroneBehaviour.js';
import type { AiEntity, AiPlayerView } from '../contracts/IAiBehaviour.js';

describe('partitionDronesByRelevance', () => {
  const opts = { playerX: 0, playerY: 0 };

  it('derives the default radius from the catalogue HITSCAN_RANGE (no magic number)', () => {
    expect(DRONE_RELEVANCE_RADIUS).toBe(HITSCAN_RANGE * 2);
  });

  it('a drone within the radius is NEAR (non-hostile, no snap)', () => {
    const d: DroneRelevanceInput = {
      id: '1',
      x: DRONE_RELEVANCE_RADIUS - 1,
      y: 0,
      hostile: false,
    };
    const { near, far } = partitionDronesByRelevance([d], opts);
    expect(near.has('1')).toBe(true);
    expect(far).toHaveLength(0);
  });

  it('a far, non-hostile, non-diverging drone is FAR', () => {
    const d: DroneRelevanceInput = {
      id: '2',
      x: DRONE_RELEVANCE_RADIUS + 1,
      y: 0,
      hostile: false,
    };
    const { near, far } = partitionDronesByRelevance([d], opts);
    expect(near.size).toBe(0);
    expect(far).toEqual(['2']);
  });

  it('a hostile drone is NEAR regardless of distance', () => {
    const d: DroneRelevanceInput = {
      id: '3',
      x: 1_000_000,
      y: 1_000_000,
      hostile: true,
    };
    const { near, far } = partitionDronesByRelevance([d], opts);
    expect(near.has('3')).toBe(true);
    expect(far).toHaveLength(0);
  });

  it('a far drone whose last snap exceeded the threshold is NEAR; below it is FAR', () => {
    const diverging: DroneRelevanceInput = {
      id: 'div',
      x: DRONE_RELEVANCE_RADIUS + 5000,
      y: 0,
      hostile: false,
      lastSnapDist: DRONE_SNAP_RELEVANCE_U + 0.01,
    };
    const stable: DroneRelevanceInput = {
      id: 'stab',
      x: DRONE_RELEVANCE_RADIUS + 5000,
      y: 0,
      hostile: false,
      lastSnapDist: DRONE_SNAP_RELEVANCE_U - 0.01,
    };
    const { near, far } = partitionDronesByRelevance([diverging, stable], opts);
    expect(near.has('div')).toBe(true);
    expect(far).toEqual(['stab']);
  });

  it('Infinity-coord no-anchor sentinel is always FAR (the client no-anchor path)', () => {
    const noAnchor: DroneRelevanceInput = {
      id: 'na',
      x: Infinity,
      y: Infinity,
      hostile: false,
    };
    const { near, far } = partitionDronesByRelevance([noAnchor], opts);
    expect(near.size).toBe(0);
    expect(far).toEqual(['na']);
  });

  it('respects custom radius / snapThreshold overrides', () => {
    const d: DroneRelevanceInput = { id: 'x', x: 50, y: 0, hostile: false };
    expect(partitionDronesByRelevance([d], { ...opts, radius: 40 }).far).toEqual(['x']);
    expect(partitionDronesByRelevance([d], { ...opts, radius: 60 }).near.has('x')).toBe(true);
  });

  it('empty input ⇒ empty partition; far preserves iteration order', () => {
    expect(partitionDronesByRelevance([], opts)).toEqual({ near: new Set(), far: [] });
    const far3: DroneRelevanceInput[] = ['a', 'b', 'c'].map((id) => ({
      id,
      x: DRONE_RELEVANCE_RADIUS + 1,
      y: 0,
      hostile: false,
    }));
    expect(partitionDronesByRelevance(far3, opts).far).toEqual(['a', 'b', 'c']);
  });
});

/**
 * In-pack re-sim budget (k-cap), diag m6rq2t 2026-05-17. Option A's radius
 * cull gives ZERO relief in a melee: when the player is inside the bot pack
 * every drone is hostile/near, so NEAR≈ALL and per-snapshot reconcile is
 * O(replayWindow × N) — as the client's snapshot-handle interval slows the
 * window grows, work grows, handling slows further → the progressive
 * combat-lag spiral that killed the player BEFORE death. Completing Option A
 * with a hard per-snapshot re-sim BUDGET bounds it: tick-accurately re-sim
 * only the K most-relevant (hostile, then closest); dead-reckon the rest
 * (Option A already established that's visually fine for non-engaged
 * drones). Per-snapshot cost → O(replayWindow × K), K bounded regardless of
 * pack size → no spiral, scales to the 500-objects/sector target.
 *
 * Default-ON (an unbounded re-sim IS the bug); BYTE-IDENTICAL when
 * NEAR ≤ K, so steady-state + chapter-2 lockstep + the feel-test-lockstep
 * canary are untouched (only the in-pack pathological case changes).
 */
describe('partitionDronesByRelevance — in-pack re-sim budget (k-cap)', () => {
  const opts = { playerX: 0, playerY: 0 };

  it('exports a sane default budget; it is the cap when maxResim is omitted', () => {
    expect(DRONE_RESIM_BUDGET).toBeGreaterThan(0);
    expect(DRONE_RESIM_BUDGET).toBeLessThan(30); // must bound an in-pack melee (~26)
  });

  it('FAILING-FIRST: 30 all-near drones must NOT all be re-simmed — capped to the budget', () => {
    // In-pack melee: 30 drones all well inside the radius (all NEAR).
    // Pre-fix: near.size === 30 (the spiral). Fixed: capped at the budget.
    const drones: DroneRelevanceInput[] = [];
    for (let i = 0; i < 30; i++) {
      drones.push({ id: `d${i}`, x: 100 + i, y: 0, hostile: false });
    }
    const { near, far } = partitionDronesByRelevance(drones, { ...opts, maxResim: 12 });
    expect(near.size).toBe(12);
    expect(far.length).toBe(18); // the 18 demoted overflow dead-reckon
    // The kept 12 are the CLOSEST 12 (ids d0..d11 — x = 100..111).
    for (let i = 0; i < 12; i++) expect(near.has(`d${i}`)).toBe(true);
    for (let i = 12; i < 30; i++) expect(near.has(`d${i}`)).toBe(false);
  });

  it('hostile drones win the budget over closer non-hostile (you perceive who shoots you)', () => {
    const drones: DroneRelevanceInput[] = [
      { id: 'close-passive', x: 1, y: 0, hostile: false },
      { id: 'close-passive2', x: 2, y: 0, hostile: false },
      { id: 'far-hostile', x: 900, y: 0, hostile: true },
    ];
    const { near } = partitionDronesByRelevance(drones, { ...opts, maxResim: 2 });
    expect(near.size).toBe(2);
    expect(near.has('far-hostile')).toBe(true); // hostile prioritised
    expect(near.has('close-passive')).toBe(true); // then closest non-hostile
    expect(near.has('close-passive2')).toBe(false);
  });

  it('is deterministic under equidistant ties (id tiebreak — no frame-to-frame flicker)', () => {
    const drones: DroneRelevanceInput[] = ['z', 'a', 'm', 'b'].map((id) => ({
      id, x: 100, y: 0, hostile: false, // all equidistant
    }));
    const a = partitionDronesByRelevance(drones, { ...opts, maxResim: 2 });
    const b = partitionDronesByRelevance([...drones].reverse(), { ...opts, maxResim: 2 });
    expect([...a.near].sort()).toEqual([...b.near].sort()); // input-order-independent
    expect(a.near.has('a')).toBe(true);
    expect(a.near.has('b')).toBe(true); // 'a','b' are the lowest ids
  });

  it('BYTE-IDENTICAL when NEAR ≤ budget (steady-state / canary untouched)', () => {
    const drones: DroneRelevanceInput[] = [
      { id: '1', x: 10, y: 0, hostile: false },
      { id: '2', x: DRONE_RELEVANCE_RADIUS + 1, y: 0, hostile: false }, // far
      { id: '3', x: 20, y: 0, hostile: true },
    ];
    const capped = partitionDronesByRelevance(drones, { ...opts, maxResim: 12 });
    const uncapped = partitionDronesByRelevance(drones, { ...opts, maxResim: Infinity });
    expect([...capped.near].sort()).toEqual([...uncapped.near].sort());
    expect(capped.far).toEqual(uncapped.far);
    expect(capped.near.has('1')).toBe(true);
    expect(capped.near.has('3')).toBe(true);
    expect(capped.far).toEqual(['2']);
  });
});

interface PostedIntent {
  slot: number;
  fx: number;
  fy: number;
  torque: number;
}
class CapturingSink implements AiIntentSink {
  posted: PostedIntent[] = [];
  postIntent(slot: number, fx: number, fy: number, torque: number): void {
    this.posted.push({ slot, fx, fy, torque });
  }
}
const playerAt = (id: string, x: number, y: number): AiPlayerView => ({ id, x, y, vx: 0, vy: 0 });
const entityAt = (id: string, x: number, y: number): AiEntity => ({
  id,
  x,
  y,
  vx: 0,
  vy: 0,
  angle: 0,
  angvel: 0,
});

describe('AiController.tickOnly (Option A relevance-culled replay re-sim)', () => {
  let sink: CapturingSink;
  let ctrl: AiController;
  const snap = (id: string): AiEntity | null => {
    if (id === 'a') return entityAt(id, 0, 0);
    if (id === 'b') return entityAt(id, 50, 0);
    if (id === 'c') return entityAt(id, -50, 0);
    return null;
  };

  beforeEach(() => {
    sink = new CapturingSink();
    ctrl = new AiController(sink);
    ctrl.register('a', 1, new HostileDroneBehaviour());
    ctrl.register('b', 2, new HostileDroneBehaviour());
    ctrl.register('c', 3, new HostileDroneBehaviour());
  });

  it('tick() still ticks every registered entity (live loop unchanged)', () => {
    ctrl.tick(0, 1 / 60, [playerAt('p', 0, 100)], snap);
    expect(sink.posted.map((p) => p.slot).sort()).toEqual([1, 2, 3]);
  });

  it('tickOnly ticks exactly the supplied ids; the rest are untouched', () => {
    ctrl.tickOnly(['b'], 0, 1 / 60, [playerAt('p', 0, 100)], snap);
    expect(sink.posted).toHaveLength(1);
    expect(sink.posted[0]!.slot).toBe(2);
  });

  it('tickOnly is per-entity identical to tick for the same membership', () => {
    ctrl.tick(0, 1 / 60, [playerAt('p', 0, 100)], snap);
    const viaTick = JSON.stringify([...sink.posted].sort((x, y) => x.slot - y.slot));

    const sink2 = new CapturingSink();
    const ctrl2 = new AiController(sink2);
    ctrl2.register('a', 1, new HostileDroneBehaviour());
    ctrl2.register('b', 2, new HostileDroneBehaviour());
    ctrl2.register('c', 3, new HostileDroneBehaviour());
    ctrl2.tickOnly(['a', 'b', 'c'], 0, 1 / 60, [playerAt('p', 0, 100)], snap);
    const viaTickOnly = JSON.stringify([...sink2.posted].sort((x, y) => x.slot - y.slot));
    expect(viaTickOnly).toEqual(viaTick);
  });

  it('tickOnly skips unknown / unregistered ids without throwing', () => {
    ctrl.tickOnly(['b', 'does-not-exist'], 0, 1 / 60, [playerAt('p', 0, 100)], snap);
    expect(sink.posted.map((p) => p.slot)).toEqual([2]);
  });

  it('tickOnly([]) is a clean no-op (no intents, no fires)', () => {
    ctrl.markHostile('a', 'p', 0);
    ctrl.tickOnly([], 100, 1 / 60, [playerAt('p', 0, 100)], snap);
    expect(sink.posted).toHaveLength(0);
    expect(ctrl.drainFireRequests()).toHaveLength(0);
  });

  it('excluding an entity does not advance its behaviour state', () => {
    // 'a' is hostile and would fire at tick 100. Excluding it from a
    // tickOnly at 100 must not consume its fire opportunity: a later
    // tickOnly(['a'], 100) still fires (lastFireTick was never advanced).
    ctrl.markHostile('a', 'p', 0);
    ctrl.tickOnly(['b'], 100, 1 / 60, [playerAt('p', 0, 100)], snap);
    expect(ctrl.drainFireRequests()).toHaveLength(0);
    ctrl.tickOnly(['a'], 100, 1 / 60, [playerAt('p', 0, 100)], snap);
    expect(ctrl.drainFireRequests().some((f) => f.shooterId === 'a')).toBe(true);
  });
});
