/**
 * Wreck fields (macro terrain F3, wreck fields plan slice 1): an old
 * battlefield as a list of dead hulls a seed derives. Pure and deterministic
 * from `(seed, WRECK_FIELD_VERSION)`; server only (clients get each hull as an
 * ordinary wreck descriptor once it is loaded). Generation-time code, run
 * once per sector: not a hot path, allocates freely. `hullsInChunk` is the
 * one lookup a streamer calls often, and it reads a precomputed index.
 *
 * Extends the cut field (`fieldLayout.ts`): the same chunk grid (`chunkOf`),
 * key packing (`rockKey`, index = the hull's slot in its home chunk),
 * clearings (`FieldClearing`) and rock query (`fieldRocksInBox`), and the
 * wreck fracture (`wreckPieceGeometry` gives a hull's pieces from
 * `wreckFieldHullFracture`). docs/architecture/macro-terrain.md "F3".
 */
import { ANGLE_STEPS, unitDirFromSteps } from '../geometry/unitDir.js';
import { Rng, fnv1a32, fnvMixU32 } from '../random/rng.js';
import { getShipKind, SHIP_KINDS, type ShipKindId } from '../../shared-types/shipKinds.js';
import type { FactionId } from '../../shared-types/factions.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';
import { FRACTURE_SNAP_CHANCE } from '../destruction/fractureHull.js';
import type { WreckFractureInputs } from '../destruction/wreckPieceFrame.js';
import { wreckKindAllowed } from '../destruction/wreckKindAllowed.js';
import { chunkOf, cutFieldPad, rockKey, MAX_ROCKS_PER_CHUNK, SLICED, type ChunkOpts, type FieldClearing } from './fieldLayout.js';
import { fieldRocksInBox } from './chunkStreamer.js';

/** Bump on ANY change to the hulls a seed gives: saved field-hull records are
 *  keyed by it (`layout_version`), and a mismatch discards them. */
export const WRECK_FIELD_VERSION = 2;

/** The layout's knobs (owner Q1: a few mid-size fields plus a couple of
 *  debris trails). Counts are tuned against owner stills: 2026-11-18 the
 *  owner saw "one ship" per phone screen in a 50 km core and chose "tighter
 *  AND more wrecks" (wreck fields 11): a ~14 km core, 2.5x the small hulls. */
export const WRECK_FIELD = {
  /** Core disc radius (world u): ~14 km across (was 25,000, ~50 km). */
  coreRadius: 7_000,
  /** Hull counts in the whole field, [min, max] inclusive. The small hulls are
   *  the debris: fighter and sub-cap wrecks break into many small pieces. */
  capitals: [2, 4],
  subcaps: [25, 60],
  fighters: [75, 200],
  /** Debris trails leaving the core: count, length and start half-width
   *  (world u); a trail narrows to `trailTaper` of that at its end and bends
   *  by up to `trailBend` × its length sideways. */
  trails: [1, 2],
  trailLength: [8_000, 14_000],
  trailHalfWidth: 1_500,
  trailTaper: 0.4,
  trailBend: 0.15,
  /** Share of sub-caps and fighters that lie in the trails (capitals stay in
   *  the core). */
  trailShare: 0.25,
  /** A hull's footprint radius: × its kind radius. A sub-cap's pieces drift
   *  at most ~1.5 radii (`destruction.ts` subcap profile); a capital's hold
   *  their shape. Footprints never overlap. */
  footprintMul: 1.5,
  /** Gap kept between neighbouring footprints (world u). */
  gap: 200,
  /** A non-capital kind with at least this radius is a sub-cap, else a
   *  fighter (gunship 28, heavy 32, missile-frigate 48 vs fighter 24). */
  subcapMinRadius: 28,
  /** Share of hulls lying on the other side's half of the front. */
  sideMix: 0.25,
  /** How far past the core rim a blocked capital may look, in core radii
   *  (it widens over its tries; most land in the core). */
  capitalReach: 1.5,
  /** Tries per hull before it is dropped (a crowded or rocky spot). */
  attempts: 60,
} as const;

export type WreckFieldZone = 'core' | 'trail';

