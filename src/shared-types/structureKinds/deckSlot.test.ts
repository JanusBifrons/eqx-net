/**
 * Base-platforms deck slots: every structure kind's footprint fits its
 * `deckSlot` with at least 130 u room to the slot edge, at its best
 * quarter-turn. Deck = pointy-top hexes, 1300 u flat-to-flat.
 *  - 'hex':   one whole hex, footprint centred.
 *  - 'small': a third of a hex, the rhombus centre–corner–corner–corner made by
 *             joining the hex centre to alternate corners. Checked in the
 *             rhombus's own frame (long diagonal along x): the building turns
 *             with its rhombus. Footprint centred on the rhombus.
 *  - 'plate': the 7-hex leaf, footprint centred on its middle hex.
 * Every slot and footprint is centrally symmetric and the slot shape convex
 * (or, for the leaf, the footprint centred on the leaf centre), so centring is
 * the best placement.
 *
 * Slice 18: a small building no longer picks its best quarter-turn: the deck
 * snap turns it to face its rhombus (`snapPlacementToDeck`). The turned-fit
 * test places every small kind in each of the three rhombi of a hex at the
 * snapped centre AND turn, and measures the real (turned) box in the world
 * rhombus.
 */
import { describe, expect, it } from 'vitest';
import { STRUCTURE_KINDS_LIST } from './catalogueOrder.js';
import type { StructureKind } from './types.js';
import { snapPlacementToDeck } from '../../core/structures/deckPlacement.js';
import { deckSlotOutline, rhombusCentroidInto, type DeckSnap } from '../../core/hex/deckSnap.js';
import { deckHexCentreInto, isPlateCentreHex } from '../../core/hex/plates.js';

type P = readonly [number, number];
type Slot = StructureKind['deckSlot'];

const FLAT = 1300;
const R = FLAT / Math.sqrt(3); // circumradius
const MIN_ROOM = 130;

const hexAt = (cx: number, cy: number): P[] =>
  [90, 150, 210, 270, 330, 30].map((a) => {
    const t = (a * Math.PI) / 180;
    return [cx + R * Math.cos(t), cy + R * Math.sin(t)] as const;
  });

/** Boundary edges of a union of hexes: edges used by exactly one hex. */
function boundaryEdges(hexes: P[][]): Array<[P, P]> {
  const seen = new Map<string, { e: [P, P]; n: number }>();
  const key = (p: P): string => `${Math.round(p[0])},${Math.round(p[1])}`;
  for (const h of hexes) {
    for (let i = 0; i < h.length; i++) {
      const a = h[i]!, b = h[(i + 1) % h.length]!;
      const k = [key(a), key(b)].sort().join('|');
      const got = seen.get(k);
      if (got) got.n++;
      else seen.set(k, { e: [a, b], n: 1 });
    }
  }
  return [...seen.values()].filter((v) => v.n === 1).map((v) => v.e);
}

const polyEdges = (pts: P[]): Array<[P, P]> => pts.map((p, i) => [p, pts[(i + 1) % pts.length]!]);

// The third of the hex between the 30° and 150° rays (hex centre, 30° corner,
// 90° corner, 150° corner), recentred on its own centre.
const RHOMBUS: P[] = [[FLAT / 2, 0], [0, R / 2], [-FLAT / 2, 0], [0, -R / 2]];
const LEAF_CENTRES: P[] = [[0, 0], ...[0, 60, 120, 180, 240, 300].map((a) => {
  const t = (a * Math.PI) / 180;
  return [FLAT * Math.cos(t), FLAT * Math.sin(t)] as const;
})];

const SLOT_EDGES: Record<Slot, Array<[P, P]>> = {
  small: polyEdges(RHOMBUS),
  hex: polyEdges(hexAt(0, 0)),
  plate: boundaryEdges(LEAF_CENTRES.map(([x, y]) => hexAt(x, y))),
};

function pointSegDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function segsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

function inside(p: P, edges: Array<[P, P]>): boolean {
  let hit = false;
  for (const [a, b] of edges) {
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) hit = !hit;
  }
  return hit;
}

/** Room from a centred hw × hh box to the slot edge; negative if it pokes out. */
function boxRoom(hw: number, hh: number, edges: Array<[P, P]>): number {
  return polyRoom([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], edges);
}

/** Room from a (turned) box polygon to the slot edge; negative if it pokes out. */
function polyRoom(box: P[], edges: Array<[P, P]>): number {
  const boxEdges = polyEdges(box);
  if (!box.every((p) => inside(p, edges))) return -1;
  for (const [a, b] of edges) for (const [c, d] of boxEdges) if (segsCross(a, b, c, d)) return -1;
  let room = Infinity;
  for (const [a, b] of edges) for (const p of box) room = Math.min(room, pointSegDist(p, a, b));
  for (const [c, d] of boxEdges) for (const [a] of edges) room = Math.min(room, pointSegDist(a, c, d));
  return room;
}

