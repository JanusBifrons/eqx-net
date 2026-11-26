/**
 * Base platforms — free build-slot outlines (`?buildSlots=on`). Every slot
 * drawn is one the ghost itself would show cyan (same snap, same verdict:
 * the server's `placementRejection`); hex-edge kinds (gates) get none;
 * recomputed only on change.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import { BuildSlotOutlines, readBuildSlotsFlag, SLOT_STRIDE, BUILD_SLOT_Z } from './buildSlotOutlines.js';
import { PlacementGhostVerdict } from '../../structures/placementGhostVerdict.js';
import { ghostDeckContext } from './placementDeckSnap.js';
import { plateCentreWorldInto } from '../../../core/hex/plates.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import type { HexPoint } from '../../../core/hex/hex.js';

type Placed = { id: number; kind: string; x: number; y: number; angleDeg?: number };

function mirrorFor(kind: string, placed: Placed[], angle = 0): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  for (const p of placed) {
    swarm.set(p.id, { x: p.x, y: p.y, angle: ((p.angleDeg ?? 0) * Math.PI) / 180, shipKind: p.kind } as unknown as SwarmRenderState);
    structures.set(p.id, { mirror: false } as unknown as StructureRenderState);
  }
  return {
    swarm, structures, deckPlates: { version: 1, count: 1, ij: new Int32Array([0, 0]), deck: true },
    pendingPlacementPreview: { kind, x: 0, y: 0, angle, deck: true, deckOwner: 'me', deckPlates: [0, 0] },
  } as unknown as RenderMirror;
}

function slotsOf(o: BuildSlotOutlines): Array<{ x: number; y: number; rot: number }> {
  const out: Array<{ x: number; y: number; rot: number }> = [];
  for (let n = 0; n < o.slots.length; n += SLOT_STRIDE) out.push({ x: o.slots[n]!, y: o.slots[n + 1]!, rot: o.slots[n + 4]! });
  return out;
}

/** The ghost's own verdict at a slot (what turns it cyan / red). */
function ghostVerdict(m: RenderMirror, x: number, y: number, rotDeg: number): string | null {
  const p = m.pendingPlacementPreview!;
  return new PlacementGhostVerdict().check({ kind: p.kind, x, y, angle: (rotDeg * Math.PI) / 180 }, m.structures, m.swarm!, null, ghostDeckContext(p));
}

const centre: HexPoint = { x: 0, y: 0 };
plateCentreWorldInto(0, 0, centre);

describe('build-slot outlines', () => {
  it('flag: off by default, `?buildSlots=on` turns it on', () => {
    expect(readBuildSlotsFlag('')).toBe(false);
    expect(readBuildSlotsFlag('?room=deck&buildSlots=off')).toBe(false);
    expect(readBuildSlotsFlag('?room=deck&buildSlots=on')).toBe(true);
  });

  it('an empty plate: one outline per hex for a hex-slot kind, each one the ghost accepts', () => {
    const o = new BuildSlotOutlines(new Container());
    const m = mirrorFor('reactor', []);
    o.update(m.pendingPlacementPreview, m);
    expect(o.count).toBe(7);
    expect(o.gfx.visible).toBe(true);
    expect(o.gfx.zIndex).toBe(BUILD_SLOT_Z);
    for (const s of slotsOf(o)) expect(ghostVerdict(m, s.x, s.y, s.rot < 0 ? 0 : s.rot)).toBeNull();
  });

  it('a placed building takes its slot out (the verdict refuses it there)', () => {
    const o = new BuildSlotOutlines(new Container());
    const m = mirrorFor('reactor', [{ id: 1, kind: 'reactor', x: centre.x, y: centre.y }]);
    o.update(m.pendingPlacementPreview, m);
    expect(o.count).toBeLessThan(7);
    expect(slotsOf(o).some((s) => Math.abs(s.x - centre.x) < 1 && Math.abs(s.y - centre.y) < 1)).toBe(false);
    expect(ghostVerdict(m, centre.x, centre.y, 0)).not.toBeNull();
  });

  it('a small-slot kind outlines rhombi (three a hex on an empty plate)', () => {
    const o = new BuildSlotOutlines(new Container());
    const m = mirrorFor('cargo_bay', []);
    o.update(m.pendingPlacementPreview, m);
    expect(o.count).toBeGreaterThan(7);
    for (const s of slotsOf(o)) expect(ghostVerdict(m, s.x, s.y, s.rot)).toBeNull();
  });

  it('shield gate (hex-edge slot): no outlines', () => {
    const o = new BuildSlotOutlines(new Container());
    const m = mirrorFor('shield_gate', []);
    o.update(m.pendingPlacementPreview, m);
    expect(o.count).toBe(0);
    expect(o.gfx.visible).toBe(false);
  });

  it('recomputes only when the kind, turn or structure set changes', () => {
    const o = new BuildSlotOutlines(new Container());
    const spy = vi.spyOn((o as unknown as { verdict: PlacementGhostVerdict }).verdict, 'prepare');
    const m = mirrorFor('reactor', []);
    o.update(m.pendingPlacementPreview, m);
    o.update(m.pendingPlacementPreview, m);
    o.update(m.pendingPlacementPreview, m);
    expect(spy).toHaveBeenCalledTimes(1);
    m.swarm!.set(3, { x: centre.x, y: centre.y, angle: 0, shipKind: 'reactor' } as unknown as SwarmRenderState);
    m.structures!.set(3, { mirror: false } as unknown as StructureRenderState);
    o.update(m.pendingPlacementPreview, m);
    expect(spy).toHaveBeenCalledTimes(2);
    m.pendingPlacementPreview!.kind = 'cargo_bay';
    o.update(m.pendingPlacementPreview, m);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('hidden off a deck room, for the pending (sent) ghost and with no preview', () => {
    const o = new BuildSlotOutlines(new Container());
    const m = mirrorFor('reactor', []);
    o.update(m.pendingPlacementPreview, m);
    expect(o.gfx.visible).toBe(true);
    m.pendingPlacementPreview!.pending = true;
    o.update(m.pendingPlacementPreview, m);
    expect(o.gfx.visible).toBe(false);
    m.pendingPlacementPreview!.pending = false;
    m.pendingPlacementPreview!.deck = false;
    o.update(m.pendingPlacementPreview, m);
    expect(o.gfx.visible).toBe(false);
    o.update(undefined, m);
    expect(o.gfx.visible).toBe(false);
  });
});