export interface WreckFieldHull {
  kindId: ShipKindId;
  /** The faction whose hull it was (livery only: the wreck is scrap). */
  owner: FactionId;
  /** Hull centre and resting angle (radians), world u. */
  x: number;
  y: number;
  angle: number;
  /** Home chunk (the chunk holding the centre). */
  cx: number;
  cy: number;
  /** Index within the home chunk (generation order). */
  slot: number;
  /** `rockKey(cx, cy, slot)`: the hull's record key in its partition. */
  key: number;
  /** Fracture seed (`wreckFieldHullFracture`). */
  seed: number;
  /** Footprint radius (world u): no other hull's footprint reaches it, and no
   *  rock or clearing lies within it. */
  footprint: number;
  zone: WreckFieldZone;
}

export interface WreckFieldTrail {
  /** Unit direction out of the core, length and bend (share of length). */
  dx: number;
  dy: number;
  length: number;
  bend: number;
}

export interface WreckField {
  seed: string;
  x: number;
  y: number;
  sides: readonly [FactionId, FactionId];
  trails: readonly WreckFieldTrail[];
  /** Every hull, in generation order. */
  hulls: readonly WreckFieldHull[];
  /** Hulls that found no free spot (crowded, rocks, clearings). */
  dropped: number;
  /** Hulls by home chunk (`chunkIndexKey`), each list by slot. */
  byChunk: ReadonlyMap<number, readonly WreckFieldHull[]>;
}

/** Is a circle (world u) blocked by something the field must not overlap
 *  (rocks)? `rockFieldBlocker` builds one from a cut field. */
export type WreckFieldBlocker = (x: number, y: number, r: number) => boolean;

export interface WreckFieldOpts {
  seed: string;
  /** Field centre (sector coordinates). */
  x: number;
  y: number;
  /** The two sides that fought here: faction ids (owner = one of them). */
  sides: readonly [FactionId, FactionId];
  /** Open clearings (gates, stations): no footprint reaches into one. */
  clearings?: readonly FieldClearing[];
  /** Occupied space (rocks): a blocked footprint is tried elsewhere. */
  blocked?: WreckFieldBlocker;
  /** The room's wreck switches (`wreckKindAllowed`); default both on. */
  capitalWrecksOn?: boolean;
  subcapWrecksOn?: boolean;
}

const EMPTY: readonly WreckFieldHull[] = Object.freeze([]);

/** The `byChunk` key of chunk (cx, cy). */
export function chunkIndexKey(cx: number, cy: number): number {
  return rockKey(cx, cy, 0);
}

/** The hulls whose centre lies in chunk (cx, cy), by slot. No allocation. */
export function hullsInChunk(field: WreckField, cx: number, cy: number): readonly WreckFieldHull[] {
  return field.byChunk.get(chunkIndexKey(cx, cy)) ?? EMPTY;
}

/** Kinds that can lie in a field, by class: playable kinds that wreck in a
 *  room with these switches, in catalogue order (deterministic). */
export function wreckFieldKinds(capitalOn: boolean, subcapOn: boolean): { capitals: ShipKindId[]; subcaps: ShipKindId[]; fighters: ShipKindId[] } {
  const capitals: ShipKindId[] = [], subcaps: ShipKindId[] = [], fighters: ShipKindId[] = [];
  for (const k of Object.values(SHIP_KINDS)) {
    if (k.npcOnly || k.engineeringOnly || !wreckKindAllowed(k.id, capitalOn, subcapOn)) continue;
    const id = k.id as ShipKindId;
    if (k.sizeClass === 'capital') capitals.push(id);
    else if (k.radius >= WRECK_FIELD.subcapMinRadius) subcaps.push(id);
    else fighters.push(id);
  }
  return { capitals, subcaps, fighters };
}

const unit = (r: Rng): number => r.u32() / 4294967296;
const between = (r: Rng, [lo, hi]: readonly [number, number]): number => lo + (hi - lo) * unit(r);

