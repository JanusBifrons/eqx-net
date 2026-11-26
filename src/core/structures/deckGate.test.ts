/**
 * Base platforms slice 21 — "gates where a road crosses a fence". On a deck a
 * shield gate snaps to a hex edge midpoint turned along the seam
 * (`snapPlacementToDeck`, `'edge'` slot), is placed only where the seam
 * borders a road (`placementRejection` `'no-road'`), and its hit boxes follow
 * the 30° seam turn (quarter turns unchanged).
 */
import { describe, it, expect } from 'vitest';
import { snapPlacementToDeck } from './deckPlacement.js';
import { placementRejection, type PlacementDeck, type PlacementFootprint } from './placementRules.js';
import { gateColliderBoxes, gateWorldAxisBoxes } from './gateGeometry.js';
import { gateHitBoxes } from './doorLeafBoxes.js';
import { rayHitsBoxParts } from '../combat/Weapons.js';
import type { DeckSnap } from '../hex/deckSnap.js';
import { DECK_HEX_INRADIUS, isDeckSeamEnd, isOnDeckEdgeMid } from '../hex/deckCorners.js';
import { hexCornerInto, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../hex/plates.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { structureHalfExtents } from '../../shared-types/structureKinds/geometry.js';

const snap = (): DeckSnap => ({ x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 });
const C = deckHexCentreInto(1, 0, { x: 0, y: 0 });

/** Edge midpoint `i` (at 60°·i) of hex (1, 0), its seam direction, its two end corners. */
function edge(i: number): { m: HexPoint; dir: number; ends: [HexPoint, HexPoint]; across: HexPoint } {
  const a = (i * Math.PI) / 3;
  const m = { x: C.x + DECK_HEX_INRADIUS * Math.cos(a), y: C.y + DECK_HEX_INRADIUS * Math.sin(a) };
  const ends: [HexPoint, HexPoint] = [
    hexCornerInto(C.x, C.y, DECK_HEX_SIZE, (i + 5) % 6, { x: 0, y: 0 }),
    hexCornerInto(C.x, C.y, DECK_HEX_SIZE, i, { x: 0, y: 0 }),
  ];
  return { m, dir: (i * 60 + 90) % 180, ends, across: { x: 2 * m.x - C.x, y: 2 * m.y - C.y } };
}

function fp(kind: string, p: HexPoint, rot = 0): PlacementFootprint {
  const { hw, hh } = structureHalfExtents(kind, rot);
  return { x: p.x, y: p.y, radius: getStructureKind(kind).radius, halfW: hw, halfH: hh, kind, rot };
}

const deck: PlacementDeck = { plates: { plateAtWorld: () => true }, owner: 'p1' };

describe('deck gate edge snap (slice 21)', () => {
  for (let i = 0; i < 6; i++) {
    it(`edge ${i}: snaps to the midpoint along its seam, idempotent, same from both hexes`, () => {
      const e = edge(i);
      // A point a little inside the hex, toward edge i.
      const p = { x: C.x + (e.m.x - C.x) * 0.8 + 20, y: C.y + (e.m.y - C.y) * 0.8 - 15 };
      const s = snapPlacementToDeck('shield_gate', p.x, p.y, snap(), 0);
      expect(s.slot).toBe('edge');
      expect(s.x).toBeCloseTo(e.m.x, 6);
      expect(s.y).toBeCloseTo(e.m.y, 6);
      expect(s.rot).toBe(e.dir);
      expect([30, 90, 150]).toContain(s.rot);
      expect(isOnDeckEdgeMid(s.x, s.y)).toBe(true);
      // The player's held turn is ignored: the seam decides.
      expect(snapPlacementToDeck('shield_gate', p.x, p.y, snap(), 270).rot).toBe(e.dir);
      // Idempotent.
      const again = snapPlacementToDeck('shield_gate', s.x, s.y, snap(), 0);
      expect(again.x).toBeCloseTo(s.x, 6);
      expect(again.y).toBeCloseTo(s.y, 6);
      expect(again.rot).toBe(s.rot);
      // From the hex across the seam: the same midpoint and turn.
      const q = { x: e.across.x + (e.m.x - e.across.x) * 0.8, y: e.across.y + (e.m.y - e.across.y) * 0.8 };
      const o = snapPlacementToDeck('shield_gate', q.x, q.y, snap(), 0);
      expect(o.x).toBeCloseTo(e.m.x, 6);
      expect(o.y).toBeCloseTo(e.m.y, 6);
      expect(o.rot).toBe(e.dir);
      // Its seam's ends are the two corners half an edge away.
      for (const c of e.ends) expect(isDeckSeamEnd(c.x, c.y, s.x, s.y)).toBe(true);
    });
  }

  it('a pylon still snaps to a corner, not an edge', () => {
    expect(snapPlacementToDeck('shield_pylon', C.x + 300, C.y + 10, snap()).slot).toBe('corner');
  });
});

describe("deck gate placement: 'no-road' (slice 21)", () => {
  for (const i of [0, 1, 2]) {
    const e = edge(i);
    const pylons = e.ends.map((c) => fp('shield_pylon', c));
    for (const roadRot of [0, 30]) {
      it(`edge ${i}, road turned ${roadRot}°: accepted with a road on either side, between the corner pylons`, () => {
        expect(placementRejection('shield_gate', e.m.x, e.m.y, [...pylons, fp('road', C, roadRot)], null, e.dir, false, deck)).toBeNull();
        expect(placementRejection('shield_gate', e.m.x, e.m.y, [...pylons, fp('road', e.across, roadRot)], null, e.dir, false, deck)).toBeNull();
      });
    }
    it(`edge ${i}: refused 'no-road' with no road, or a road on another hex`, () => {
      expect(placementRejection('shield_gate', e.m.x, e.m.y, pylons, null, e.dir, false, deck)).toBe('no-road');
      const far = { x: C.x - 2 * (e.m.x - C.x), y: C.y - 2 * (e.m.y - C.y) };
      expect(placementRejection('shield_gate', e.m.x, e.m.y, [...pylons, fp('road', far, 30)], null, e.dir, false, deck)).toBe('no-road');
    });
  }

  it('no deck rule (not a deck room / system placement): no road needed', () => {
    const e = edge(0);
    expect(placementRejection('shield_gate', e.m.x, e.m.y, [], null, e.dir, false, null)).toBeNull();
  });

  it('a pylon never needs a road', () => {
    expect(placementRejection('shield_pylon', edge(0).ends[0].x, edge(0).ends[0].y, [], null, 0, false, deck)).toBeNull();
  });
});

describe('gate hit boxes at a seam turn (slice 21)', () => {
  it('quarter turns are unchanged: the local boxes, swapped on 90° / 270°', () => {
    const local = gateColliderBoxes('shield_gate')!;
    for (const q of [0, 1, 2, 3]) {
      const out = gateWorldAxisBoxes('shield_gate', (q * Math.PI) / 2)!;
      const c = [1, 0, -1, 0][q]!, s = [0, 1, 0, -1][q]!;
      local.forEach((b, i) => {
        expect(out[i * 4]).toBe(Math.fround(b.cx * c - b.cy * s));
        expect(out[i * 4 + 1]).toBe(Math.fround(b.cx * s + b.cy * c));
        expect(out[i * 4 + 2]).toBe(Math.fround(q % 2 === 0 ? b.hw : b.hh));
        expect(out[i * 4 + 3]).toBe(Math.fround(q % 2 === 0 ? b.hh : b.hw));
      });
    }
  });

  it('30°: each post box is centred on the turned post and bounds its turned box', () => {
    const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
    const local = gateColliderBoxes('shield_gate')!;
    const out = gateWorldAxisBoxes('shield_gate', a)!;
    local.forEach((b, i) => {
      expect(out[i * 4]).toBeCloseTo(b.cx * c - b.cy * s, 3);
      expect(out[i * 4 + 1]).toBeCloseTo(b.cx * s + b.cy * c, 3);
      expect(out[i * 4 + 2]).toBeCloseTo(b.hw * c + b.hh * s, 3);
      expect(out[i * 4 + 3]).toBeCloseTo(b.hw * s + b.hh * c, 3);
    });
  });

  it('30°: a shot through the shut gate (along its travel axis) hits; one past its end misses', () => {
    const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
    const boxes = gateHitBoxes('shield_gate', a)!;
    // Local +y (travel axis) in world: (-s, c). Fire from 500 out, back through the centre.
    const hit = rayHitsBoxParts(-s * -500, c * -500, -s, c, 1000, 0, 0, boxes, 0);
    expect(hit).not.toBeNull();
    // 400 u along the gate's long axis (past its 208 u half-width).
    const ox = 400 * c, oy = 400 * s;
    expect(rayHitsBoxParts(ox + s * 500, oy - c * 500, -s, c, 1000, 0, 0, boxes, 0)).toBeNull();
  });
});
