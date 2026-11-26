/**
 * Junction sign boards — the road walk (pure, cold path). What a junction's
 * sign says: for each road arm leaving the junction, the nearest places down
 * that road.
 *
 * From the junction hex, each arm is followed hex by hex along the road tiles
 * (breadth first, never back through the junction), so every road hex down
 * that arm gets its step count. A building is "on" an arm when one of its
 * deck hexes is next to (or is) a road hex of that arm; its distance is the
 * smallest such step count. A building reachable down two arms (a loop) is
 * listed under the nearer one only. Each arm keeps its nearest
 * {@link SIGN_PLACES_PER_ARM} distinct kinds.
 *
 * Footprints are the deck slots, not one hex: `'hex'` and `'small'` buildings
 * stand in the hex holding their centre (a small slot is a third of it), a
 * `'plate'` building covers its whole plate (`plateHexes`). Corner and edge
 * slots (fence posts, gates) are never places ({@link isSignPlaceKind}).
 *
 * Runs only when a board opens or its base changed (`deckSignBoard.ts`), so it
 * may allocate.
 */
import { HEX_DIRS, hexNeighbourInto, pixelToAxialInto, type AxialHex } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE, plateHexes, plateOfHexInto, type PlateIndex } from '../../../core/hex/plates.js';
import { DECK_ROAD_KIND } from '../../../core/structures/deckGateRoad.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../../core/structures/deckLinks.js';
import { STRUCTURE_KINDS, getStructureKind, isConnectorKind } from '../../../shared-types/structureKinds.js';
import { hexKey } from './roadJoins.js';

/** Places a sign lists per arm. */
export const SIGN_PLACES_PER_ARM = 2;

/**
 * World join bit `i` (the edge at game angle 60°·i, `roadWorldJoins`) → the
 * `HEX_DIRS` neighbour across it (pointy-top axial, pixel y = game y:
 * (1, 0) is 0°, (0, 1) is 60°, …).
 */
export const JOIN_HEX_DIR: readonly number[] = [5, 0, 1, 2, 3, 4];

/** Infrastructure and defences: never a place on a sign. */
const NOT_PLACES: ReadonlySet<string> = new Set([
  DECK_ROAD_KIND, DECK_FENCE_POST_KIND, DECK_FENCE_GATE_KIND, 'shield_airlock', 'cargo_bay', 'battery', 'territory_lock', 'pocket_pad',
]);

/** Is a structure of `kind` a place a junction sign names? Not roads, gates,
 *  pylons, connectors (a plate building that is one, the Large Teleporter,
 *  is a place), cargo / power infrastructure or weapons. */
export function isSignPlaceKind(kind: string | undefined): boolean {
  if (kind === undefined || NOT_PLACES.has(kind) || !(kind in STRUCTURE_KINDS)) return false;
  const k = getStructureKind(kind);
  if (isConnectorKind(kind) && k.deckSlot !== 'plate') return false;
  return k.weaponRange === undefined;
}

/** A building on the deck: its kind and centre (game frame). */
export interface SignSite { kind: string; x: number; y: number }
/** One place on a sign. `steps`: road hexes from the junction. */
export interface SignPlace { kind: string; name: string; color: number; steps: number }
/** One road arm: world direction `dir` (game angle 60°·dir) and its places, nearest first. */
export interface ArmSign { dir: number; places: SignPlace[] }

/** The deck hexes a building of `kind` centred at (x, y) stands on. */
export function siteHexes(kind: string, x: number, y: number): AxialHex[] {
  const h = pixelToAxialInto(x, y, DECK_HEX_SIZE, { q: 0, r: 0 });
  if (getStructureKind(kind).deckSlot !== 'plate') return [h];
  const p: PlateIndex = plateOfHexInto(h.q, h.r, { i: 0, j: 0 });
  return plateHexes(p.i, p.j);
}

/** Road steps from the junction (jq, jr) to every road hex down the arm
 *  across world edge `dir`; empty when no road leaves that way. */
export function armReach(jq: number, jr: number, dir: number, roadHexes: ReadonlySet<number>): Map<number, number> {
  const dist = new Map<number, number>();
  const start = hexNeighbourInto(jq, jr, JOIN_HEX_DIR[dir]!, { q: 0, r: 0 });
  const k0 = hexKey(start.q, start.r);
  if (!roadHexes.has(k0)) return dist;
  const seen = new Set<number>([hexKey(jq, jr), k0]);
  const qs: number[] = [start.q], rs: number[] = [start.r], ds: number[] = [1];
  const n: AxialHex = { q: 0, r: 0 };
  for (let head = 0; head < qs.length; head++) {
    const q = qs[head]!, r = rs[head]!, d = ds[head]!;
    dist.set(hexKey(q, r), d);
    for (let e = 0; e < HEX_DIRS.length; e++) {
      hexNeighbourInto(q, r, e, n);
      const k = hexKey(n.q, n.r);
      if (seen.has(k) || !roadHexes.has(k)) continue;
      seen.add(k);
      qs.push(n.q); rs.push(n.r); ds.push(d + 1);
    }
  }
  return dist;
}

/** The fewest road steps from an arm's reach to a building on `hexes` (a road
 *  hex next to one of them, or under it); Infinity when none. */
function stepsTo(hexes: readonly AxialHex[], reach: ReadonlyMap<number, number>): number {
  let best = Infinity;
  const n: AxialHex = { q: 0, r: 0 };
  for (const h of hexes) {
    best = Math.min(best, reach.get(hexKey(h.q, h.r)) ?? Infinity);
    for (let e = 0; e < HEX_DIRS.length; e++) {
      hexNeighbourInto(h.q, h.r, e, n);
      best = Math.min(best, reach.get(hexKey(n.q, n.r)) ?? Infinity);
    }
  }
  return best;
}

/**
 * What the sign at junction (jq, jr) says: one entry per road arm (in world
 * direction order), each with its nearest places. `roadHexes`: every road
 * tile's {@link hexKey}; `sites`: the deck's buildings (non-places skipped).
 */
export function walkJunctionArms(jq: number, jr: number, roadHexes: ReadonlySet<number>, sites: readonly SignSite[], perArm = SIGN_PLACES_PER_ARM): ArmSign[] {
  const dirs: number[] = [];
  const reaches: Map<number, number>[] = [];
  for (let i = 0; i < 6; i++) {
    const reach = armReach(jq, jr, i, roadHexes);
    if (reach.size === 0) continue;
    dirs.push(i);
    reaches.push(reach);
  }
  const found: { arm: number; place: SignPlace }[] = [];
  for (const s of sites) {
    if (!isSignPlaceKind(s.kind)) continue;
    const hexes = siteHexes(s.kind, s.x, s.y);
    let arm = -1, steps = Infinity;
    for (let a = 0; a < reaches.length; a++) {
      const d = stepsTo(hexes, reaches[a]!);
      if (d < steps) { steps = d; arm = a; }
    }
    if (arm < 0) continue;
    const k = getStructureKind(s.kind);
    found.push({ arm, place: { kind: s.kind, name: k.displayName, color: k.color, steps } });
  }
  found.sort((a, b) => a.place.steps - b.place.steps || a.place.name.localeCompare(b.place.name));
  const out: ArmSign[] = dirs.map((dir) => ({ dir, places: [] }));
  for (const f of found) {
    const places = out[f.arm]!.places;
    if (places.length >= perArm || places.some((p) => p.kind === f.place.kind)) continue;
    places.push(f.place);
  }
  return out;
}
