/**
 * What a wreck was cut from (salvage stream, rock cut): a dead SHIP hull or
 * a mined-out ROCK. The ONE place the wreck code reads its whole-thing
 * numbers from (outline, scale, density, integrity, size and the parting
 * tuning), so the same fracture, re-split, integrity and kick code cuts both
 * (no parallel system; mining-and-salvage.md "Mining asteroids").
 *
 *  - A ship source is its kind's (`shipTuning`, `shipHullOutline`), exactly
 *    the numbers the wreck code read before, memoised per kind.
 *  - A rock source is the rock's own outline (`generateAsteroidVertices` of
 *    its stable-id shape seed and radius, the outline it collides and draws
 *    with), at scale 1: the "1× frame" of a rock IS its local rest frame
 *    (y flipped to the fracture's Pixi-up frame), so every piece's vertices
 *    and centroid (`WreckPieceGeometry.cx/cy`) stay in the parent rock's
 *    frame, cut after cut (a later per-vertex ore tint lines up). Mass is
 *    area × `ROCK_WRECK_DENSITY`, so a tractor (a fixed force) moves small
 *    pieces and barely a big one.
 *
 * Not hot-loop code: read at a break or a spawn; a rock source allocates once
 * per (shape, radius) on first use.
 */
import { DESTRUCTION_PROFILES, type DestructionProfile } from '../../shared-types/shipScale/destruction.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import {
  shipBodyMass, shipTuning, WRECK_COLLIDER_INSET_PER_RADIUS, WRECK_CRACK_PER_RADIUS, WRECK_PUSH_MAX_PER_RADIUS,
  WRECK_PUSH_MIN_PER_RADIUS, WRECK_SEPARATE_PER_RADIUS,
} from '../../shared-types/shipScale/tuning.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { generateAsteroidVertices, polygonArea } from '../swarm/asteroidShape.js';
import { WRECK_ROCK_PARENT_KIND, type WreckRockRef } from '../../shared-types/messages/wreckDescriptor.js';

/** The descriptor's `parentKind` of a rock's wreck (not a ship kind). */
export const ROCK_WRECK_PARENT_KIND = WRECK_ROCK_PARENT_KIND;

/** Mass per world unit² of a cut rock's pieces. A 30 u rock (~2,400 u²) is
 *  ~600, near the swarm's 500 default; a 2,000 u field rock is millions, so a
 *  tractor (a fixed force, accel F/m) never budges it whole. */
export const ROCK_WRECK_DENSITY = 0.25;

/** A rock's hidden integrity per unit² (with the rock profile's
 *  `integrityMul` 1): the mining laser (720 damage/s, rock factor 1) breaks a
 *  60 u rock (~9,600 u²) in ~2.7 s, a 500 u one in about three minutes. */
export const ROCK_INTEGRITY_PER_AREA = 0.2;

/** The rock a wreck was cut from (the descriptor's `rock`, as it rides the
 *  wire): its STABLE id (ore and a later tint key on it), its u16 shape seed
 *  (`asteroidShapeSeed(id)`) and radius, which give its outline. */
export type WreckRockSource = WreckRockRef;

export interface WreckSource {
  /** The ship kind, or null for a rock. */
  readonly ship: ShipKindId | null;
  readonly rock: WreckRockSource | null;
  /** The whole outline in the 1× Pixi-up frame (the fracture's input). */
  readonly outline: ReadonlyArray<readonly [number, number]>;
  /** World units per 1× unit (a rock's: 1). */
  readonly scale: number;
  /** The whole thing's world area, mass, "max hull" (integrity scale) and
   *  bounding radius. */
  readonly area: number;
  readonly bodyMass: number;
  readonly maxHull: number;
  readonly radius: number;
  /** The physics collider inset (world). */
  readonly inset: number;
  readonly profile: DestructionProfile;
  /** The parting tuning (`wreckBreakKicks`), world u/s. */
  readonly pushMin: number;
  readonly pushMax: number;
  readonly separate: number;
  readonly crack: number;
}

function ringArea(r: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

const shipCache = new Map<ShipKindId, WreckSource>();

/** A ship kind's source (memoised). */
export function shipWreckSource(kindId: ShipKindId): WreckSource {
  let s = shipCache.get(kindId);
  if (s !== undefined) return s;
  const kind = getShipKind(kindId);
  const t = shipTuning(kind);
  const sc = shipShapeScale(kind);
  const outline = shipHullOutline(kind);
  s = {
    ship: kindId, rock: null, outline, scale: sc, area: ringArea(outline) * sc * sc,
    bodyMass: shipBodyMass(kind), maxHull: kind.maxHealth, radius: kind.radius, inset: t.wreckColliderInset,
    profile: DESTRUCTION_PROFILES[t.destruction],
    pushMin: t.wreckPushMin, pushMax: t.wreckPushMax, separate: t.wreckSeparate, crack: t.wreckCrack,
  };
  shipCache.set(kindId, s);
  return s;
}

const rockCache = new Map<string, WreckSource>();
/** Rock sources kept (a cut field is a few hundred rocks at most). */
const ROCK_CACHE_MAX = 512;

/** A rock's source (memoised by shape and radius; the id rides along). */
export function rockWreckSource(rock: WreckRockSource): WreckSource {
  const key = `${rock.shape}:${rock.r}:${rock.id}`;
  let s = rockCache.get(key);
  if (s !== undefined) return s;
  // The rock's math-up outline, y flipped into the fracture's Pixi-up frame.
  const verts = generateAsteroidVertices(rock.shape, rock.r);
  const outline: Array<readonly [number, number]> = [];
  for (const v of verts) outline.push([v.x, -v.y] as const);
  const area = polygonArea(verts);
  const r = rock.r;
  s = {
    ship: null, rock: { id: rock.id, shape: rock.shape, r: rock.r }, outline, scale: 1, area,
    bodyMass: Math.max(1e-3, area * ROCK_WRECK_DENSITY), maxHull: area * ROCK_INTEGRITY_PER_AREA, radius: r,
    inset: WRECK_COLLIDER_INSET_PER_RADIUS * r, profile: DESTRUCTION_PROFILES.rock,
    pushMin: WRECK_PUSH_MIN_PER_RADIUS * r, pushMax: WRECK_PUSH_MAX_PER_RADIUS * r,
    separate: WRECK_SEPARATE_PER_RADIUS * r, crack: WRECK_CRACK_PER_RADIUS * r,
  };
  if (rockCache.size >= ROCK_CACHE_MAX) rockCache.clear();
  rockCache.set(key, s);
  return s;
}

/** A source from a ship kind or a source (the wreck helpers take either). */
export function asWreckSource(k: ShipKindId | WreckSource): WreckSource {
  return typeof k === 'string' ? shipWreckSource(k) : k;
}

/** The source of a wreck's root fracture inputs: its rock, else its kind. */
export function wreckSourceOf(root: { kindId?: ShipKindId; rock?: WreckRockSource }): WreckSource {
  if (root.rock !== undefined) return rockWreckSource(root.rock);
  if (root.kindId === undefined) throw new Error('wreck inputs name neither a ship kind nor a rock');
  return shipWreckSource(root.kindId);
}