/** Best room over the quarter-turns (0° and 90° differ; 180° repeats). */
function slotRoom(k: StructureKind, slot: Slot): number {
  const { w, h } = k.footprint;
  const e = SLOT_EDGES[slot];
  return Math.max(boxRoom(w / 2, h / 2, e), boxRoom(h / 2, w / 2, e));
}

const ORDER: readonly Slot[] = ['small', 'hex', 'plate'];
/** The 800 u teleporter pads fit a hex with ~104 u room (short of 130).
 *  Plate is kept for the large teleporter + Ancients' gate, so they stay
 *  'hex' and are flagged here — an owner decision, not a silent force-fit. */
const SHORT_ROOM: readonly string[] = ['teleporter', 'pocket_pad'];

/** A small kind's footprint at the snapped centre + turn in rhombus `k` of
 * a deck hex that is not a plate centre (a connector there lays a plate).
 * Returns the room to the world rhombus edge, and the turn. */
function turnedSmallRoom(k: StructureKind, rh: number): { room: number; rot: number } {
  const hexC = { x: 0, y: 0 }, cen = { x: 0, y: 0 };
  let q = 0;
  while (isPlateCentreHex(q, 0)) q++;
  deckHexCentreInto(q, 0, hexC);
  rhombusCentroidInto(hexC.x, hexC.y, rh, cen);
  const s: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };
  snapPlacementToDeck(k.id, cen.x, cen.y, s, 0);
  expect(s.slot).toBe('small');
  expect(s.rhombus).toBe(rh);
  const flat = deckSlotOutline('small', rh)[0]!; // relative to the centroid
  const poly: P[] = [];
  for (let i = 0; i < flat.length; i += 2) poly.push([flat[i]!, flat[i + 1]!]);
  const t = (s.rot * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
  const hw = k.footprint.w / 2, hh = k.footprint.h / 2;
  const box: P[] = ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(([x, y]) => [x * c - y * sn, x * sn + y * c] as const);
  return { room: polyRoom(box, polyEdges(poly)), rot: s.rot };
}

/** Small kinds short of 130 u room at their snapped facing (slice 18): the
 *  shield gate turns only in quarters, so in rhombi 1 and 2 (long diagonal at
 *  120° / 240°) it sits 30° off the diagonal and keeps ~127 u. It still fits;
 *  flagged for the owner rather than force-fitted. */
const SHORT_TURNED: readonly string[] = ['shield_gate'];

describe('deckSlot (base platforms)', () => {
  it('the slot shapes measure as designed', () => {
    expect(slotRoom({ footprint: { w: 1e-6, h: 1e-6 } } as StructureKind, 'hex')).toBeCloseTo(FLAT / 2, 3);
    expect(slotRoom({ footprint: { w: 1e-6, h: 1e-6 } } as StructureKind, 'small')).toBeCloseTo(FLAT / 4, 3);
    expect(SLOT_EDGES.plate).toHaveLength(18);
  });

  it.each(STRUCTURE_KINDS_LIST.map((k) => [k.id, k] as const))(
    '%s fits its slot with >= 130 u room, and no smaller slot',
    (id, k) => {
      const room = slotRoom(k, k.deckSlot);
      if (SHORT_ROOM.includes(id)) {
        expect(k.deckSlot).toBe('hex');
        expect(room).toBeGreaterThan(100);
        expect(room).toBeLessThan(MIN_ROOM);
      } else {
        expect(room, `${id} room in ${k.deckSlot}`).toBeGreaterThanOrEqual(MIN_ROOM);
      }
      for (const smaller of ORDER.slice(0, ORDER.indexOf(k.deckSlot))) {
        expect(slotRoom(k, smaller), `${id} would fit ${smaller}`).toBeLessThan(MIN_ROOM);
      }
    },
  );

  it.each(STRUCTURE_KINDS_LIST.filter((k) => k.deckSlot === 'small').map((k) => [k.id, k] as const))(
    '%s fits each rhombus of a hex at its snapped facing (slice 18)',
    (id, k) => {
      for (let rh = 0; rh < 3; rh++) {
        const { room, rot } = turnedSmallRoom(k, rh);
        if (SHORT_TURNED.includes(id) && rh > 0) {
          expect(room, `${id} rhombus ${rh} at ${rot}°`).toBeGreaterThan(120);
          expect(room, `${id} rhombus ${rh} at ${rot}°`).toBeLessThan(MIN_ROOM);
        } else expect(room, `${id} rhombus ${rh} at ${rot}°`).toBeGreaterThanOrEqual(MIN_ROOM);
      }
    },
  );

  it('plate is only the large teleporter and the Ancients\' gate', () => {
    expect(STRUCTURE_KINDS_LIST.filter((k) => k.deckSlot === 'plate').map((k) => k.id))
      .toEqual(['teleporter_large', 'alien_gate']);
  });
});
