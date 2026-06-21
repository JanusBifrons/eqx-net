/**
 * Always-on defensive RANGE CIRCLES for built turrets (Phase 3 WS-D / PR3 / #21;
 * Invariant #13 — failing test FIRST).
 *
 * `weaponRange` (the structureKinds catalogue) was drawn ONLY during the
 * placement ghost. Built defence turrets now get a PERSISTENT range circle so the
 * player sees their coverage at a glance. Rules:
 *   - drawn for a BUILT structure whose kind has a `weaponRange` (turret /
 *     laser_bolt_turret / missile_turret) — NOT for a Miner (miningRange), a
 *     Capital, a Solar, etc.
 *   - radius = the kind's `weaponRange` (catalogue) — known client-side, no wire.
 *   - omitted for an UNBUILT blueprint (no coverage yet) and for out-of-interest
 *     structures (absent from the mirror entirely).
 *   - a distinct colour from the placement-preview range ring.
 *
 * Reads the REAL renderer-published count (`builtTurretRangeCount`) — the drawn
 * circles aren't headlessly inspectable (feedback-test-observable lesson). Before
 * the feature exists this FAILS: the field is undefined.
 */
import { describe, it, expect } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import {
  builtRangeCircleVisualParams,
  builtRangeCircleVisualInto,
  rangeCircleVisualParams,
  BUILT_RANGE_CIRCLE_COLOR,
  RANGE_CIRCLE_COLOR,
  type RingVisual,
} from './connectorVisual.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type {
  RenderMirror,
  SwarmRenderState,
  StructureRenderState,
} from '../../../core/contracts/IRenderer.js';

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0,
    radius: getStructureKind(shipKind).radius,
    kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState> = {}): StructureRenderState {
  return { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, ...over };
}

describe('ConnectorRenderer — built-turret range circles (WS-D #21)', () => {
  it('draws ONE range circle for a built turret, at its catalogue weaponRange', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, structureEntry('turret', 100, 200)]]);
    const structures = new Map<number, StructureRenderState>([[1, structureState({ built: true })]]);
    const mirror = { swarm, structures } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.builtTurretRangeCount).toBe(1);
    expect(r.lastBuiltTurretRangeRadius).toBe(getStructureKind('turret').weaponRange);
  });

  it('does NOT draw a range circle for an UNBUILT turret blueprint', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, structureEntry('turret', 0, 0)]]);
    const structures = new Map<number, StructureRenderState>([[1, structureState({ built: false, buildPct: 0.3 })]]);
    const mirror = { swarm, structures } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.builtTurretRangeCount).toBe(0);
  });

  it('does NOT draw a range circle for non-weapon kinds (capital / solar / miner)', () => {
    const swarm = new Map<number, SwarmRenderState>([
      [1, structureEntry('capital', 0, 0)],
      [2, structureEntry('solar', 300, 0)],
      [3, structureEntry('miner', -300, 0)], // miner has miningRange, NOT weaponRange
    ]);
    const structures = new Map<number, StructureRenderState>([
      [1, structureState({ built: true })],
      [2, structureState({ built: true })],
      [3, structureState({ built: true })],
    ]);
    const mirror = { swarm, structures } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.builtTurretRangeCount).toBe(0);
  });

  it('counts every built weapon turret kind (turret + bolt + missile)', () => {
    const swarm = new Map<number, SwarmRenderState>([
      [1, structureEntry('turret', 0, 0)],
      [2, structureEntry('laser_bolt_turret', 400, 0)],
      [3, structureEntry('missile_turret', -400, 0)],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [1, structureState({ built: true })],
      [2, structureState({ built: true })],
      [3, structureState({ built: true })],
    ]);
    const mirror = { swarm, structures } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(getStructureKind('laser_bolt_turret').weaponRange).toBeGreaterThan(0);
    expect(getStructureKind('missile_turret').weaponRange).toBeGreaterThan(0);
    expect(r.builtTurretRangeCount).toBe(3);
  });

  it('Phase 5 — the range ring is BOLDER (≥2× width) when the turret is hovered/selected', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, structureEntry('turret', 100, 200)]]);
    const structures = new Map<number, StructureRenderState>([[1, structureState({ built: true })]]);
    const mirror = { swarm, structures } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);
    const baseWidth = r.lastBuiltTurretRangeWidth;
    expect(baseWidth).toBeGreaterThan(0);

    r.highlightedStructureId = 1; // this turret is now selected/hovered
    r.update(mirror, 1, 0);
    expect(r.lastBuiltTurretRangeWidth).toBeGreaterThanOrEqual(baseWidth * 2);

    r.highlightedStructureId = 999; // a different structure highlighted → back to faint
    r.update(mirror, 1, 0);
    expect(r.lastBuiltTurretRangeWidth).toBe(baseWidth);
  });

  it('count resets to 0 when there are no structures', () => {
    const r = new ConnectorRenderer();
    r.update({ swarm: new Map(), structures: new Map() } as unknown as RenderMirror, 1, 0);
    expect(r.builtTurretRangeCount).toBe(0);
    expect(r.lastBuiltTurretRangeRadius).toBe(0);
  });

  it('the built-turret ring is a DISTINCT colour from the placement connection ring', () => {
    expect(BUILT_RANGE_CIRCLE_COLOR).not.toBe(RANGE_CIRCLE_COLOR);
    const built = builtRangeCircleVisualParams(1);
    const placement = rangeCircleVisualParams(1);
    expect(built.color).toBe(BUILT_RANGE_CIRCLE_COLOR);
    expect(built.color).not.toBe(placement.color);
    // Always-on coverage rings stay faint (fainter than the placement ring) so a
    // base full of turrets doesn't drown the scene.
    expect(built.alpha).toBeGreaterThan(0);
    expect(built.alpha).toBeLessThan(placement.alpha);
  });

  it('the built-turret ring width is scale-aware (≥ 1 device px)', () => {
    expect(builtRangeCircleVisualParams(0.5).width).toBeGreaterThan(builtRangeCircleVisualParams(4).width);
    expect(builtRangeCircleVisualParams(0).width).toBeGreaterThanOrEqual(1); // guards /0
  });

  it('builtRangeCircleVisualInto writes INTO a reused scratch (no per-call alloc, #21/#14)', () => {
    // The renderer calls this once per BUILT turret per frame inside the
    // per-structure loop — it MUST mutate a reused scratch, never allocate a
    // fresh object literal. Locking: the same struct ref comes back, and a second
    // call with different scale overwrites the SAME object (so a loop over N
    // turrets allocates nothing). Mirrors the connectorVisualInto / shieldWall
    // scratch pattern.
    const scratch: RingVisual = { color: 0, alpha: 0, width: 0 };
    const r1 = builtRangeCircleVisualInto(scratch, 1);
    expect(r1).toBe(scratch); // same reference — written in place, not allocated
    expect(r1.color).toBe(BUILT_RANGE_CIRCLE_COLOR);
    const w1 = r1.width;
    const r2 = builtRangeCircleVisualInto(scratch, 0.25); // bigger width at lower zoom
    expect(r2).toBe(scratch); // STILL the same object — reused across calls
    expect(r2.width).toBeGreaterThan(w1);
    // builtRangeCircleVisualParams (the allocating wrapper the pure tests use)
    // must agree byte-for-byte with the into-variant.
    const alloc = builtRangeCircleVisualParams(0.25);
    expect(alloc).toEqual({ color: r2.color, alpha: r2.alpha, width: r2.width });
  });
});
