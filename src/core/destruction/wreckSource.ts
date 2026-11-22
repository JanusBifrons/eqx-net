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
 *  - A cut-FIELD rock (its ref carries `fk`, its field rock key) has no
 *    shape seed: its outline is the field layout's own (`fieldRockBody` of
 *    its chunk's `rocksInChunk` entry, the outline it collides and draws
 *    with), so the room's field options (`cutFieldOpts` of the welcome's
 *    seed and clearings) must ride with it (`WreckRockSource.field`).
 *  - A structure source is its kind's socket outline (`structureOutline(k,
 *    SOCKET_OUTLINE_STYLE)`, the edge players see, inside the footprint box
 *    it collides with), y flipped into the Pixi-up frame exactly as
 *    `structureRenderVerts` draws it, at scale 1: what you see is what
 *    breaks. Its quarter-turn is the body's angle (the death pose), so the
 *    source is per kind (`structureWreckSource`).
 *
 * Not hot-loop code: read at a break or a spawn; a rock source allocates once
 * per rock (shape, radius, id) on first use.
 */
import { DESTRUCTION_PROFILES, type DestructionProfile } from '../../shared-types/shipScale/destruction.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import {
  shipBodyMass, shipTuning, WRECK_COLLIDER_INSET_PER_RADIUS, WRECK_CRACK_PER_RADIUS, WRECK_PUSH_MAX_PER_RADIUS,
  WRECK_PUSH_MIN_PER_RADIUS, WRECK_SEPARATE_PER_RADIUS,
} from '../../shared-types/shipScale/tuning.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { generateAsteroidVertices, polygonArea } from '../swarm/asteroidShape.js';
import {
  WRECK_ROCK_PARENT_KIND, WRECK_STRUCTURE_PARENT_KIND, type WreckRockRef, type WreckStructureRef,
} from '../../shared-types/messages/wreckDescriptor.js';
import { rocksInChunk, unpackRockKey, type ChunkOpts } from '../terrain/fieldLayout.js';
import { fieldRockBody } from '../terrain/chunkStreamer.js';
import { getStructureKind, SOCKET_OUTLINE_STYLE, structureOutline, type StructureKindId } from '../../shared-types/structureKinds.js';
import { destructionProfile } from '../../shared-types/shipScale/destructionProfile.js';

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
 *  (`asteroidShapeSeed(id)`) and radius, which give its outline. A field
 *  rock (`fk`) also needs its room's field options (`field`), never on
 *  the wire: each side attaches its own (the welcome's, on a client). */
export type WreckRockSource = WreckRockRef & { readonly field?: ChunkOpts | null };

/** The structure a wreck was broken from (the descriptor's `structure`,
 *  as it rides the wire): its kind (`k`). */
export type { WreckStructureRef };

/** The descriptor's `parentKind` of a structure's wreck (not a ship kind). */
export const STRUCTURE_WRECK_PARENT_KIND = WRECK_STRUCTURE_PARENT_KIND;

/** A structure's body mass per world unit² of outline: one density with a
 *  cut rock's (`ROCK_WRECK_DENSITY`), so a structure's piece weighs like
 *  rock of its size (the tractor and re-split rules read mass). The live
 *  structure body's mass (`STRUCTURE_DEFAULT_MASS`, 5000 for every kind)
 *  is an "immovable" stand-in, not a catalogue number. */
export const STRUCTURE_WRECK_DENSITY = ROCK_WRECK_DENSITY;

export interface WreckSource {
  /** The ship kind, or null for a rock or a structure. */
  readonly ship: ShipKindId | null;
  readonly rock: WreckRockSource | null;
  /** The structure, or null for a ship or a rock. Exactly one of the three
   *  is set. */
  readonly structure: WreckStructureRef | null;
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
    ship: kindId, rock: null, structure: null, outline, scale: sc, area: ringArea(outline) * sc * sc,
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

/** A field rock's outline in its body frame (math-up, centred as its body
 *  is), straight from the field layout (`fieldRockBody`), and its bounding
 *  radius. Throws for a key the layout has no rock for. Generation-time:
 *  cuts the rock's chunk. */
export function fieldRockOutline(field: ChunkOpts, fk: number): { verts: Array<{ x: number; y: number }>; radius: number } {
  const { cx, cy, index } = unpackRockKey(fk);
  const rock = rocksInChunk(field, cx, cy)[index];
  if (rock === undefined) throw new Error(`field rock ${fk} (chunk ${cx},${cy} #${index}) is not in the layout`);
  const b = fieldRockBody(rock);
  return { verts: b.verts, radius: b.radius };
}

/** The field's identity in a cache key (seed and clearings shape the cut). */
function fieldCacheKey(f: ChunkOpts): string {
  let k = `${f.seed}|${f.battleshipLength}|${f.fighterLength}|${f.radius ?? ''}`;
  for (const c of f.clearings ?? []) k += `|${c.x},${c.y},${c.r}`;
  return k;
}

/** A rock's source, memoised per rock (shape, radius and id: the id rides
 *  on the source, so two rocks of one shape and radius keep their own). A
 *  field rock (`fk`) is memoised per field, key and id, and needs `field`
 *  (default: the source's own). */
