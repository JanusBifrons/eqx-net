/**
 * Rig lit overlays (`RigDrawHook.partLit`): the beam turret's riser bakes its
 * blue trim lamps dark and lights them through an overlay shown only while
 * the row is powered (`running`), like the pad's lamps; a rig with no
 * `partLit` gets no overlay.
 */
import { describe, it, expect } from 'vitest';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(powered: boolean, built = true): StructureRenderState {
  return { built, powered, buildPct: 1, deconstructPct: 0, connTo: [] } as unknown as StructureRenderState;
}

describe('rig lit overlay (partLit)', () => {
  it('beam turret riser lamps: lit while powered, dark unpowered, unbuilt or with no row', () => {
    const v = new StructureRigView(rigForStructureKind('turret')!);
    const r = v.riserPart;
    const lit = v.lit[r]!;
    expect(lit).not.toBeNull();
    expect(lit.label).toBe(`rig-lit-${v.rig.parts[r]!.id}`);
    // Just over the riser, in its group.
    expect(lit.parent).toBe(v.parts[r]!.parent);
    expect(lit.parent!.getChildIndex(lit)).toBe(lit.parent!.getChildIndex(v.parts[r]!) + 1);
    // Only the riser carries one.
    for (let i = 0; i < v.rig.partCount; i++) if (i !== r) expect(v.lit[i]).toBeNull();

    v.setRunningFrom(row(true));
    v.update(null, 0, 0, 0, 0); // idle = deployed, hatch open
    expect(v.parts[r]!.visible).toBe(true);
    expect(lit.visible).toBe(true);
    // Posed with the riser (lift scale included).
    expect(lit.x).toBe(v.parts[r]!.x);
    expect(lit.y).toBe(v.parts[r]!.y);
    expect(lit.rotation).toBe(v.parts[r]!.rotation);
    expect(lit.scale.x).toBe(v.parts[r]!.scale.x);

    for (const st of [row(false), row(true, false), undefined]) {
      v.setRunningFrom(st);
      v.update(null, 1, 0, 0, 0);
      expect(v.parts[r]!.visible).toBe(true);
      expect(lit.visible).toBe(false);
    }

    // Powered but sunk under the shut hatch: the riser and its light hide.
    v.setRunningFrom(row(true));
    v.update({ clipId: 'turret-retract', startTick: 0 }, 1000, 0, 0, 0);
    expect(v.parts[r]!.visible).toBe(false);
    expect(lit.visible).toBe(false);
  });

  it('a rig without partLit gets no overlays', () => {
    const v = new StructureRigView(rigForStructureKind('freight_dock')!);
    expect(v.lit.length).toBe(v.rig.partCount);
    expect(v.lit.every((g) => g === null)).toBe(true);
  });
});
