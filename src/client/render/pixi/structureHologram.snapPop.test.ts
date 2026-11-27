/**
 * Edge feel P4: the placement ghost's deck slot outline breathes with the
 * ghost pulse and pops (swells + flashes full) when the ghost lands on a new
 * slot; the same slot frame to frame does not re-pop; a sent ghost is still.
 */
import { describe, expect, it } from 'vitest';
import { SLOT_ALPHA_LO, SNAP_POP_GROW, SNAP_POP_MS, StructureHologram } from './structureHologram.js';

function ghost(): StructureHologram {
  return new StructureHologram('shield_pylon', 40, 'c', 'ghost');
}

describe('placement ghost: slot snap pop', () => {
  it('no slot = nothing to show', () => {
    const g = ghost();
    g.updateGhost(false, false, 1000);
    expect(g.slotLook()).toBeNull();
  });

  it('a new slot pops full and eases back to the breath within SNAP_POP_MS', () => {
    const g = ghost();
    g.x = 100; g.y = 50;
    g.setDeckSlot('hex', -1);
    g.updateGhost(false, false, 1000);
    const at = g.slotLook()!;
    expect(at.scale).toBeCloseTo(1 + SNAP_POP_GROW);
    expect(at.alpha).toBeCloseTo(1);
    g.setDeckSlot('hex', -1); // same slot next frame: no new pop
    g.updateGhost(false, false, 1000 + SNAP_POP_MS / 2);
    const mid = g.slotLook()!;
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(1 + SNAP_POP_GROW);
    g.setDeckSlot('hex', -1);
    g.updateGhost(false, false, 1000 + SNAP_POP_MS + 1);
    const after = g.slotLook()!;
    expect(after.scale).toBe(1);
    expect(after.alpha).toBeGreaterThanOrEqual(SLOT_ALPHA_LO - 1e-9);
    expect(after.alpha).toBeLessThanOrEqual(1);
  });

  it('moving to another slot pops again', () => {
    const g = ghost();
    g.setDeckSlot('hex', -1);
    g.updateGhost(false, false, 0);
    g.setDeckSlot('hex', -1);
    g.updateGhost(false, false, 5000);
    expect(g.slotLook()!.scale).toBe(1);
    g.x = 300;
    g.setDeckSlot('hex', -1);
    g.updateGhost(false, false, 5010);
    expect(g.slotLook()!.scale).toBeCloseTo(1 + SNAP_POP_GROW);
  });

  it('the outline breathes between SLOT_ALPHA_LO and 1', () => {
    const g = ghost();
    g.setDeckSlot('hex', -1);
    const seen: number[] = [];
    for (let t = 10000; t < 11200; t += 50) { g.setDeckSlot('hex', -1); g.updateGhost(false, false, t); seen.push(g.slotLook()!.alpha); }
    expect(Math.min(...seen)).toBeLessThan(0.7);
    expect(Math.max(...seen)).toBeGreaterThan(0.9);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(SLOT_ALPHA_LO - 1e-9);
  });

  it('a sent ghost holds its outline still; a mirrored ghost keeps the outline unmirrored', () => {
    const g = ghost();
    g.scale.x = -1;
    g.setDeckSlot('hex', -1);
    g.updateGhost(false, true, 7000);
    expect(g.slotLook()).toEqual({ alpha: 1, scale: 1 });
    g.updateGhost(false, false, 7000 + SNAP_POP_MS * 4);
    const slot = g.children[0]!;
    expect(slot.scale.x).toBe(-1);
  });
});
