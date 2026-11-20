/**
 * Shipyard build frame (restyle job 3J, `shipyard-frame`): every rig part
 * draws from the heavyIndustry family's part art (one shared context per art
 * kind), and none is a pop-up riser (the frame stands at rest, fully shown).
 */
import { describe, it, expect } from 'vitest';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { shipyardPartContext } from './structureStyleC.heavyIndustry.js';

describe('shipyard build frame (StructureRigView)', () => {
  it('draws every part from the shared shipyard part art', () => {
    const rig = rigForStructureKind('shipyard')!;
    const v = new StructureRigView(rig);
    expect(v.parts.length).toBe(rig.partCount);
    for (let i = 0; i < rig.partCount; i++) {
      const ctx = shipyardPartContext(rig, i);
      expect(ctx, rig.partIds[i]).not.toBeNull();
      expect(v.parts[i]!.context, rig.partIds[i]).toBe(ctx);
    }
    // One context per art kind: all clamps share one, all lights share one.
    const at = (id: string) => shipyardPartContext(rig, rig.partIds.indexOf(id));
    expect(at('clamp-port-0')).toBe(at('clamp-stbd-3'));
    expect(at('light-0')).toBe(at('light-5'));
    expect(at('wall-port')).not.toBe(at('wall-stbd'));
  });

  it('stands fully shown at rest: no part is hidden as a riser', () => {
    const v = new StructureRigView(rigForStructureKind('shipyard')!);
    v.update(null, 0, 0, 0, 0);
    for (const p of v.parts) expect(p.visible).toBe(true);
  });
});