/** The hulls of one wreck field. Once per sector (generation-time). */
export function wreckField(o: WreckFieldOpts): WreckField {
  const W = WRECK_FIELD;
  const base = fnv1a32(`wrecks:${o.seed}`);
  // One named stream per choice, so a knob on one never reshuffles another.
  const rs = (name: number): Rng => new Rng(fnvMixU32(base, name));
  const shape = rs(1), counts = rs(2), place = rs(3), pick = rs(4), sideR = rs(5);
  const dir = { x: 0, y: 0 };

  const trails: WreckFieldTrail[] = [];
  const nTrails = shape.int(W.trails[0], W.trails[1]);
  for (let t = 0; t < nTrails; t++) {
    // Spread trails apart: the second leaves at least a quarter-turn away.
    unitDirFromSteps(((unit(shape) * 0.5 + t * 0.5) % 1) * ANGLE_STEPS, dir);
    trails.push({ dx: dir.x, dy: dir.y, length: between(shape, W.trailLength), bend: (unit(shape) * 2 - 1) * W.trailBend });
  }
  // The front: a line through the centre; side 0 lies on its positive half.
  unitDirFromSteps(unit(shape) * ANGLE_STEPS, dir);
  const front = { x: dir.x, y: dir.y };

  const kinds = wreckFieldKinds(o.capitalWrecksOn ?? true, o.subcapWrecksOn ?? true);
  const plan: Array<{ kind: ShipKindId; core: boolean }> = [];
  const add = (pool: ShipKindId[], range: readonly [number, number], trailable: boolean): void => {
    const n = counts.int(range[0], range[1]);
    if (pool.length === 0) return;
    for (let i = 0; i < n; i++) plan.push({ kind: pick.pick(pool), core: !trailable || unit(counts) >= W.trailShare });
  };
  // Biggest first, so capitals get room before the small hulls fill in.
  add(kinds.capitals, W.capitals, false);
  add(kinds.subcaps, W.subcaps, true);
  add(kinds.fighters, W.fighters, true);

  const clearings = o.clearings ?? [];
  const placed: Array<{ x: number; y: number; r: number }> = [];
  const free = (x: number, y: number, r: number): boolean => {
    for (const p of placed) {
      const dx = p.x - x, dy = p.y - y, m = p.r + r + W.gap;
      if (dx * dx + dy * dy < m * m) return false;
    }
    for (const k of clearings) {
      const dx = k.x - x, dy = k.y - y, m = k.r + r;
      if (dx * dx + dy * dy < m * m) return false;
    }
    return !o.blocked || !o.blocked(x, y, r);
  };

  const hulls: Omit<WreckFieldHull, 'slot' | 'key'>[] = [];
  let dropped = 0;
  for (let h = 0; h < plan.length; h++) {
    const { kind, core } = plan[h]!;
    const k = getShipKind(kind), capital = k.sizeClass === 'capital';
    const r = k.radius * W.footprintMul;
    let spot: { x: number; y: number; zone: WreckFieldZone } | null = null;
    for (let a = 0; a < W.attempts && !spot; a++) {
      let x: number, y: number;
      if (core || trails.length === 0) {
        // Uniform over the core disc. A capital may lie across its rim (a
        // 3-4 km footprint has little room in a 7 km core), and a blocked one
        // (rocks, the open battle pocket) looks further out each try, up to
        // `capitalReach` core radii more.
        unitDirFromSteps(unit(place) * ANGLE_STEPS, dir);
        const reach = W.coreRadius + (capital ? r + (a / W.attempts) * W.capitalReach * W.coreRadius : 0);
        const d = reach * Math.sqrt(unit(place));
        x = o.x + dir.x * d; y = o.y + dir.y * d;
      } else {
        // Along a trail, thinning outward (t^1.5), narrowing and bending.
        const tr = trails[place.int(0, trails.length - 1)]!;
        const u = unit(place), t = u * Math.sqrt(u);
        const along = W.coreRadius * 0.8 + t * tr.length;
        const side = (unit(place) * 2 - 1) * W.trailHalfWidth * (1 - (1 - W.trailTaper) * t) + tr.bend * t * t * tr.length;
        x = o.x + tr.dx * along - tr.dy * side; y = o.y + tr.dy * along + tr.dx * side;
      }
      if (free(x, y, r)) spot = { x, y, zone: core || trails.length === 0 ? 'core' : 'trail' };
    }
    if (!spot) { dropped++; continue; }
    placed.push({ x: spot.x, y: spot.y, r });
    const onFront = (spot.x - o.x) * front.x + (spot.y - o.y) * front.y >= 0;
    const mixed = unit(sideR) < W.sideMix;
    const c = chunkOf(spot.x, spot.y);
    hulls.push({
      kindId: kind, owner: o.sides[onFront !== mixed ? 0 : 1],
      x: spot.x, y: spot.y, angle: unit(place) * 2 * Math.PI,
      cx: c.cx, cy: c.cy, seed: fnvMixU32(base, 1000 + h), footprint: r, zone: spot.zone,
    });
  }

  // Slots: rank within the home chunk in generation order.
  const byChunk = new Map<number, WreckFieldHull[]>();
  const out: WreckFieldHull[] = [];
  for (const h of hulls) {
    const ck = chunkIndexKey(h.cx, h.cy);
    let list = byChunk.get(ck);
    if (!list) { list = []; byChunk.set(ck, list); }
    if (list.length >= MAX_ROCKS_PER_CHUNK) throw new Error(`chunk ${h.cx},${h.cy} holds too many hulls`);
    const full: WreckFieldHull = { ...h, slot: list.length, key: rockKey(h.cx, h.cy, list.length) };
    list.push(full);
    out.push(full);
  }
  return { seed: o.seed, x: o.x, y: o.y, sides: o.sides, trails, hulls: out, dropped, byChunk };
}

