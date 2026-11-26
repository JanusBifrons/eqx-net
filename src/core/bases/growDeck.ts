/**
 * Base platforms slice 23 — a generated base on the hex deck (plan
 * `.resume/base-platforms-plan.md`, "Generated bases"). The growth generator
 * (`growBase.ts`) plans what a base buys exactly as before; with the growth
 * option `deck` on (the room's `deck` flag) this lays it out on plates
 * instead of rows:
 *  1. A connector on the centre of the ORIGIN plate (0, 0) anchors the first
 *     plate (a system placement, like the `?room=deck` test room's prebuilt
 *     anchor: there is no deck to stand on yet).
 *  2. The Capital, then each building biggest first, takes the first free slot on a laid plate
 *     (plates in lay order, then the plate's outer hexes in `RING_ORDER`,
 *     every other hex first; the middle hex is the anchor's yard): a `'hex'`
 *     kind the hex centre, a `'small'` kind one of its three rhombi. Space is
 *     cheap (slice 24): a plate takes buildings on at most
 *     `DECK_HEXES_PER_PLATE` of its 6 outer hexes, so most deck is open floor. Every point goes
 *     through the player's own snap (`snapPlacementToDeck`), so position and
 *     turn are exactly where a player's ghost would put it, and links to its
 *     plate's anchor (the deck on-plate link).
 *  3. When no laid plate has room, the next plate is laid: a connector on the
 *     centre of the nearest unlaid plate to the origin that borders the deck,
 *     seam-linked to every laid neighbour's anchor.
 * Every placement passes the player's deck rule (`placementRejection` with
 * the base's own plate set: on its deck; a new plate borders it and is
 * clear) and every link the deck `canConnect` rule, through `Builder`.
 *
 * The seeder sites the base by its plate extent (`deckExtent`) on a plate
 * centre (`chooseBaseSite` with `deck`), so the whole deck is clear of rock.
 *
 * Dense (slice 25): a base in an asteroid-field clearing (growth option
 * `dense`, the seeder's field signal) fills all `DECK_HEXES_PER_PLATE_DENSE`
 * outer hexes of a plate, so it lays fewer plates and clears less rock; the
 * same layout, only the per-plate cap differs.
 *
 * Fenced (slice 26, `growDeckFence.ts`): a fenced profile's deck encloses
 * itself once its buildings are laid: shield pylons on every corner round the
 * OUTER boundary of the laid plates, linked seam by seam into a closed ring,
 * and road gates. Its guns then go OUTSIDE the fence (user ruling: a fence
 * blocks its own side's shots too) on bastion plates laid past the ring.
 */
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { HEX_DIRS, pixelToAxialInto, type AxialHex, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, PLATE_DIRS, deckHexCentreInto, plateCentreHexInto, plateCentreWorldInto, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import { rhombusCentroidInto, type DeckSnap } from '../hex/deckSnap.js';
import { PlateSet } from '../hex/plateSet.js';
import { snapPlacementToDeck } from '../structures/deckPlacement.js';
import { Builder, type GrownPlacement } from './growBuilder.js';
import { layDeckFence } from './growDeckFence.js';
import type { Want } from './roleUnits.js';

/** Growth options (`growBase`). Absent / false = today's row layout, unchanged. */
export interface GrowBaseOptions {
  /** Base platforms: lay the base on the hex deck (the room's `deck` flag). */
  deck?: boolean;
  /** With `deck`: a dense base (asteroid-field clearing) fills every outer
   *  hex of a plate (`DECK_HEXES_PER_PLATE_DENSE`) instead of the sparse cap. */
  dense?: boolean;
}

/** Most plates a generated base lays (a citadel needs well under this). */
export const DECK_MAX_PLATES = 96;
/** Turns tried for a `'hex'`-slot building (the snap rounds each to the
 *  kind's own rule); a `'small'` slot's turn is the rhombus's. */
const HEX_TURNS = [0, 90, 180, 270, 30, 60, 120, 150, 210, 240, 300, 330] as const;
/** "Mostly empty" (plan: space is cheap): the most outer hexes of one plate
 *  that hold buildings (small kinds share a hex). 3 of 6 leaves every other
 *  hex open floor; 6 packs a plate full (the dense variant, slice 25). */
export const DECK_HEXES_PER_PLATE = 3;
/** A dense (asteroid-field) deck base's cap: every outer hex (slice 25). */
export const DECK_HEXES_PER_PLATE_DENSE = 6;

/** The per-plate outer-hex cap the growth options ask for. */
export function deckHexesPerPlate(opts: GrowBaseOptions): number {
  return opts.dense === true ? DECK_HEXES_PER_PLATE_DENSE : DECK_HEXES_PER_PLATE;
}
/** Outer-hex fill order, as indices into `HEX_DIRS`: every other hex first,
 *  so the hexes a plate leaves empty are spread round it. */
const RING_ORDER = [0, 2, 4, 1, 3, 5] as const;

const snap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' };
const pt: HexPoint = { x: 0, y: 0 };
const hex: AxialHex = { q: 0, r: 0 };
const plate: PlateIndex = { i: 0, j: 0 };

/** Allocation-free: the world centre of the plate nearest (x, y), written
 *  into `out` (a deck base's Capital plate goes on the lattice). */
export function deckBaseOriginInto(x: number, y: number, out: HexPoint): HexPoint {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, hex);
  plateOfHexInto(hex.q, hex.r, plate);
  return plateCentreWorldInto(plate.i, plate.j, out);
}

