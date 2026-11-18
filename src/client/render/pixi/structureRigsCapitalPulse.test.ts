/**
 * Structure-restyle 3e / 3i: the Capital's crane bay runs the same goods flow
 * pulse along its arm as a freight dock (`StructureRigView.poseCargo`), at
 * the phone's zoomed-out camera scale too, and the pulse travels.
 */
import { describe, it, expect } from 'vitest';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { CRANE_CARGO_IN } from '../../../core/articulation/craneCargo.js';
import { StructureRigView } from './structureRigs.js';

describe('Capital crane arm goods pulse (3e on the Capital bay)', () => {
  // The hold the real run carries: target host (0, 452), 360-tick unload.
  const hold = { clipId: 'arm-hold', startTick: 901, targetX: 0, targetY: 452, holdTicks: 360, cargo: CRANE_CARGO_IN };

  it.each([0.3, 1])('draws a moving pulse through the hold at zoom %s', (zoom) => {
    const view = new StructureRigView(rigForStructureKind('capital')!);
    view.zoom = zoom;
    const g = view.cargo!;
    const centres: number[] = [];
    for (const t of [1004, 1020, 1040]) {
      view.update(hold, t, 0, 0, 0);
      expect(g.visible, `tick ${t}`).toBe(true);
      const b = g.getLocalBounds();
      expect(b.maxX - b.minX + (b.maxY - b.minY), 'a drawn comet').toBeGreaterThan(1);
      centres.push((b.minX + b.maxX) / 2);
    }
    expect(new Set(centres.map((c) => Math.round(c))).size, 'it travels').toBe(3);
    view.update(hold, 901 + 360, 0, 0, 0);
    expect(g.visible, 'gone after the hold').toBe(false);
  });
});
