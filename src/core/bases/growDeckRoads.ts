/**
 * Base platforms slice 32 — a generated deck base's roads between its gates
 * (owner: "make some roads between the gates"). Players lay roads by hand;
 * a fenced generated base (`growDeckFence.ts`) has one road hex inside each
 * gate, and this joins them into ONE road network inside the fence:
 *  1. Open floor: a hex of an inside plate (every plate laid when the fence
 *     goes up) that is not a plate's middle hex (the anchor's yard), holds no
 *     building (`DeckLayout.isHexFree`), and takes a road under the player's
 *     rule at one of the road turns (`ROAD_TURNS`, probed, taken back).
 *  2. A tidy tree, not parallel streets: the first gate's road starts the
 *     network; each round the gate nearest any part of it (shortest path over
 *     open floor, ties by gate order) joins it along that path. A step beside
 *     the Capital costs a little less, so a route passes it when that is
 *     cheap. Laid road hexes (a re-plan, step 5) are open floor at a token
 *     cost, so a re-plan reuses them.
 *  3. Turns: the carriageway runs along the road's local x, across its art
 *     hex corner to corner; on the pointy-top deck cells that is one of 30°,
 *     90°, 150°. Each road takes the one best lined up with its links in the
 *     network (and a gate road with its gate, the hex outside).
 *  4. Room for roads: a sparse plate's open floor is every other outer hex,
 *     so open hexes rarely border each other. `layDeckBase` plans the network
 *     once THROUGH the first layout's buildings (`reserveDeckRoads`: a
 *     building's hex costs more, the Capital's is never taken), then lays the
 *     base out again with those hexes kept open; the second layout is kept
 *     only when it joins more gates and loses nothing (at most two more
 *     inside plates, `DECK_ROAD_EXTRA_PLATES`). Every gate is joined (owner: "Join every gate", even if
 *     that costs more road): the second layout lays the plates the reserved
 *     roads run over and keeps the first layout's gate hexes, and while a gate
 *     is still unjoined the network is reserved again on that layout and the
 *     base laid once more (`DECK_ROAD_PASSES`).
 *  5. Lay time: a planned road the rules refuse is routed round: the network
 *     is planned again on what is free (laid roads count as floor) and the
 *     missing roads laid (`layDeckRoadNetwork`).
 *  6. No stubs: the kept layout is laid a last time with only the gates its
 *     network can join (`joinableEnds`); a gate no free path reaches is not
 *     laid at all rather than left as a lone road.
 * The fence lays the gate roads (each before its gate) at their planned
 * turns, then the rest once the ring is up (`layDeckRoadNetwork`). A road takes no
 * cable: it belongs to the base whose deck it sits on.
 * Deterministic: no random draws; every order is fixed.
 */