export function rockWreckSource(rock: WreckRockSource, field: ChunkOpts | null | undefined = rock.field): WreckSource {
  const fk = rock.fk;
  if (fk !== undefined && (field === undefined || field === null)) throw new Error(`field rock ${rock.id}: no field options to cut it from`);
  const key = fk !== undefined ? `f:${fieldCacheKey(field!)}:${fk}:${rock.id}` : `${rock.shape}:${rock.r}:${rock.id}`;
  let s = rockCache.get(key);
  if (s !== undefined) return s;
  // The rock's math-up outline, y flipped into the fracture's Pixi-up frame.
  const fo = fk !== undefined ? fieldRockOutline(field!, fk) : null;
  const verts = fo !== null ? fo.verts : generateAsteroidVertices(rock.shape, rock.r);
  const outline: Array<readonly [number, number]> = [];
  for (const v of verts) outline.push([v.x, -v.y] as const);
  const area = polygonArea(verts);
  const r = fo !== null ? fo.radius : rock.r;
  const ref: WreckRockRef = fk !== undefined ? { id: rock.id, shape: rock.shape, r: rock.r, fk } : { id: rock.id, shape: rock.shape, r: rock.r };
  s = {
    ship: null, rock: ref, structure: null, outline, scale: 1, area,
    bodyMass: Math.max(1e-3, area * ROCK_WRECK_DENSITY), maxHull: area * ROCK_INTEGRITY_PER_AREA, radius: r,
    inset: WRECK_COLLIDER_INSET_PER_RADIUS * r, profile: DESTRUCTION_PROFILES.rock,
    pushMin: WRECK_PUSH_MIN_PER_RADIUS * r, pushMax: WRECK_PUSH_MAX_PER_RADIUS * r,
    separate: WRECK_SEPARATE_PER_RADIUS * r, crack: WRECK_CRACK_PER_RADIUS * r,
  };
  if (rockCache.size >= ROCK_CACHE_MAX) rockCache.clear();
  rockCache.set(key, s);
  return s;
}

const structureCache = new Map<StructureKindId, WreckSource>();

/** A structure kind's source (memoised per kind). Area from its outline;
 *  mass `STRUCTURE_WRECK_DENSITY` × area; "max hull" the kind's catalogue
 *  `maxHealth` (base, unlevelled: the integrity scale of its pieces);
 *  radius the outline's farthest vertex; inset and parting per radius like
 *  a rock's. */
export function structureWreckSource(ref: WreckStructureRef): WreckSource {
  let s = structureCache.get(ref.k);
  if (s !== undefined) return s;
  const kind = getStructureKind(ref.k);
  const verts = structureOutline(kind.id, SOCKET_OUTLINE_STYLE);
  // Game Y-up → the fracture's Pixi-up frame (`structureRenderVerts`' flip).
  const outline: Array<readonly [number, number]> = [];
  let r2 = 0;
  for (const v of verts) {
    outline.push([v.x, -v.y] as const);
    r2 = Math.max(r2, v.x * v.x + v.y * v.y);
  }
  const area = polygonArea(verts);
  const r = Math.sqrt(r2);
  s = {
    ship: null, rock: null, structure: { k: kind.id }, outline, scale: 1, area,
    bodyMass: Math.max(1e-3, area * STRUCTURE_WRECK_DENSITY), maxHull: kind.maxHealth, radius: r,
    inset: WRECK_COLLIDER_INSET_PER_RADIUS * r, profile: DESTRUCTION_PROFILES.structure,
    pushMin: WRECK_PUSH_MIN_PER_RADIUS * r, pushMax: WRECK_PUSH_MAX_PER_RADIUS * r,
    separate: WRECK_SEPARATE_PER_RADIUS * r, crack: WRECK_CRACK_PER_RADIUS * r,
  };
  structureCache.set(ref.k, s);
  return s;
}

/** Whether a destroyed structure breaks into wreck pieces: a built one of
 *  any kind with the `structure` profile (every kind but the gates, whose
 *  colliders are split posts). An unbuilt one (a blueprint or a frame under
 *  construction) just goes. */
export function structureBreaks(kindId: string, built: boolean): boolean {
  return built && destructionProfile({ type: 'structure', kindId }) === 'structure';
}

/** A source from a ship kind or a source (the wreck helpers take either). */
export function asWreckSource(k: ShipKindId | WreckSource): WreckSource {
  return typeof k === 'string' ? shipWreckSource(k) : k;
}

/** The source of a wreck's root fracture inputs: its rock, its structure,
 *  else its kind. */
export function wreckSourceOf(root: { kindId?: ShipKindId; rock?: WreckRockSource; structure?: WreckStructureRef }): WreckSource {
  if (root.rock !== undefined) return rockWreckSource(root.rock, root.rock.field);
  if (root.structure !== undefined) return structureWreckSource(root.structure);
  if (root.kindId === undefined) throw new Error('wreck inputs name no ship kind, rock or structure');
  return shipWreckSource(root.kindId);
}