/** Every plate within `DECK_MAX_PLATES`-ish reach, nearest the origin first
 *  (ties by angle), so each laid plate borders one laid before it. */
const PLATE_ORDER: ReadonlyArray<Readonly<PlateIndex>> = (() => {
  const all: Array<{ i: number; j: number; d: number; a: number }> = [];
  const p: HexPoint = { x: 0, y: 0 };
  for (let i = -8; i <= 8; i++) {
    for (let j = -8; j <= 8; j++) {
      plateCentreWorldInto(i, j, p);
      all.push({ i, j, d: Math.round(Math.hypot(p.x, p.y)), a: Math.atan2(p.y, p.x) });
    }
  }
  all.sort((u, v) => u.d - v.d || u.a - v.a);
  return all.map(({ i, j }) => ({ i, j }));
})();

/** One laid plate: its anchor's index and centre hex. */
export interface Laid {
  i: number;
  j: number;
  anchor: number;
  q: number;
  r: number;
}

export class DeckLayout {
  readonly B = new Builder(new PlateSet<number>());
  readonly laid: Laid[] = [];
  private next = 0;
  /** Hexes holding a `'hex'` building; per hex, the rhombi held (bit mask). */
  private readonly hexFull = new Set<string>();
  private readonly smallHeld = new Map<string, number>();
  /** Per laid plate (index into `laid`), outer hexes holding a building. */
  private readonly used: number[] = [];

  constructor(private readonly perPlate: number) {}

  /** Lay plate (i, j): a connector snapped to its centre, linked to every
   *  laid neighbour's anchor. Returns false (nothing left) when refused. */
  layPlate(i: number, j: number): boolean {
    plateCentreWorldInto(i, j, pt);
    snapPlacementToDeck('connector', pt.x, pt.y, snap);
    const a = this.B.tryPlace({ kind: 'connector', x: snap.x, y: snap.y });
    if (a < 0) return false;
    let linked = this.laid.length === 0;
    for (const d of PLATE_DIRS) {
      const n = this.laid.find((l) => l.i === i + d.i && l.j === j + d.j);
      if (n !== undefined && this.B.tryLink(n.anchor, a)) linked = true;
    }
    if (!linked) { this.B.undoLast(); return false; }
    plateCentreHexInto(i, j, hex);
    this.laid.push({ i, j, anchor: a, q: hex.q, r: hex.r });
    this.used.push(0);
    return true;
  }

  /** Lay the next plate in `PLATE_ORDER` that the deck rule accepts (and
   *  `skip`, when given, does not pass over for good). */
  layNext(skip?: (i: number, j: number) => boolean): boolean {
    while (this.laid.length < DECK_MAX_PLATES && this.next < PLATE_ORDER.length) {
      const p = PLATE_ORDER[this.next++]!;
      if (this.laid.some((l) => l.i === p.i && l.j === p.j)) continue;
      if (skip?.(p.i, p.j) === true) continue;
      if (this.layPlate(p.i, p.j)) return true;
    }
    return false;
  }

  /** Place `w` on the first free slot of a laid plate (from the
   *  `fromPlate`-th laid), linked to its anchor. Returns its index or -1. */
  place(w: Want, fromPlate: number): number {
    const small = getStructureKind(w.kind).deckSlot === 'small';
    for (let n = fromPlate; n < this.laid.length; n++) {
      const l = this.laid[n]!;
      for (const k of RING_ORDER) {
        const d = HEX_DIRS[k]!;
        const q = l.q + d.q, r = l.r + d.r, key = `${q},${r}`;
        if (this.hexFull.has(key)) continue;
        const held = this.smallHeld.get(key) ?? 0;
        if (!small && held !== 0) continue;
        // An empty hex on a plate at its cap stays open floor.
        if (held === 0 && this.used[n]! >= this.perPlate) continue;
        deckHexCentreInto(q, r, pt);
        const cx = pt.x, cy = pt.y;
        for (let s = 0; s < (small ? 3 : HEX_TURNS.length); s++) {
          if (small && (held & (1 << s)) !== 0) continue;
          if (small) rhombusCentroidInto(cx, cy, s, pt);
          const li = this.tryAt(w, small ? pt.x : cx, small ? pt.y : cy, small ? 0 : HEX_TURNS[s]!, l.anchor);
          if (li < 0) continue;
          if (held === 0) this.used[n] = this.used[n]! + 1;
          if (small) this.smallHeld.set(key, held | (1 << s));
          else this.hexFull.add(key);
          return li;
        }
      }
    }
    return -1;
  }

