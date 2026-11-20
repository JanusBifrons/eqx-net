/**
 * Territory lock beacon (restyle F2, `lock-beacon`): the dish turns slowly on
 * the tick clock only while the lock holds its sector for its owner's side
 * (the `lockHolding` row flag, decoded from STRUCTURE_FLAG_LOCK_HOLDING) and
 * stands still where it is otherwise.
 */
import { describe, it, expect } from 'vitest';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { LOCK_BEACON_SPIN } from '../../../core/articulation/rigs/fences.js';
import { lockBeaconContext } from './structureStyleC.fences.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const row = (lockHolding?: boolean): StructureRenderState =>
  ({ built: true, lockHolding, powered: true, buildPct: 1, deconstructPct: 0, connTo: [] }) as unknown as StructureRenderState;

describe('territory lock beacon (StructureRigView spin)', () => {
  it('draws the dish from the shared beacon art', () => {
    const v = new StructureRigView(rigForStructureKind('territory_lock')!);
    expect(v.hasSpin).toBe(true);
    expect(v.parts.length).toBe(1);
    expect(v.parts[0]!.context).toBe(lockBeaconContext());
  });

  it('is slow and calm: well under a turn a second', () => {
    expect(LOCK_BEACON_SPIN * 60).toBeLessThan(Math.PI);
    expect(LOCK_BEACON_SPIN).toBeGreaterThan(0);
  });

  it('turns only while holding; stands still where it is otherwise', () => {
    const v = new StructureRigView(rigForStructureKind('territory_lock')!);
    for (const [r, runs] of [[row(true), true], [row(false), false], [row(), false], [undefined, false]] as const) {
      v.setRunningFrom(r);
      expect(v.running).toBe(runs);
    }
    v.setRunningFrom(row(true));
    v.update(null, 0, 0, 0, 0);
    v.update(null, 30, 0, 0, 0);
    const turned = v.parts[0]!.rotation;
    expect(Math.abs(Math.sin(turned))).toBeCloseTo(Math.abs(Math.sin(30 * LOCK_BEACON_SPIN)), 6);
    v.setRunningFrom(row());
    v.update(null, 90, 0, 0, 0);
    expect(v.parts[0]!.rotation).toBe(turned);
  });
});
