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
  /** The longest the client holds the dying hull on screen while it waits
   *  for its wreck pieces to be drawable (game ms; `dyingHullHold.ts`). The
   *  hold ends the frame every piece is drawn, so this is only the deadline
   *  for a lost or late wreck. 0: no hold. */
  readonly dyingHoldMs: number;
  /** The dead pieces' art tint once the glow has ended (set once, never
   *  written again): a dark, warm burnt multiply so debris reads as DEAD,
   *  clearly dimmer than any live ship while still showing the ship's art.
   *  Null: the pieces keep their per-piece `burntTint` (the capital look).
   *  Hostile review 2026-11-13: sub-cap debris at full colour made the front
   *  line "a solid purple wall" of live-looking wreckage. */
  readonly deadTint: number | null;
  /** The ship's normal death explosion, scaled (radius / smoke linger), while
   *  the room breaks this profile into wrecks (welcome `subcapWrecks` for a
   *  sub-capital). 1: unchanged. Owner 2026-11-13: "Shrink it", so the
   *  break-up and the fight stay readable and capitals feel bigger. */
  readonly deathBlastScale: number;
  readonly deathBlastLinger: number;
}

export interface DestructionProfile {
  readonly id: DestructionProfileId;
  /** Null: the entity leaves no wreck pieces. */
  readonly fracture: DestructionFractureOptions | null;
  /** Crack hold: the hull stays one body this long before it parts (ms). */
  readonly holdMs: number;
  /** Multiplier on `shipTuning(kind).wreckPushMax/Min`. */
  readonly pushScale: number;
  /** Multiplier on `shipTuning(kind).wreckSeparate`, the least speed at
   *  which every shared cut opens (`buildWreckPieces`' seam pass). The push
   *  runs away from the kill point, so it moves the pieces off TOGETHER; this
   *  is what opens the cracks. */
  readonly separateScale: number;
  /** Multiplier on the wreck pieces' linear and angular damping. */
  readonly dampingScale: number;
  /** Multipliers on the overkill knock-back (`shipTuning(kind)
   *  .wreckKnockSpeed` / `.wreckKnockMax`, applied there so every reader
   *  gets the profile's value). */
  readonly knockScale: number;
  readonly knockMaxScale: number;
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
  separateScale: 1,
  dampingScale: 1,
  knockScale: 1,
  knockMaxScale: 1,
  piecesCollide: true,
  fx: {
    breakBurst: true,
    killBlasts: true,
    crackFront: true,
    ripples: true,
    hullDeathBlastReplaced: true,
    glowStyle: 'full',
    glowSeconds: 4.5,
    dyingHoldMs: 1500,
    deadTint: null,
    deathBlastScale: 1,
    deathBlastLinger: 1,
  },
};

const SUBCAP: DestructionProfile = {
  id: 'subcap',
  // 2-3 pieces: the primary crack through the hit (moved toward the middle
  // only where it would clip a sliver), and sometimes one more chunk. Chunky
  // at 0.36 beam (a fighter is barely longer than its beam, so v7's 0.45
  // would never allow a third piece; 0.3 left thin strips, hostile review
  // 2026-11-13) with v7's aspect guard. One shallow kink per cut, not a
  // saw-tooth (depth 2 gave the drone pieces shard outlines): clean chunks.
  fracture: {
    maxPieces: 3,
    snapChance: 0.2,
    fanCracks: false,
    farCrack: false,
    chunkyPieces: true,
    chunkyMinWidthBeams: 0.36,
    extraChunkChance: 0.4,
    jag: { depth: 1, roughness: 0.06 },
  },
  holdMs: 0,
  // The parting push is per unit of hull radius (`wreckPushMax/Min`: 1 % /
  // 0.4 % of the radius per second), which reads at capital scale but left a
  // fighter's pieces as one hull with a crack (~0.1 u/s; hostile review
  // 2026-11-13). ×50 opens a gap of ~1/3 of the radius in the first second
  // (fighter: ~5-12 u/s each way). Damping ×10 (slice 2's measured value:
  // linear 0.6/s, sleep in ~14 game s) brings them to rest; a piece drifts
  // ~1 radius in all. Lock: `destructionProfile.test.ts`. Slice 5 re-tunes.
  pushScale: 50,
  // ...but that push runs away from the kill point, so on a hit at one end
  // every piece goes the SAME way and the cracks stayed shut (round-2 review:
  // robot pieces still touching ~1 s after the break; the seam pass only
  // opened each cut at 1.4 % of the radius a second). ×32: every shared cut
  // opens at >= ~0.45 radius/s, a gap of ~1/3 of the radius 1 s after the
  // break under the damping below. Lock: `wreckPieces.subcapParting.test.ts`
  // + `subcapWrecks.test.ts` (the real server at 1 s).
  separateScale: 32,
  dampingScale: 10,
  // Shots on debris shove it a little (owner, slice 2 report): a small-arms
  // hit moves half a fighter wreck ~10-25 u/s, a naval shell at most ~18
  // u/s (fighter), then the damping slows it. The capital rule ("a blow
  // worth the whole hull moves it at wreckKnockSpeed") is < 1 u/s at
  // fighter size.
  knockScale: 320,
  knockMaxScale: 30,
  piecesCollide: false,
  fx: {
    breakBurst: false,
    killBlasts: false,
    crackFront: false,
    ripples: false,
    hullDeathBlastReplaced: false,
    glowStyle: 'simple',
    glowSeconds: 1,
    // Brief: no crack hold, so a sub-cap's pieces are drawable at once.
    dyingHoldMs: 600,
    // ~35 % brightness and warm (cuts the art's blue and purple most): burnt.
    deadTint: 0x5e5249,
    deathBlastScale: 0.5,
    deathBlastLinger: 0.5,
  },
};

const NONE: DestructionProfile = {
  id: 'none',
  fracture: null,
  holdMs: 0,
  pushScale: 0,
  separateScale: 1,
  dampingScale: 1,
  knockScale: 1,
  knockMaxScale: 1,
  piecesCollide: false,
  fx: {
    breakBurst: false,
    killBlasts: false,
    crackFront: false,
    ripples: false,
    hullDeathBlastReplaced: false,
    glowStyle: 'none',
    glowSeconds: 0,
    dyingHoldMs: 0,
    deadTint: null,
    deathBlastScale: 1,
    deathBlastLinger: 1,
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