  /** Is deck hex (q, r) free of buildings? */
  isHexFree(q: number, r: number): boolean {
    const key = `${q},${r}`;
    return !this.hexFull.has(key) && (this.smallHeld.get(key) ?? 0) === 0;
  }

  /** A `'hex'` kind on the centre of hex (q, r), turned `rotDeg`, linked to
   *  `anchor` (a gate's road). Returns its index or -1. */
  placeOnHex(w: Want, q: number, r: number, rotDeg: number, anchor: number): number {
    deckHexCentreInto(q, r, pt);
    const li = this.tryAt(w, pt.x, pt.y, rotDeg, anchor);
    if (li >= 0) this.hexFull.add(`${q},${r}`);
    return li;
  }

  /** `w` at the player's snap of (x, y) turned `rotDeg`, linked to `anchor`. */
  private tryAt(w: Want, x: number, y: number, rotDeg: number, anchor: number): number {
    snapPlacementToDeck(w.kind, x, y, snap, rotDeg);
    const p: GrownPlacement = { kind: w.kind, x: snap.x, y: snap.y };
    if (snap.rot !== 0) p.rot = snap.rot;
    if (w.recipe) p.recipe = w.recipe;
    if (w.link) p.link = w.link;
    const li = this.B.tryPlace(p);
    if (li < 0) return -1;
    if (!this.B.tryLink(anchor, li)) { this.B.undoLast(); return -1; }
    return li;
  }
}

/**
 * Lay a planned base on the deck (see the header). `wants` is everything the
 * base bought plus its power, in any order; the Capital is added. Returns the
 * filled `Builder` (index 0 is the origin plate's anchor); `hexesPerPlate`
 * caps the outer hexes holding buildings per plate; a building that
 * fits neither a laid plate nor one fresh plate is left out.
 *
 * `guns` given (null = unfenced) = a fenced base: once `wants` are laid, the
 * fence rings the deck (`layDeckFence`) and `guns` go on bastion plates laid
 * outside it, never on a plate inside the ring.
 */
export function layDeckBase(wants: readonly Want[], hexesPerPlate: number = DECK_HEXES_PER_PLATE, guns: readonly Want[] | null = null): DeckBase {
  const L = new DeckLayout(hexesPerPlate);
  if (!L.layPlate(0, 0)) return { B: L.B, fencePylons: 0, fenceGates: 0 };
  const sized = (ws: readonly Want[]): Want[] => ws.filter((w) => {
    const s = getStructureKind(w.kind).deckSlot;
    return s === 'hex' || s === 'small';
  }).sort((a, b) => area(b) - area(a));
  for (const w of sized([{ kind: 'capital' }, ...wants])) {
    // Past the laid plates, one fresh plate: a building that fits no empty
    // plate never will, so it is left out rather than laying plate after plate.
    if (L.place(w, 0) < 0 && L.layNext()) L.place(w, L.laid.length - 1);
  }
  if (guns === null) return { B: L.B, fencePylons: 0, fenceGates: 0 };
  const fence = layDeckFence(L);
  // Bastions: plates laid from here on are outside the ring. A gun takes a
  // slot on a bastion plate (never an inside one), or one fresh bastion; no
  // bastion goes on a plate a gate opens onto.
  const inside = L.laid.length;
  for (const w of sized(guns)) {
    if (L.place(w, inside) < 0 && L.layNext(fence.blocksBastion)) L.place(w, L.laid.length - 1);
  }
  return { B: L.B, fencePylons: fence.pylons, fenceGates: fence.gates };
}

/** The Capital first, then the rest biggest first (they need the room). */
function area(w: Want): number {
  return w.kind === 'capital' ? Infinity : getStructureKind(w.kind).footprint.w * getStructureKind(w.kind).footprint.h;
}

/** A laid deck base: its builder and fence tally. */
export interface DeckBase {
  B: Builder;
  fencePylons: number;
  fenceGates: number;
}

/** Deck fence pieces in `placements` (posts, gates and gate roads). The tier
 *  structure cap leaves them out (slice 26): a deck's seam ring runs round
 *  plates 1300 u a hex, about twice the posts of a row base's rectangle, and
 *  counting them gutted fenced outposts and settlements (the cap's wealth cut
 *  ran to its last pass). */
export function deckFencePieces(placements: readonly GrownPlacement[]): number {
  let n = 0;
  for (const p of placements) if (p.kind === 'shield_pylon' || p.kind === 'shield_gate' || p.kind === 'road') n++;
  return n;
}
