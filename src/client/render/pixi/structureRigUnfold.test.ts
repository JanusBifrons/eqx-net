/** The Capital's crate unfold, drawn (`structureRigUnfold.ts`). */
import { describe, expect, it } from 'vitest';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { PACK_CLIP, UNFOLD_CLIP, UNFOLD_TICKS, isUnfoldPart } from '../../../core/articulation/unfoldRig.js';
import { StructureRigView } from './structureRigs.js';

function panelsVisible(view: StructureRigView): number {
  let n = 0;
  for (let i = 0; i < view.rig.partCount; i++) if (isUnfoldPart(view.rig, i) && view.parts[i]!.visible) n++;
  return n;
}

describe('Capital crate unfold look', () => {
  it('at rest (no clip, or long after placement) nothing extra is drawn and the body is full', () => {
    const view = new StructureRigView(rigForStructureKind('capital')!);
    view.update(null, 50, 0, 0, 0);
    expect(panelsVisible(view)).toBe(0);
    expect(view.unfold!.seams.visible).toBe(false);
    expect(view.bodyAlpha).toBe(1);
    view.update({ clipId: UNFOLD_CLIP, startTick: 10 }, 10 + 60 * 60, 0, 0, 0);
    expect(panelsVisible(view)).toBe(0);
    expect(view.bodyAlpha).toBe(1);
  });

  it('mid-unfold the panels show over a hidden body; then the seams glow; then it fuses', () => {
    const view = new StructureRigView(rigForStructureKind('capital')!);
    const rec = { clipId: UNFOLD_CLIP, startTick: 100 };
    view.update(rec, 100 + UNFOLD_TICKS * 0.3, 0, 0, 0);
    expect(panelsVisible(view)).toBe(16);
    expect(view.bodyAlpha).toBe(0);
    expect(view.unfold!.seams.visible).toBe(false);
    view.update(rec, 100 + UNFOLD_TICKS * 0.8, 0, 0, 0);
    expect(view.unfold!.seams.visible).toBe(true);
    expect(view.bodyAlpha).toBe(0);
    view.update(rec, 100 + UNFOLD_TICKS * 0.95, 0, 0, 0);
    expect(view.bodyAlpha).toBeGreaterThan(0);
    expect(view.bodyAlpha).toBeLessThan(1);
    // Packing runs it backwards: early in the pack the body fades out again.
    view.update({ clipId: PACK_CLIP, startTick: 1000 }, 1000 + UNFOLD_TICKS * 0.5, 0, 0, 0);
    expect(panelsVisible(view)).toBe(16);
    expect(view.bodyAlpha).toBe(0);
  });
});
