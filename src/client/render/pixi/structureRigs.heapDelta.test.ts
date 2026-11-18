/**
 * Heap-delta lock (#14) for the structure rig per-frame pose (restyle 2c):
 * `StructureRigView.update` (evaluate + IK + world→host target + posing the
 * part Graphics, and 3e: redrawing the goods flow pulse along a holding
 * crane arm) and `placeMount` allocate nothing per frame.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { StructureRigView, type StructureRigInput } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { CRANE_CARGO_BOTH } from '../../../core/articulation/craneCargo.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('--expose-gc not set; run via pnpm test:gc');
  return gc;
}

describe('StructureRigView.update — heap', () => {
  it('does not grow the heap over 10k frames (crane IK + goods pulse + turret slide)', () => {
    const gc = requireGc();
    const crane = new StructureRigView(rigForStructureKind('freight_dock')!);
    const turret = new StructureRigView(rigForStructureKind('turret')!);
    const cluster = new Container();
    const reach: StructureRigInput = { clipId: 'arm-reach', startTick: 0, targetX: 40, targetY: -30 };
    const deploy: StructureRigInput = { clipId: 'turret-deploy', startTick: 0 };
    const holder = new StructureRigView(rigForStructureKind('freight_dock')!);
    // Kept mid-hold every frame (start trails the clock) so the pulse draws.
    const hold = { clipId: 'arm-hold', startTick: 0, targetX: 40, targetY: 450, holdTicks: 600, cargo: CRANE_CARGO_BOTH };
    const frame = (f: number): void => {
      crane.update(reach, f * 0.5, 10, 20, 0.3, 1);
      turret.update(deploy, f * 0.5, -10, 5, -0.2, 1);
      turret.placeMount(cluster);
      hold.startTick = f * 0.5 - (f % 600);
      holder.update(hold, f * 0.5, 10, 20, 0.3, 1);
      crane.update(null, f, 10, 20, 0.3, 1);
    };
    for (let f = 0; f < 2000; f++) frame(f);
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let f = 0; f < 10_000; f++) frame(f);
    gc();
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(200_000);
  });
});
