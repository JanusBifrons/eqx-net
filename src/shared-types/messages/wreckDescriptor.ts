/** Wreck descriptors on the wire (sub-capital break-up slice 3 / salvage
 *  stream): the descriptor shape, its zod schemas and the alloc-free guards.
 *  Split out of `snapshotMessages.ts`, which re-exports all of it. */
import { z } from 'zod';
import { ASTEROID_RESOURCE_IDS, type AsteroidResourceId } from '../asteroidResources.js';

/** Wreck ids are u16, never 0; a resync range's `hi` may be one past the end. */
export const WRECK_ID_END = 0x10000;
/** Highest piece index a wreck may have: pieces ride the binary wire's u8
 *  `componentIndex` (swarm wire v4), so a child's `parentPiece` fits one too. */
export const MAX_WRECK_PIECE_INDEX = 0xff;
/** Most descriptors a welcome may carry (every u16 wreck id). */
export const MAX_WELCOME_WRECKS = WRECK_ID_END - 1;

/** Longest wreck `owner` id (a playerId or a faction id). */
export const MAX_WRECK_OWNER_LEN = 128;

/** Most further cut lines a descriptor carries (`extraCuts`; fracture v12
 *  multi-cut). Equals `FRACTURE_MAX_EXTRA_CUTS` (`wreckMultiCut.test.ts`). */
export const MAX_WRECK_EXTRA_CUTS = 3;

/** Fracture v12 multi-cut: one further beam's cut line, hull 1× Pixi-up
 *  frame: the line through (x, y) along the u16 angle `ang` (decoded by the
 *  shared `cutDirFromAngle`), `w` its strip width (absent = a zero-width
 *  line). Also the fracture input's shape (`WreckFractureInputs.extraCuts`). */
export interface WreckExtraCut {
  x: number;
  y: number;
  ang: number;
  w?: number;
}

/** Rock cut: the longest stable rock id a descriptor's `rock` carries. */
export const MAX_WRECK_ROCK_ID_LEN = 64;
/** The descriptor's `parentKind` of a rock's wreck (`ROCK_WRECK_PARENT_KIND`). */
export const WRECK_ROCK_PARENT_KIND = 'asteroid';

/** Rock cut (mining-and-salvage.md "Mining asteroids"): the rock a root
 *  wreck was cut from. Its outline is `generateAsteroidVertices(shape, r)`
 *  (the one it collided and drew with), the fracture's input on both sides
 *  (#15); `id` its stable id (ore, a later tint); `res` its resource when
 *  not plain rock (absent = plain), so its pieces draw the uncut rock's
 *  art and colour, late joiners included (#16). Also
 *  `WreckFractureInputs.rock`. */
export interface WreckRockRef {
  id: string;
  shape: number;
  r: number;
  res?: AsteroidResourceId;
}

export const WreckRockRefSchema = z
  .object({
    id: z.string().min(1).max(MAX_WRECK_ROCK_ID_LEN),
    shape: z.number().int().min(0).max(0xffff),
    r: z.number().finite().positive(),
    res: z.enum(ASTEROID_RESOURCE_IDS).optional(),
  })
  .strict();

export const WreckExtraCutSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    ang: z.number().int().min(0).max(0xffff),
    w: z.number().finite().min(0).optional(),
  })
  .strict();

/** Sub-capital break-up slice 3 (#3) — one wreck's fracture inputs. Mirrors
 *  `WreckDescriptor`; the bidirectional assignability lock in
 *  `messages.test.ts` fails typecheck if they drift. */
export const WreckDescriptorSchema = z
  .object({
    wreckId: z.number().int().min(1).max(WRECK_ID_END - 1),
    parentKind: z.string().min(1).max(64),
    seed: z.number().int().min(0).max(0xffffffff),
    killX: z.number().finite(),
    killY: z.number().finite(),
    killBlowDamage: z.number().finite(),
    recentDamageRate: z.number().finite(),
    snapChance: z.number().finite(),
    algoVersion: z.number().int(),
    deathTick: z.number().int().optional(),
    cutKind: z.enum(['slice', 'channel']).optional(),
    cutAng: z.number().int().min(0).max(0xffff).optional(),
    cutW: z.number().finite().min(0).optional(),
    extraCuts: z.array(WreckExtraCutSchema).min(1).max(MAX_WRECK_EXTRA_CUTS).optional(),
    parentWreck: z.number().int().min(1).max(WRECK_ID_END - 1).optional(),
    parentPiece: z.number().int().min(0).max(MAX_WRECK_PIECE_INDEX).optional(),
    owner: z.string().min(1).max(MAX_WRECK_OWNER_LEN).optional(),
    rock: WreckRockRefSchema.optional(),
  })
  .strict()
  // A child names its parent wreck AND piece, or neither (a root); never
  // itself. Further cuts ride only with a main cut.
  .refine((d) => (d.parentWreck === undefined) === (d.parentPiece === undefined) && d.parentWreck !== d.wreckId
    && (d.extraCuts === undefined || d.cutKind !== undefined)
    // A rock rides only on a ROOT rock wreck (children resolve to it).
    && (d.rock === undefined || (d.parentWreck === undefined && d.parentKind === WRECK_ROCK_PARENT_KIND)));

