/**
 * Destruction profiles (sub-capital break-up, slice 1; plan
 * `subcapital-breakup.md`, docs/architecture/capital-destruction.md
 * "Sub-capital profile").
 *
 * One wreck system, three profiles. Every difference between a capital's
 * break-up (a rare, very large spectacle) and a sub-capital's (quiet, cheap,
 * ~100x as frequent) is a field here, never a branch scattered through the
 * code. Pure data: the fracture reads `fracture` today (`wreckPieceGeometry`);
 * the server path (slice 2) reads the hold, push, damping and collision
 * fields and the client (slice 4) the `fx` block.
 *
 *  - `capital`: authored `sizeClass: 'capital'` (`isCapitalKindId`). The
 *    capital stack's values (#538 to #541: the 1.2 s crack hold, pieces that
 *    collide, the crack front, ripples and the 4.5 s glow). Its fracture
 *    options are exactly the fracture defaults, so capital wrecks stay
 *    byte-identical (golden hashes).
 *  - `subcap`: every other ship kind, fighters included (owner: "Everything").
 *    2-3 chunky pieces, no hold, a gentle push, no extra FX.
 *  - `none`: engineering-only kinds and the cargo pod (they leave scrap or
 *    nothing, as before).
 *
 * Read a ship's profile through `shipTuning(kind).destruction` (#18) or
 * `destructionProfile({ type: 'ship', kindId })` (`destructionProfile.ts`).
 * The entity form leaves room for structures (owner 2026-11-13: "This
 * includes structures as well in the future"); they map to `none` until that
 * work picks a profile per structure kind.
 *
 * Kept free of the ship catalogue (the catalogue imports `tuning.ts`, which
 * imports this file).
 */
import type { ShipKind } from '../shipKinds/types.js';

export type DestructionProfileId = 'capital' | 'subcap' | 'none';
export const DESTRUCTION_PROFILE_IDS: readonly DestructionProfileId[] = ['capital', 'subcap', 'none'];

/** The options `fractureHull` takes from a profile (same field names as its
 *  `FractureInput`; an absent field means the fracture default). */
export interface DestructionFractureOptions {
  /** Cap on pieces (`fractureHull` clamps to 1..64). */
  readonly maxPieces: number;
  /** Chance of a clean snap in two along the primary crack. */
  readonly snapChance: number;
  /** v7 fan cracks from the kill point. */
  readonly fanCracks: boolean;
  /** The rare v7 far crack. */
  readonly farCrack: boolean;
  /** Every piece chunky; a sound primary crack; one extra hull-sized crack
   *  in place of the beam-wide zone cracks. */
  readonly chunkyPieces: boolean;
  /** Least piece width in beams with `chunkyPieces` (default 0.45). */
  readonly chunkyMinWidthBeams?: number;
  /** Chance of the one extra crack at violence 0 with `chunkyPieces`. */
  readonly extraChunkChance?: number;
  /** Jag of the cut edges (default depth 4, roughness 0.22). */
  readonly jag?: { readonly depth: number; readonly roughness: number };
}

/** How the cut edges glow after the break. */
export type WreckGlowStyle = 'full' | 'simple' | 'none';

/** The break-up's effects, read by the client renderer (slice 4). */
export interface DestructionFx {
  /** Break-up dust and shards burst. */
  readonly breakBurst: boolean;
  /** The small kill blasts at the kill point (`wreckBlasts`). */
  readonly killBlasts: boolean;
  /** The crack front travelling from the kill point during the hold. */
  readonly crackFront: boolean;
  /** Small blasts rippling along the cracks. */
  readonly ripples: boolean;
  /** The wreck's own blast replaces the ship's normal death explosion
   *  (`hullDeathBlastReplaced`). False: the normal explosion plays. */
  readonly hullDeathBlastReplaced: boolean;
  /** `full`: front, white-hot head and cooling curve; `simple`: one core
   *  fade; `none`: no glow. */
  readonly glowStyle: WreckGlowStyle;
  /** How long the cut-edge glow lasts (s). */
  readonly glowSeconds: number;
}