/** A field hull's break-up: a seeded kill point on its outline and seeded
 *  damage, as `buildWreckPieces` builds it for a live kill (no kill cut yet).
 *  `wreckPieceGeometry` turns it into the hull's pieces. */
export function wreckFieldHullFracture(hull: Pick<WreckFieldHull, 'kindId' | 'seed'>): WreckFractureInputs {
  const kind = getShipKind(hull.kindId);
  const r = new Rng(fnvMixU32(hull.seed, 0x6b11));
  const outline = shipHullOutline(kind);
  const i = r.int(0, outline.length - 1);
  const p = outline[i]!, q = outline[(i + 1) % outline.length]!, t = unit(r);
  return {
    kindId: hull.kindId,
    seed: hull.seed >>> 0,
    killX: p[0] + (q[0] - p[0]) * t,
    killY: p[1] + (q[1] - p[1]) * t,
    killBlowDamage: 0.2 + 0.8 * unit(r),
    recentDamageRate: 0.2 + unit(r),
    snapChance: DESTRUCTION_PROFILES[shipTuning(kind).destruction].fracture?.snapChance ?? FRACTURE_SNAP_CHANCE,
  };
}

type Pt = { x: number; y: number };

/** Does the circle (x, y, r) touch the polygon? */
export function circleTouchesPolygon(x: number, y: number, r: number, verts: readonly Pt[]): boolean {
  const r2 = r * r;
  let inside = false;
  for (let a = 0, b = verts.length - 1; a < verts.length; b = a++) {
    const pa = verts[a]!, pb = verts[b]!;
    if ((pa.y > y) !== (pb.y > y) && x < ((pb.x - pa.x) * (y - pa.y)) / (pb.y - pa.y) + pa.x) inside = !inside;
    const ex = pb.x - pa.x, ey = pb.y - pa.y, el = ex * ex + ey * ey;
    const s = el > 0 ? Math.max(0, Math.min(1, ((x - pa.x) * ex + (y - pa.y) * ey) / el)) : 0;
    const dx = pa.x + ex * s - x, dy = pa.y + ey * s - y;
    if (dx * dx + dy * dy < r2) return true;
  }
  return inside;
}

/** A blocker over a cut field's rocks (`fieldRocksInBox`, which cuts only the
 *  pieces near the box): a circle is blocked when it touches a rock's outline.
 *  A circle clear of the field's disc is answered without cutting. */
export function rockFieldBlocker(rocks: ChunkOpts): WreckFieldBlocker {
  const reach = (rocks.radius ?? SLICED.radius) + cutFieldPad();
  return (x, y, r) => {
    const d = Math.sqrt(x * x + y * y);
    if (d - r > reach) return false;
    for (const rock of fieldRocksInBox(rocks, x - r, y - r, x + r, y + r)) {
      if (circleTouchesPolygon(x, y, r, rock.verts)) return true;
    }
    return false;
  };
}