/** The snapshot's wreck fields (#3). The snapshot as a whole is the
 *  documented high-cadence carve-out (not zod-parsed on ingest); the client
 *  checks these fields with the alloc-free `isWreckDescriptor` /
 *  `isWreckId`, which `wreckWire.test.ts` locks to these schemas. */
export const WreckAddsSchema = z.array(WreckDescriptorSchema).max(256);
export const WreckRemovesSchema = z.array(z.number().int().min(1).max(WRECK_ID_END - 1)).max(256);
export const WreckSyncSchema = z
  .object({
    lo: z.number().int().min(1).max(WRECK_ID_END),
    hi: z.number().int().min(1).max(WRECK_ID_END),
    d: z.array(WreckDescriptorSchema).max(64),
  })
  .strict();

function finite(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Alloc-free twin of `extraCuts` in `WreckDescriptorSchema` (shape only). */
function isExtraCuts(v: unknown): boolean {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_WRECK_EXTRA_CUTS) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as unknown;
    if (typeof c !== 'object' || c === null) return false;
    const e = c as Record<string, unknown>;
    if (!finite(e['x']) || !finite(e['y'])) return false;
    const a = e['ang'];
    if (typeof a !== 'number' || !Number.isInteger(a) || a < 0 || a > 0xffff) return false;
    if (e['w'] !== undefined && !(finite(e['w']) && (e['w'] as number) >= 0)) return false;
  }
  return true;
}

/** Alloc-free twin of `WreckRockRefSchema`. */
function isRockRef(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const id = r['id'];
  const shape = r['shape'];
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_WRECK_ROCK_ID_LEN
    && typeof shape === 'number' && Number.isInteger(shape) && shape >= 0 && shape <= 0xffff
    && finite(r['r']) && (r['r'] as number) > 0
    && (r['res'] === undefined || (ASTEROID_RESOURCE_IDS as readonly unknown[]).includes(r['res']));
}

/** Alloc-free twin of `WreckRemovesSchema`'s element check. */
export function isWreckId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < WRECK_ID_END;
}

/** Alloc-free twin of `WreckDescriptorSchema` (shape only; unknown keys are
 *  ignored here, as the store only reads the named fields). Used on the
 *  snapshot hot path instead of a zod parse (#14). */
export function isWreckDescriptor(v: unknown): v is WreckDescriptor {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return isWreckId(d['wreckId'])
    && typeof d['parentKind'] === 'string' && d['parentKind'].length > 0 && d['parentKind'].length <= 64
    && typeof d['seed'] === 'number' && Number.isInteger(d['seed']) && d['seed'] >= 0 && d['seed'] <= 0xffffffff
    && finite(d['killX']) && finite(d['killY']) && finite(d['killBlowDamage'])
    && finite(d['recentDamageRate']) && finite(d['snapChance'])
    && typeof d['algoVersion'] === 'number' && Number.isInteger(d['algoVersion'])
    && (d['deathTick'] === undefined || (typeof d['deathTick'] === 'number' && Number.isInteger(d['deathTick'])))
    && (d['cutKind'] === undefined || d['cutKind'] === 'slice' || d['cutKind'] === 'channel')
    && (d['cutAng'] === undefined || (typeof d['cutAng'] === 'number' && Number.isInteger(d['cutAng']) && d['cutAng'] >= 0 && d['cutAng'] <= 0xffff))
    && (d['cutW'] === undefined || (finite(d['cutW']) && (d['cutW'] as number) >= 0))
    && (d['extraCuts'] === undefined || (d['cutKind'] !== undefined && isExtraCuts(d['extraCuts'])))
    && (d['owner'] === undefined || (typeof d['owner'] === 'string' && d['owner'].length > 0 && d['owner'].length <= MAX_WRECK_OWNER_LEN))
    && (d['rock'] === undefined || (isRockRef(d['rock']) && d['parentWreck'] === undefined && d['parentKind'] === WRECK_ROCK_PARENT_KIND))
    && (d['parentWreck'] === undefined
      ? d['parentPiece'] === undefined
      : isWreckId(d['parentWreck']) && d['parentWreck'] !== d['wreckId']
        && typeof d['parentPiece'] === 'number' && Number.isInteger(d['parentPiece'])
        && d['parentPiece'] >= 0 && d['parentPiece'] <= MAX_WRECK_PIECE_INDEX);
}