export interface DestructionProfile {
  readonly id: DestructionProfileId;
  /** Null: the entity leaves no wreck pieces. */
  readonly fracture: DestructionFractureOptions | null;
  /** Crack hold: the hull stays one body this long before it parts (ms). */
  readonly holdMs: number;
  /** Multiplier on `shipTuning(kind).wreckPushMax/Min`. */
  readonly pushScale: number;
  /** Multiplier on the wreck pieces' linear and angular damping. */
  readonly dampingScale: number;
  /** Pieces of one wreck collide with each other. */
  readonly piecesCollide: boolean;
  readonly fx: DestructionFx;
}

const CAPITAL: DestructionProfile = {
  id: 'capital',
  // Exactly the fracture defaults (FRACTURE_MAX_PIECES, FRACTURE_SNAP_CHANCE,
  // fans and the far crack on, no chunky mode, the default jag): capital
  // output is byte-identical. Lock: `destructionProfile.test.ts`.
  fracture: { maxPieces: 64, snapChance: 0.2, fanCracks: true, farCrack: true, chunkyPieces: false },
  holdMs: 1200,
  pushScale: 1,
  dampingScale: 1,
  piecesCollide: true,
  fx: {
    breakBurst: true,
    killBlasts: true,
    crackFront: true,
    ripples: true,
    hullDeathBlastReplaced: true,
    glowStyle: 'full',
    glowSeconds: 4.5,
  },
};

const SUBCAP: DestructionProfile = {
  id: 'subcap',
  // 2-3 pieces: the primary crack through the hit (moved toward the middle
  // only where it would clip a sliver), and sometimes one more chunk. Chunky
  // at 0.3 beam (a fighter is barely longer than its beam, so v7's 0.45
  // would never allow a third piece) with v7's aspect guard; a short, gentle
  // jag so a piece is at most ~6 convex parts.
  fracture: {
    maxPieces: 3,
    snapChance: 0.2,
    fanCracks: false,
    farCrack: false,
    chunkyPieces: true,
    chunkyMinWidthBeams: 0.3,
    extraChunkChance: 0.4,
    jag: { depth: 2, roughness: 0.12 },
  },
  holdMs: 0,
  // A gentle push, and enough damping that pieces settle (and sleep in the
  // physics engine) within ~10-20 s. Measured (slice 2, integration
  // `subcapWrecks.test.ts`): ×10 (linear 0.6/s, angular 0.5/s) puts a fighter
  // killed at full speed (~600 u/s) and turning to sleep in ~14 game s after
  // ~1,000 u of drift; ×5 took ~27 s. Slice 5 re-tunes from the soak.
  pushScale: 0.5,
  dampingScale: 10,
  piecesCollide: false,
  fx: {
    breakBurst: false,
    killBlasts: false,
    crackFront: false,
    ripples: false,
    hullDeathBlastReplaced: false,
    glowStyle: 'simple',
    glowSeconds: 1,
  },
};

const NONE: DestructionProfile = {
  id: 'none',
  fracture: null,
  holdMs: 0,
  pushScale: 0,
  dampingScale: 1,
  piecesCollide: false,
  fx: {
    breakBurst: false,
    killBlasts: false,
    crackFront: false,
    ripples: false,
    hullDeathBlastReplaced: false,
    glowStyle: 'none',
    glowSeconds: 0,
  },
};

export const DESTRUCTION_PROFILES: Readonly<Record<DestructionProfileId, DestructionProfile>> = {
  capital: CAPITAL,
  subcap: SUBCAP,
  none: NONE,
};

/** The cargo pod leaves its glowing scrap, not wreck pieces. */
const NO_WRECK_SHIP_KINDS: ReadonlySet<string> = new Set(['cargo-pod']);

/** A ship kind's profile: authored capitals are `capital`; engineering-only
 *  kinds and the cargo pod are `none`; every other kind is `subcap`. */
export function destructionProfileIdForKind(kind: Pick<ShipKind, 'id' | 'sizeClass' | 'engineeringOnly'>): DestructionProfileId {
  if (kind.sizeClass === 'capital') return 'capital';
  if (kind.engineeringOnly || NO_WRECK_SHIP_KINDS.has(kind.id)) return 'none';
  return 'subcap';
}
