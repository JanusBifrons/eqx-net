/**
 * bp-17: the pick and the selection bracket use a 30° structure's REAL turned
 * box; quarter turns stay as before. Solar: 700 × 300 footprint.
 */
import { describe, expect, it } from 'vitest';
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import { pickEntityAt } from './pickEntity.js';
import { resolveSelectable, type SelectableTarget } from './SelectionBracket.js';

const DEG = Math.PI / 180;

function solar(angleDeg: number): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: angleDeg * DEG, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0, radius: 381, kind: 2, sleeping: false, lastUpdateTick: 0,
    shipKind: 'solar',
  } as SwarmRenderState;
}
function mirrorOf(sw: SwarmRenderState): RenderMirror {
  return { ships: new Map(), swarm: new Map([[7, sw]]), localPlayerId: null } as unknown as RenderMirror;
}
/** Local (lx, ly) of a structure turned `deg`, in world. */
function world(lx: number, ly: number, deg: number): { x: number; y: number } {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return { x: lx * c - ly * s, y: lx * s + ly * c };
}

describe('pickEntityAt: a 30° structure is its turned box', () => {
  it('hits the turned corner the axis box misses, and misses the axis corner', () => {
    const m = mirrorOf(solar(30));
    const inTurned = world(330, 100, 30); // (235.8, 251.6): above the axis box's y 150
    expect(pickEntityAt(inTurned.x, inTurned.y, m, 0)).toEqual({ id: 'swarm-7', kind: 'structure' });
    expect(pickEntityAt(340, -140, m, 0)).toBeNull(); // inside the axis box, off the turned one
  });
  it('the slop grows the turned box', () => {
    const m = mirrorOf(solar(30));
    const p = world(360, 0, 30); // 10 past the end
    expect(pickEntityAt(p.x, p.y, m, 0)).toBeNull();
    expect(pickEntityAt(p.x, p.y, m, 12)).not.toBeNull();
  });
  it('quarter turns keep the axis box', () => {
    expect(pickEntityAt(340, -140, mirrorOf(solar(0)), 0)).not.toBeNull();
    expect(pickEntityAt(140, -340, mirrorOf(solar(90)), 0)).not.toBeNull();
    expect(pickEntityAt(340, -140, mirrorOf(solar(90)), 0)).toBeNull();
  });
});

describe('resolveSelectable: the bracket frames a 30° structure by its turned bound', () => {
  const out: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };
  it('30°: the bound of the turned 350 × 150 box', () => {
    expect(resolveSelectable(mirrorOf(solar(30)), 'swarm-7', out)).toBe(true);
    const c = Math.cos(30 * DEG), s = Math.sin(30 * DEG);
    expect(out.hw).toBeCloseTo(c * 350 + s * 150, 6);
    expect(out.hh).toBeCloseTo(s * 350 + c * 150, 6);
  });
  it('quarter turns: the swapped axis box, as before', () => {
    resolveSelectable(mirrorOf(solar(90)), 'swarm-7', out);
    expect([out.hw, out.hh]).toEqual([150, 350]);
    resolveSelectable(mirrorOf(solar(0)), 'swarm-7', out);
    expect([out.hw, out.hh]).toEqual([350, 150]);
  });
});

describe('placement ghost: quarter-turn-only kinds never take a 30° step', () => {
  it('a gate snaps the held 30° turn to a quarter and steps by 90° on a deck room', async () => {
    const p = await import('../structures/structurePlacementClient.js');
    p.setPlacementRotationDeg(30);
    expect(p.placementRotationFor('shield_gate')).toBe(0);
    expect(p.placementRotationFor('solar')).toBe(30);
    expect(p.cyclePlacementRotation(true, 'shield_gate')).toBe(90);
    expect(p.cyclePlacementRotation(true, 'solar')).toBe(120);
    p.setPlacementRotationDeg(0);
  });
});