/** Capital destruction S2b — the fracture inputs of one wreck. */
export interface WreckDescriptor {
  /** u16, the `wreckId` its pieces carry on the binary wire (v5). */
  wreckId: number;
  /** The capital ship kind that broke up. */
  parentKind: string;
  /** u32 fracture seed. */
  seed: number;
  /** The kill point in the hull's 1× Pixi-up frame, on the outline. */
  killX: number;
  killY: number;
  /** Final hit ÷ max hull. */
  killBlowDamage: number;
  /** Damage over the last ~3 s ÷ max hull. */
  recentDamageRate: number;
  /** Clean-snap chance the fracture used. */
  snapChance: number;
  /** `FRACTURE_ALGO_VERSION` the server fractured with; a client on another
   *  version drops the wreck instead of guessing. */
  algoVersion: number;
  /** S3: the server tick the capital broke up on. The client's wreck art
   *  starts its molten cut-edge glow from it; absent ⇒ drawn already cool
   *  (as a late joiner sees it). Not a fracture input. */
  deathTick?: number;
  /** Fracture v9 kill cut, from the killing weapon's `killCut` (absent =
   *  the normal break-up): `slice` cuts dead straight along the shot,
   *  `channel` erases a strip `cutW` wide along it (v10: so does a slice
   *  with a `cutW`, the heavy beam). */
  cutKind?: 'slice' | 'channel';
  /** The cut line's direction, a u16 angle (65536 per turn) in the hull's
   *  1× Pixi-up frame; decoded by the shared trig-free `cutDirFromAngle`. */
  cutAng?: number;
  /** The cut's strip width (a channel, or a wide slice) in the hull's 1×
   *  frame; absent = a zero-width slice. */
  cutW?: number;
  /** Fracture v12 multi-cut (owner 2026-11-15, "one cut per beam"): the
   *  further cut lines of the other cutting beams that burned the hull (a
   *  root) or the piece (a child) in the last moment, besides the main cut
   *  above; at most `MAX_WRECK_EXTRA_CUTS`, only with a `cutKind`. Absent =
   *  the main cut alone. A fracture input like the cut fields. */
  extraCuts?: WreckExtraCut[];
  /** Salvage stream: a CHILD wreck, one piece of `parentWreck` broken again
   *  (capital-destruction.md §S4 "Re-split"). A child descriptor is ONE step
   *  of a `WreckChildChain`: `parentPiece` is the piece that broke,
   *  `killX`/`killY` the breaking hit and `cut*` its kill cut (hull 1×
   *  Pixi-up frame, as for a root). `parentKind` and `algoVersion` repeat
   *  the root's; `seed` is the child's own fracture seed,
   *  `wreckChildSeed(parent.seed, parentPiece)`; `killBlowDamage`,
   *  `recentDamageRate` and `snapChance` are not inputs of a child (the
   *  kind's `resplit` profile sets its fracture). The client resolves the
   *  chain by walking parents to the root, so every ancestor stays on the
   *  wire while a descendant lives. Absent (with `parentPiece`) = a root. */
  parentWreck?: number;
  /** The parent's piece that broke (its `componentIndex`, u8). Present
   *  exactly when `parentWreck` is. */
  parentPiece?: number;
  /** Who owned the hull (the livery it wore, art-direction.md "Ship
   *  livery"): a player's id for a player hull (active or parked), an NPC
   *  patrol's faction; absent = the kind's allegiance. Not a fracture input:
   *  the client's wreck pieces reuse the bake the live hull wore. */
  owner?: string;
  /** Rock cut: a ROOT wreck cut from a rock (`parentKind` is then
   *  `WRECK_ROCK_PARENT_KIND`, not a ship kind): the rock's stable id, shape
   *  seed and radius, whose outline the fracture cuts. A rock's child wrecks
   *  repeat `parentKind` and resolve to this root. Absent = a ship's wreck. */
  rock?: WreckRockRef;
}

/** A rolling-resync chunk of the live wreck set (`SnapshotMessage.wreckSync`). */
export interface WreckSync {
  /** First wreck id the chunk covers. */
  lo: number;
  /** One past the last id it covers (`WRECK_ID_END` = to the end). */
  hi: number;
  /** Every live wreck with `lo <= wreckId < hi`. */
  d: WreckDescriptor[];
}
