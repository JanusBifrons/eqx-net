/**
 * Base platforms slice 26 — a generated deck base's fence (plan
 * `.resume/base-platforms-plan.md`, "Generated bases"). The row layout rings
 * a fenced base with a rectangle of Shield Pylons (`growBase.ts`); on a deck
 * the fence runs along the hex seams like a player's (slices 19 / 21):
 *  1. The ring is every seam on the OUTER boundary of the laid plates (a deck
 *     hex on one side, no plate on the other). A boundary corner no post can
 *     stand on (a dock's landing pad reaching its hex's corner) widens the
 *     deck: the plate beyond it is laid and the ring runs round that too.
 *  2. Gates: for each of four bearings from the Capital (0°, 90°, 180°, 270°,
 *     the row base's mid-side gates), the boundary seam nearest it (within
 *     45°) whose inside hex is open floor gets a `road` tile on that hex
 *     (turned along the road network, `growDeckRoads.ts`) and a `shield_gate` on the seam, so
 *     the gate passes the player's `'no-road'` rule. A deck with no open
 *     boundary hex (a dense base packs every one) lays one fresh plate first:
 *     the newest plate is on the outside, all of it open floor.
 *  3. A `shield_pylon` on every boundary corner; the two posts of each seam
 *     link (`DECK_LINK_SEAM_FENCE`, a wall) except on a gate's seam, where the
 *     gate links to both (`DECK_LINK_SEAM_GATE`), as a player's gate cuts it.
 *     A corner holds at most two boundary seams, so a post keeps a link free.
 *  4. Taps: every laid plate's anchor links one post on that plate (the deck
 *     on-plate link), so the ring is on the base's grid.
 * Every point goes through the player's snap (`snapPlacementToDeck`) and
 * every placement and link through `Builder` (the deck `placementRejection`
 * and `canConnect`); a piece the rules refuse is skipped, as everywhere in
 * the generator. Power: the posts and gates draw like the row fence's; the
 * growth loop (`balanced` in `growBase.ts`) buys Solars for the measured draw.
 * The tier structure cap leaves the deck fence out (`deckFencePieces`).
 * Roads (slice 32, `growDeckRoads.ts`): once the ring is up, roads over open
 * floor join every gate road into one network.
 */
