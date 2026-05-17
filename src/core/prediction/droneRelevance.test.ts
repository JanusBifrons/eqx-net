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
