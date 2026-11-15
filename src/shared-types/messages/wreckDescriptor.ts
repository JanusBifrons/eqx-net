/** Wreck descriptors on the wire (sub-capital break-up slice 3 / salvage
 *  stream): the descriptor shape, its zod schemas and the alloc-free guards.
 *  Split out of `snapshotMessages.ts`, which re-exports all of it. */
import { z } from 'zod';

/** Wreck ids are u16, never 0; a resync range's `hi` may be one past the end. */
export const WRECK_ID_END = 0x10000;
/** Highest piece index a wreck may have: pieces ride the binary wire's u8
 *  `componentIndex` (swarm wire v4), so a child's `parentPiece` fits one too. */
export const MAX_WRECK_PIECE_INDEX = 0xff;
/** Most descriptors a welcome may carry (every u16 wreck id). */
export const MAX_WELCOME_WRECKS = WRECK_ID_END - 1;

/** Longest wreck `owner` id (a playerId or a faction id). */
export const MAX_WRECK_OWNER_LEN = 128;

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
    parentWreck: z.number().int().min(1).max(WRECK_ID_END - 1).optional(),
    parentPiece: z.number().int().min(0).max(MAX_WRECK_PIECE_INDEX).optional(),
    owner: z.string().min(1).max(MAX_WRECK_OWNER_LEN).optional(),
  })
  .strict()
  // A child names its parent wreck AND piece, or neither (a root); never itself.
  .refine((d) => (d.parentWreck === undefined) === (d.parentPiece === undefined) && d.parentWreck !== d.wreckId);

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
    && (d['owner'] === undefined || (typeof d['owner'] === 'string' && d['owner'].length > 0 && d['owner'].length <= MAX_WRECK_OWNER_LEN))
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