import { HEX_DIRS, hexCornerInto, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateHexes, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import type { DeckSnap } from '../hex/deckSnap.js';
import { snapPlacementToDeck } from '../structures/deckPlacement.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND, DECK_LINK_ON_PLATE, deckLinkKind } from '../structures/deckLinks.js';
import { DECK_ROAD_KIND } from '../structures/deckGateRoad.js';
import type { GrownPlacement } from './growBuilder.js';
import type { DeckLayout } from './growDeck.js';
import { layDeckRoads, planDeckRoads, plannedTurn, type RoadEnd } from './growDeckRoads.js';

/** Bearings (degrees, from the Capital) a gate is laid toward. */
const GATE_BEARINGS = [0, 90, 180, 270] as const;
/** A gate is laid only within this many degrees of its bearing. */
const GATE_SPREAD = 45;

/** One boundary seam: the deck hex inside, the hex outside, its two corners
 *  and its midpoint. */
interface Seam {
  q: number;
  r: number;
  oq: number;
  or: number;
  a: HexPoint;
  b: HexPoint;
  m: HexPoint;
}

/** What the fence laid, and which plates a bastion may not take. */
export interface DeckFence {
  pylons: number;
  gates: number;
  /** Each laid gate's road hex and the hex outside it (`growDeckRoads.ts`). */
  gateEnds: RoadEnd[];
  /** Is plate (i, j) one a gate opens onto (kept clear of bastions)? */
  blocksBastion: (i: number, j: number) => boolean;
}

const plate: PlateIndex = { i: 0, j: 0 };
const snap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' };
const plateKey = (i: number, j: number): string => `${i},${j}`;

/** Every seam on the outer boundary of `L`'s laid plates, in lay order. */
function boundarySeams(L: DeckLayout): Seam[] {
  const laid = new Set(L.laid.map((l) => plateKey(l.i, l.j)));
  const out: Seam[] = [];
  for (const l of L.laid) {
    for (const h of plateHexes(l.i, l.j)) {
      for (let e = 0; e < 6; e++) {
        const d = HEX_DIRS[e]!;
        plateOfHexInto(h.q + d.q, h.r + d.r, plate);
        if (laid.has(plateKey(plate.i, plate.j))) continue;
        const c = deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
        const a = hexCornerInto(c.x, c.y, DECK_HEX_SIZE, e, { x: 0, y: 0 });
        const b = hexCornerInto(c.x, c.y, DECK_HEX_SIZE, (e + 1) % 6, { x: 0, y: 0 });
        out.push({ q: h.q, r: h.r, oq: h.q + d.q, or: h.r + d.r, a, b, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
      }
    }
  }
  return out;
}

/** Per bearing, the boundary seam nearest it whose inside hex is open floor
 *  (one gate per hex). */
function chooseGates(L: DeckLayout, seams: readonly Seam[]): Seam[] {
  const chosen: Seam[] = [];
  for (const bearing of GATE_BEARINGS) {
    let best: Seam | null = null, bestOff = GATE_SPREAD;
    for (const s of seams) {
      if (!L.isHexFree(s.q, s.r) || chosen.some((c) => c.q === s.q && c.r === s.r)) continue;
      const deg = (Math.atan2(s.m.y, s.m.x) * 180) / Math.PI;
      const off = Math.abs((((deg - bearing) % 360) + 540) % 360 - 180);
      if (off < bestOff) { bestOff = off; best = s; }
    }
    if (best !== null) chosen.push(best);
  }
  return chosen;
}

/** `kind` at the player's snap of (x, y); its index or -1. */
function placeSnapped(L: DeckLayout, kind: string, x: number, y: number): number {
  snapPlacementToDeck(kind, x, y, snap);
  const p: GrownPlacement = { kind: kind as GrownPlacement['kind'], x: snap.x, y: snap.y };
  if (snap.rot !== 0) p.rot = snap.rot;
  return L.B.tryPlace(p);
}

/** Most plates laid to move the ring off blocked corners. */
const MAX_WIDEN = 12;

/** The boundary seams, after widening the deck past every boundary corner a
 *  post cannot stand on (a dock's landing pad reaching its hex's corner):
 *  the plate beyond that corner is laid, so the corner is inside and the
 *  ring runs round the new plate. */
function clearBoundary(L: DeckLayout): Seam[] {
  for (let n = 0; n < MAX_WIDEN; n++) {
    const seams = boundarySeams(L);
    const blocked = seams.find((s) => !postFits(L, s.a) || !postFits(L, s.b));
    if (blocked === undefined) return seams;
    plateOfHexInto(blocked.oq, blocked.or, plate);
    if (!L.layPlate(plate.i, plate.j)) return seams;
  }
  return boundarySeams(L);
}

/** Would a post stand on corner `p` (placed and taken back)? */
function postFits(L: DeckLayout, p: HexPoint): boolean {
  if (placeSnapped(L, DECK_FENCE_POST_KIND, p.x, p.y) < 0) return false;
  L.B.undoLast();
  return true;
}

/** Ring `L`'s laid plates with a fence (see the header). */
export function layDeckFence(L: DeckLayout): DeckFence {
  let seams = clearBoundary(L);
  let gates = chooseGates(L, seams);
  if (gates.length === 0 && L.layNext()) {
    seams = clearBoundary(L);
    gates = chooseGates(L, seams);
  }
  const B = L.B;
  // The road network joining the gates (`growDeckRoads.ts`): planned now so
  // each gate road takes its turn; the rest is laid once the ring is up.
  let roads = planDeckRoads(L, gates);
  // Each gate after its road (the gate needs it); a road whose gate the
  // rules refuse is taken back (its hex stays open floor).
  const gateOn = new Map<Seam, number>();
  for (const s of gates) {
    if (L.placeOnHex({ kind: DECK_ROAD_KIND }, s.q, s.r, plannedTurn(roads, s.q, s.r), L.anchorAt(s.q, s.r)) < 0) continue;
    const g = placeSnapped(L, DECK_FENCE_GATE_KIND, s.m.x, s.m.y);
    if (g >= 0) gateOn.set(s, g);
    else { B.unlinkLast(); B.undoLast(); }
  }
  // A post on every boundary corner (shared corners once).
  const posts = new Map<string, number>();
  const postAt = (p: HexPoint): number => {
    const key = `${Math.round(p.x)},${Math.round(p.y)}`;
    let i = posts.get(key);
    if (i === undefined) posts.set(key, (i = placeSnapped(L, DECK_FENCE_POST_KIND, p.x, p.y)));
    return i;
  };
  for (const s of seams) { postAt(s.a); postAt(s.b); }
  // The ring: a wall per seam, or gate post → gate → gate post.
  for (const s of seams) {
    const a = postAt(s.a), b = postAt(s.b), g = gateOn.get(s);
    if (g !== undefined) {
      if (a >= 0) B.tryLink(g, a);
      if (b >= 0) B.tryLink(g, b);
    } else if (a >= 0 && b >= 0) B.tryLink(a, b);
  }
  // Taps: each plate's anchor feeds one post standing on that plate.
  for (const l of L.laid) {
    const anchor = B.placements[l.anchor]!;
    for (const i of posts.values()) {
      if (i < 0 || deckLinkKind(anchor, B.placements[i]!) !== DECK_LINK_ON_PLATE) continue;
      if (B.tryLink(l.anchor, i)) break;
    }
  }
  // A gate the rules refused leaves no road to join: plan without it.
  if (gateOn.size < gates.length) roads = planDeckRoads(L, [...gateOn.keys()]);
  layDeckRoads(L, roads);
  const blocked = new Set<string>();
  for (const s of gateOn.keys()) {
    plateOfHexInto(s.oq, s.or, plate);
    blocked.add(plateKey(plate.i, plate.j));
  }
  let pylons = 0;
  for (const i of posts.values()) if (i >= 0) pylons++;
  return { pylons, gates: gateOn.size, gateEnds: [...gateOn.keys()], blocksBastion: (i, j) => blocked.has(plateKey(i, j)) };
}
