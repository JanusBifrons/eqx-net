/**
 * The placement hint for "a fence blocks every shot, its owner's turret fire
 * included" (user ruling 2026-11-02): a turret ghost warns when a shield wall
 * lies within its range.
 */
import { describe, expect, it } from 'vitest';
import { turretFireCrossesWall, turretRangeOf } from './fenceFireHint.js';
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';

function st(connTo: number[], extra: Partial<StructureRenderState> = {}): StructureRenderState {
  return {
    powered: true, netPower: 0, connTo, built: true, buildPct: 1, deconstructPct: 0, wallActive: true, ...extra,
  } as StructureRenderState;
}
function sw(x: number, y: number, shipKind: string): SwarmRenderState {
  return { x, y, vx: 0, vy: 0, angle: 0, kind: 2, radius: 50, shipKind } as unknown as SwarmRenderState;
}

// Two connected pylons: a wall along x = 1000, y 0..600.
const swarm = new Map<number, SwarmRenderState>([[1, sw(1000, 0, 'shield_pylon')], [2, sw(1000, 600, 'shield_pylon')]]);
const structures = new Map([[1, st([2])], [2, st([1])]]);

describe('turretFireCrossesWall', () => {
  it('warns when a wall lies within the turret range', () => {
    const r = turretRangeOf('turret');
    expect(r).toBeGreaterThan(0);
    expect(turretFireCrossesWall('turret', 1000 - r + 50, 300, structures, swarm)).toBe(true);
  });

  it('stays quiet when every wall is out of range', () => {
    const r = turretRangeOf('turret');
    expect(turretFireCrossesWall('turret', 1000 - r - 200, 300, structures, swarm)).toBe(false);
  });

  it('only weapons that fire shots get the hint (a Solar or a Miner never does)', () => {
    expect(turretRangeOf('solar')).toBe(0);
    expect(turretRangeOf('miner')).toBe(0);
    expect(turretFireCrossesWall('solar', 1000, 300, structures, swarm)).toBe(false);
  });

  it('no structures ⇒ no hint', () => {
    expect(turretFireCrossesWall('turret', 0, 0, undefined, swarm)).toBe(false);
    expect(turretFireCrossesWall('turret', 0, 0, new Map(), swarm)).toBe(false);
  });
});