import { HEX_DIRS, pixelToAxialInto, type AxialHex, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, isPlateCentreHex, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import type { DeckSnap } from '../hex/deckSnap.js';
import { snapPlacementToDeck } from '../structures/deckPlacement.js';
import { DECK_ROAD_KIND } from '../structures/deckGateRoad.js';
import type { DeckLayout } from './growDeck.js';
import type { Builder } from './growBuilder.js';

/** Road turns on the pointy-top deck (carriageway corner to corner). */
export const ROAD_TURNS = [30, 90, 150] as const;
/** A lone road's turn (lined up with the deck cells, `deckTiles.ts`). */
export const ROAD_TURN = ROAD_TURNS[0];
const ALL_TURNS = (1 << ROAD_TURNS.length) - 1;
/** Path step costs: a step beside the Capital is a little cheaper. */
const STEP = 10;
const STEP_BY_CAPITAL = 9;
/** Reserving (`reserveDeckRoads`): a step onto a building's hex costs
 *  this much more (it moves that building elsewhere). */
const STEP_MOVES_BUILDING = 30;
/** A step along a road already laid (a re-plan reuses it). */
const STEP_ON_ROAD = 1;
/** Most re-plans at lay time (`layDeckRoadNetwork`). */
const LAY_REPLANS = 3;

/** A gate's road hex (q, r) and the hex outside its gate (oq, or). */
export interface RoadEnd {
  q: number;
  r: number;
  oq: number;
  or: number;
}

/** One planned road. */
export interface PlannedRoad {
  q: number;
  r: number;
  rot: number;
  /** A gate's own road (the fence lays it before its gate). */
  gate: boolean;
}

const key = (q: number, r: number): string => `${q},${r}`;
const snap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' };
const plate: PlateIndex = { i: 0, j: 0 };
const c0: HexPoint = { x: 0, y: 0 };
const c1: HexPoint = { x: 0, y: 0 };

/** Plan the road network joining `ends` (see the header): gate roads first
 *  (in `ends` order), then the joining roads in the order they were laid out.
 *  `through` (reserving, `reserveDeckRoads`): a building's hex is open
 *  too, at a higher cost (all but the Capital's); the first `insidePlates`
 *  laid plates are inside the fence. */
export function planDeckRoads(L: DeckLayout, ends: readonly RoadEnd[], through = false, insidePlates = L.laid.length): PlannedRoad[] {
  if (ends.length === 0) return [];
  const inside = new Set(L.laid.slice(0, insidePlates).map((l) => key(l.i, l.j)));
  const capital = capitalHex(L);
  const endAt = new Map<string, RoadEnd>();
  for (const e of ends) endAt.set(key(e.q, e.r), e);
  const laidRoads = roadHexes(L.B);
  const fits = new Map<string, number>();
  /** Mask of `ROAD_TURNS` a road takes on hex (q, r); 0 = not open floor. */
  const fitOf = (q: number, r: number): number => {
    const k = key(q, r);
    let m = fits.get(k);
    if (m === undefined) {
      m = 0;
      plateOfHexInto(q, r, plate);
      if (!inside.has(key(plate.i, plate.j)) || isPlateCentreHex(q, r)) m = 0;
      else if (through) m = k === capital ? 0 : ALL_TURNS;
      else if (L.isHexFree(q, r)) {
        deckHexCentreInto(q, r, c0);
        for (let t = 0; t < ROAD_TURNS.length; t++) {
          snapPlacementToDeck(DECK_ROAD_KIND, c0.x, c0.y, snap, ROAD_TURNS[t]);
          if (L.B.tryPlace({ kind: DECK_ROAD_KIND, x: snap.x, y: snap.y, rot: snap.rot }) < 0) continue;
          L.B.undoLast();
          m |= 1 << t;
        }
      }
      // A gate's hex is the fence's to judge, a laid road's is already
      // road: both are always open floor.
      if (m === 0 && (endAt.has(k) || laidRoads.has(k))) m = ALL_TURNS;
      fits.set(k, m);
    }
    return m;
  };
  const byCapital = capitalNeighbours(capital);
  const stepCost = (q: number, r: number): number => {
    const k = key(q, r);
    if (laidRoads.has(k) && !endAt.has(k)) return STEP_ON_ROAD;
    return (byCapital.has(k) ? STEP_BY_CAPITAL : STEP) + (through && !L.isHexFree(q, r) && !endAt.has(k) ? STEP_MOVES_BUILDING : 0);
  };
  const net = new Set<string>();
  const order: AxialHex[] = [];
  const links = new Map<string, AxialHex[]>();
  const link = (a: AxialHex, b: AxialHex): void => {
    (links.get(key(a.q, a.r)) ?? links.set(key(a.q, a.r), []).get(key(a.q, a.r))!).push(b);
    (links.get(key(b.q, b.r)) ?? links.set(key(b.q, b.r), []).get(key(b.q, b.r))!).push(a);
  };
  const add = (h: AxialHex): void => { net.add(key(h.q, h.r)); order.push(h); };
  for (;;) {
    const waiting = ends.filter((e) => !net.has(key(e.q, e.r)));
    if (waiting.length === 0) break;
    const path = net.size === 0 ? null : nearestPath(net, waiting, fitOf, stepCost);
    if (path === null) { add({ q: waiting[0]!.q, r: waiting[0]!.r }); continue; }
    // path[0] is on the network already; the rest joins it.
    for (let n = 1; n < path.length; n++) {
      if (!net.has(key(path[n]!.q, path[n]!.r))) add(path[n]!);
      link(path[n - 1]!, path[n]!);
    }
  }
  const gates = order.filter((h) => endAt.has(key(h.q, h.r)));
  const rest = order.filter((h) => !endAt.has(key(h.q, h.r)));
  return [...gates, ...rest].map((h) => {
    const e = endAt.get(key(h.q, h.r));
    const towards = [...(links.get(key(h.q, h.r)) ?? [])];
    if (e !== undefined) towards.push({ q: e.oq, r: e.or });
    return { q: h.q, r: h.r, rot: bestTurn(h, towards, fitOf(h.q, h.r)), gate: e !== undefined };
  });
}

/** The planned road on hex (q, r)'s turn, or `ROAD_TURN` when unplanned. */
export function plannedTurn(plan: readonly PlannedRoad[], q: number, r: number): number {
  return plan.find((p) => p.q === q && p.r === r)?.rot ?? ROAD_TURN;
}

/** Lay the planned joining roads (the gate roads are the fence's), each at
 *  its turn or, refused there, another; no cable (a road takes none). A road
 *  the rules refuse is left out. Returns how many were refused. */
export function layDeckRoads(L: DeckLayout, plan: readonly PlannedRoad[]): number {
  let refused = 0;
  for (const p of plan) {
    if (p.gate || !L.isHexFree(p.q, p.r)) continue;
    let laid = false;
    for (const rot of [p.rot, ...ROAD_TURNS.filter((t) => t !== p.rot)]) {
      if (L.placeOnHex({ kind: DECK_ROAD_KIND }, p.q, p.r, rot, -1) >= 0) { laid = true; break; }
    }
    if (!laid) refused++;
  }
  return refused;
}

/** Lay the road network joining `ends` (their gate roads laid): plan, lay,
 *  and while a planned road was refused, plan again on what is free (laid
 *  roads count as floor) and lay what is missing (see the header, step 5). */
export function layDeckRoadNetwork(L: DeckLayout, ends: readonly RoadEnd[]): void {
  for (let n = 0; n <= LAY_REPLANS; n++) {
    if (layDeckRoads(L, planDeckRoads(L, ends)) === 0) return;
  }
}

/** The gates (of `ends`, in order) the road network can join on `L` as it
 *  stands: the biggest group the plan links (ties: the earliest gate's). */
export function joinableEnds(L: DeckLayout, ends: readonly RoadEnd[]): RoadEnd[] {
  if (ends.length < 2) return [...ends];
  return largestGroup(new Set(planDeckRoads(L, ends).map((p) => key(p.q, p.r))), ends);
}

/** The hexes of a road network joining `ends` on a laid-out base, through
 *  its buildings where that is shorter (never the Capital's hex). The base is
 *  laid out again with them reserved (`layDeckBase`), so its buildings go
 *  round the roads (see the header, step 4). */
export function reserveDeckRoads(L: DeckLayout, insidePlates: number, ends: readonly RoadEnd[]): Set<string> {
  return new Set(planDeckRoads(L, ends, true, insidePlates).map((p) => key(p.q, p.r)));
}

/** The Capital's hex key, or ''. */
function capitalHex(L: DeckLayout): string {
  const cap = L.B.placements.find((p) => p.kind === 'capital');
  if (cap === undefined) return '';
  const h = pixelToAxialInto(cap.x, cap.y, DECK_HEX_SIZE, { q: 0, r: 0 });
  return key(h.q, h.r);
}

/** Hex keys of the road tiles laid in `B`. */
function roadHexes(B: Builder): Set<string> {
  const roads = new Set<string>();
  const h: AxialHex = { q: 0, r: 0 };
  for (const p of B.placements) {
    if (p.kind !== DECK_ROAD_KIND) continue;
    pixelToAxialInto(p.x, p.y, DECK_HEX_SIZE, h);
    roads.add(key(h.q, h.r));
  }
  return roads;
}

/** The most gate roads (of `ends`) on one network of bordering road tiles. */
export function gatesJoined(B: Builder, ends: readonly RoadEnd[]): number {
  return largestGroup(roadHexes(B), ends).length;
}

/** Of `ends`, the most on one network of bordering `roads` hexes (in
 *  `ends` order; ties: the group of the earliest end). */
function largestGroup(roads: ReadonlySet<string>, ends: readonly RoadEnd[]): RoadEnd[] {
  let best: RoadEnd[] = [];
  for (const e of ends) {
    const seen = new Set([key(e.q, e.r)]);
    const open: AxialHex[] = [{ q: e.q, r: e.r }];
    while (open.length > 0) {
      const at = open.pop()!;
      for (const d of HEX_DIRS) {
        const k = key(at.q + d.q, at.r + d.r);
        if (roads.has(k) && !seen.has(k)) { seen.add(k); open.push({ q: at.q + d.q, r: at.r + d.r }); }
      }
    }
    const group = ends.filter((o) => seen.has(key(o.q, o.r)));
    if (group.length > best.length) best = group;
  }
  return best;
}

/** Hexes beside the Capital's hex (a cheaper step). */
function capitalNeighbours(capital: string): Set<string> {
  const out = new Set<string>();
  if (capital === '') return out;
  const [q, r] = capital.split(',').map(Number) as [number, number];
  for (const d of HEX_DIRS) out.add(key(q + d.q, r + d.r));
  return out;
}

/** Shortest path (Dijkstra over open floor) from any network hex to the
 *  nearest `waiting` gate road (ties by `waiting` order); network hex first.
 *  Null when none is reachable. */
function nearestPath(
  net: ReadonlySet<string>, waiting: readonly RoadEnd[], fitOf: (q: number, r: number) => number, stepCost: (q: number, r: number) => number,
): AxialHex[] | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, AxialHex>();
  const done = new Set<string>();
  const open: AxialHex[] = [];
  for (const k of net) {
    const [q, r] = k.split(',').map(Number) as [number, number];
    dist.set(k, 0);
    open.push({ q, r });
  }
  const goal = new Map(waiting.map((e, i) => [key(e.q, e.r), i]));
  let best: AxialHex | null = null, bestCost = Infinity, bestRank = Infinity;
  while (open.length > 0) {
    // Cheapest open hex; ties keep the earliest found (deterministic).
    let at = 0;
    for (let n = 1; n < open.length; n++) if (dist.get(key(open[n]!.q, open[n]!.r))! < dist.get(key(open[at]!.q, open[at]!.r))!) at = n;
    const h = open.splice(at, 1)[0]!;
    const hk = key(h.q, h.r);
    if (done.has(hk)) continue;
    done.add(hk);
    const d = dist.get(hk)!;
    if (d > bestCost) break;
    const rank = goal.get(hk);
    if (rank !== undefined && (d < bestCost || rank < bestRank)) { best = h; bestCost = d; bestRank = rank; }
    for (const dir of HEX_DIRS) {
      const o = { q: h.q + dir.q, r: h.r + dir.r }, ok = key(o.q, o.r);
      if (done.has(ok) || fitOf(o.q, o.r) === 0) continue;
      const nd = d + stepCost(o.q, o.r);
      if (nd >= (dist.get(ok) ?? Infinity)) continue;
      dist.set(ok, nd);
      prev.set(ok, h);
      open.push(o);
    }
  }
  if (best === null) return null;
  const path: AxialHex[] = [best];
  for (let p = prev.get(key(best.q, best.r)); p !== undefined; p = prev.get(key(p.q, p.r))) path.push(p);
  return path.reverse();
}

/** Of the turns in `mask`, the one whose carriageway best lines up with the
 *  directions from `h` to `towards` (ties: `ROAD_TURNS` order). */
function bestTurn(h: AxialHex, towards: readonly AxialHex[], mask: number): number {
  deckHexCentreInto(h.q, h.r, c0);
  let best: number = ROAD_TURN, bestScore = -1;
  for (let t = 0; t < ROAD_TURNS.length; t++) {
    if ((mask & (1 << t)) === 0) continue;
    const a = (ROAD_TURNS[t]! * Math.PI) / 180, ax = Math.cos(a), ay = Math.sin(a);
    let s = 0;
    for (const o of towards) {
      deckHexCentreInto(o.q, o.r, c1);
      const dx = c1.x - c0.x, dy = c1.y - c0.y;
      s += Math.abs(dx * ax + dy * ay) / Math.hypot(dx, dy);
    }
    s = Math.round(s * 1e6);
    if (s > bestScore) { bestScore = s; best = ROAD_TURNS[t]!; }
  }
  return best;
}
