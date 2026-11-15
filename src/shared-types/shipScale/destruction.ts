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
  /** Least share of the hull on each side of the sound primary crack with
   *  `chunkyPieces` (default 0.15). */
  readonly soundMinShare?: number;
  /** Chance of the one extra crack at violence 0 with `chunkyPieces`. */
  readonly extraChunkChance?: number;
  /** Jag of the cut edges (default depth 4, roughness 0.22). */
  readonly jag?: { readonly depth: number; readonly roughness: number };
  /** A cut weapon's kill (heavy-beam slice, railgun channel) burns away
   *  every piece under this share of the hull's area; none left = the ship
   *  is vaporised (fracture v11). Absent: the fracture's 5 % channel sliver
   *  erase only. capital-destruction.md "Kill cuts", "Burn-away". */
  readonly cutBurnMinShare?: number;
}

/** How a wreck piece breaks again (salvage stream; capital-destruction.md
 *  §S4 "Re-split"). The server keeps a hidden integrity pool per piece:
 *  `I_max = clamp01(pieceMass / shipBodyMass) × maxHull × integrityMul`,
 *  at least `integrityMinFrac × maxHull`. At 0 a piece of at least
 *  `minAreaFrac` of the hull's area re-fractures (`wreckChildGeometry`);
 *  a smaller one becomes a salvage pod. */
export interface DestructionResplit {
  /** Least piece area, as a fraction of the whole hull's, that still splits;
   *  below it the worn-out piece turns into salvage. */
  readonly minAreaFrac: number;
  /** Integrity of a piece per unit of its mass share × the kind's max hull. */
  readonly integrityMul: number;
  /** Floor on a piece's integrity, as a fraction of the kind's max hull. */
  readonly integrityMinFrac: number;
  /** Salvage units a whole hull's mass is worth (a pod carries its piece's
   *  mass share of this). */
  readonly salvagePerHull: number;
  /** The child fracture's options (`maxPieces`: 2-3 children per split). */
  readonly fracture: DestructionFractureOptions;
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
  /** The glow of a weapon's cut kill (the wreck's descriptor has a
   *  `cutKind`): `full` gives its kill cut the weapon's colour held ~1.5 s,
   *  an ember, dark at 4.5 s (`wreckGlowAt`'s cut curves, width from the
   *  hull, #18), its other cracks subdued splinters. Beam take 7 review
   *  (2026-11-15): on the 1 s simple glow a sub-cap's violet cut was gone
   *  ~0.1 s after the beam stopped. */
  readonly cutGlowStyle: WreckGlowStyle;
  /** The longest the client holds the dying hull on screen while it waits
   *  for its wreck pieces to be drawable (game ms; `dyingHullHold.ts`). The
   *  hold ends the frame every piece is drawn, so this is only the deadline
   *  for a lost or late wreck. 0: no hold. */
  readonly dyingHoldMs: number;
  /** A dead tint multiplied onto the pieces' art (and the held hull) from
   *  their first frame. Null: no dead tint. Null for every profile since the
   *  owner's call (2026-11-13, after the v4 debris film): "The darkened scrap
   *  just doesn't look right, what's the logic? Why would it darken when
   *  destroyed? It should just be broken, same brightness?" */
  readonly deadTint: number | null;
  /** The pieces' art wears the per-piece `burntTint` (slightly darker,
   *  darkest at the kill point: the capital look). False: the art keeps the
   *  ship's normal brightness and colour (sub-capitals), and a hit flash goes
   *  on the art only, never the glow. */
  readonly burntArt: boolean;
  /** The pieces draw the parent's DEAD bake (no glowing robot core, canopy,
   *  engines or running lights) instead of the live one. Take 10 review
   *  (2026-11-14): a robot-square's biggest piece kept the robot's glowing
   *  eye and "reads as a live robot". Not darkening: same paint and light. */
  readonly deadArt: boolean;
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
  /** Null: the entity's wreck pieces never break again. */
  readonly resplit: DestructionResplit | null;
  /** Crack hold: the hull stays one body this long before it parts (ms). */
  readonly holdMs: number;
  /** Multiplier on `shipTuning(kind).wreckPushMax/Min`: the blast impulse
   *  away from the break point (`wreckBreakKicks`; a piece's kick is the
   *  push ÷ √its mass share). */
  readonly pushScale: number;
  /** Multiplier on `shipTuning(kind).wreckSeparate`, the guard: the least
   *  speed at which every shared cut opens (`wreckBreakKicks`' seam pass,
   *  mass-weighted impulses), so no cut closes, hinges or overlaps. */
  readonly separateScale: number;
  /** Multiplier on `shipTuning(kind).wreckCrack`, the impulse each shared
   *  cut throws its faces apart with (`wreckBreakKicks`). The push runs
   *  away from the break point, so it moves the pieces off TOGETHER; this is
   *  what opens the cracks, heavy pieces slowly and slivers faster. */
  readonly crackScale: number;
  /** Multiplier on the pieces' spin at the break: the dying hull's turn
   *  (ω, and the ω × r it gives each piece) and the seeded kick spin
   *  (`buildWreckPieces`). 1: the hull's full spin carries on. */
  readonly spinScale: number;
  /** Multiplier on the wreck pieces' linear and angular damping. */
  readonly dampingScale: number;
  /** Multipliers on the overkill knock-back (`shipTuning(kind)
   *  .wreckKnockSpeed` / `.wreckKnockMax`, applied there so every reader
   *  gets the profile's value). */
  readonly knockScale: number;
  readonly knockMaxScale: number;
  /** A hit on a RESTING (asleep) piece wakes and shoves it only when its
   *  uncapped knock (J ÷ piece mass) is at least this × `wreckKnockMax`;
   *  a lighter hit still stops the shot but leaves the piece asleep. 0 =
   *  every hit shoves (capitals). Wreck sleep fix, 2026-11-13. */
  readonly knockWakeScale: number;
  /** Settle-to-sleep (wreck sleep fix, 2026-11-13): a piece slower than this
   *  × its kind's radius (u/s) and spinning slower than `settleSpin` (rad/s)
   *  for `WRECK_SETTLE_STEPS` steps is put to sleep (`World.setSleepSettle`),
   *  instead of drifting on down to Rapier's own 0.4 u/s. 0 = off. */
  readonly settlePerRadius: number;
  readonly settleSpin: number;
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
  // A capital piece breaks into 2-3 chunks through the sub-capital's chunky
  // path (sound primary crack, one optional extra crack), with the capital's
  // full jag so new cracks look like the old ones. Values and the depth-2
  // sliver spike: capital-destruction.md §S4 "Re-split".
  resplit: {
    minAreaFrac: 0.02,
    // Owner on the re-split clip (2026-11-15): "splitting stuff almost
    // instantly ... no time for me to understand". A lance battlecruiser's
    // main battery (sustained ~2,800 heavy-beam damage/s, so ~280/s of wear)
    // cracks a battleship's biggest piece (~40 % of the hull) in ~10 s, and
    // no piece in under ~3.6 s (the floor). Lock: `wreckMainBatteryWear.test.ts`.
    integrityMul: 0.62,
    integrityMinFrac: 0.09,
    salvagePerHull: 200,
    fracture: {
      maxPieces: 3, snapChance: 0.2, fanCracks: false, farCrack: false, chunkyPieces: true,
      chunkyMinWidthBeams: 0.36, soundMinShare: 0.3, extraChunkChance: 0.4,
    },
  },
  holdMs: 1200,
  // Owner on the re-split clip (2026-11-15): "the scrap/wreck should weigh
  // A LOT and be more resistant to moving ... a subtle much slower movement
  // ... an accurate mass value vs the forces applied". The break-up kicks
  // are impulses against each piece's mass (`wreckBreakKicks`): a heavy
  // cruiser's big pieces (>= 30 % of the hull) part at ~3 u/s (median; was
  // ~28), slivers (<= 7 %) at ~13 u/s (was ~50). The guard only keeps the
  // cuts from closing (~1.5 u/s for a heavy cruiser; was 31 u/s, which set
  // every cut's speed). Locks: `wreckPiecesSeparate.test.ts`,
  // `wreckPieces.test.ts` "mass-scaled parting".
  pushScale: 0.08,
  separateScale: 0.05,
  crackScale: 1,
  spinScale: 1,
  dampingScale: 1,
  // Owner on the re-split clip (2026-11-15): "scrap should weigh a lot and
  // be very resistant to sliding at this sort of size and scale". A blow
  // worth the whole hull moves it at 0.3 % of the base `wreckKnockSpeed`,
  // each hit at most 10 % of the base `wreckKnockMax`: 10 s of a lance main
  // battery leaves a battleship's biggest piece creeping at well under
  // 5 u/s. Lock: `wreckMainBatteryWear.test.ts`.
  knockScale: 0.003,
  knockMaxScale: 0.1,
  // Heavy chunks are knocked by every hit (owner, 2026-11-13), barely.
  knockWakeScale: 0,
  settlePerRadius: 0,
  settleSpin: 0,
  piecesCollide: true,
  fx: {
    breakBurst: true,
    killBlasts: true,
    crackFront: true,
    ripples: true,
    hullDeathBlastReplaced: true,
    glowStyle: 'full',
    glowSeconds: 4.5,
    cutGlowStyle: 'full',
    dyingHoldMs: 1500,
    deadTint: null,
    burntArt: true,
    deadArt: false,
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
    // Take 9 review (2026-11-14): at the default 15 % the big piece was up
    // to ~85 % of the hull, "the hull stays whole"; at 1/3 a robot-square's
    // ~68 % piece with its middle still read as a live robot (take 10).
    // 0.43 on the small side keeps the largest piece at <= 60 % after the
    // jag (57-58 % measured). Lock:
    // `wreckPieces.subcapParting.test.ts` "read as broken".
    soundMinShare: 0.43,
    extraChunkChance: 0.4,
    jag: { depth: 1, roughness: 0.06 },
    // Owner 2026-11-15: a cut kill burns away "any piece too small". A
    // fifth of the hull: under the re-split's salvage floor (a quarter), so
    // what survives a cut is a real chunk. Heavy beam (60 u strip): a
    // fighter or gunship (20 u wide at 1x, ×2) has nothing left; a missile
    // frigate cut across keeps ~7 % + ~15 % banks, both burn: vaporised.
    // Railgun (16 u): a gunship channel off the keel leaves ~12 % (burns)
    // and ~44 %; across a missile frigate ~32 % + ~46 % (both drift on).
    // capital-destruction.md "Burn-away". The capital keeps the 5 % erase.
    cutBurnMinShare: 0.2,
  },
  // A fighter's half breaks once more into 2 chunks, a quarter becomes
  // salvage (capital-destruction.md §S4 "Re-split").
  resplit: {
    minAreaFrac: 0.25,
    integrityMul: 1,
    integrityMinFrac: 0.05,
    salvagePerHull: 10,
    fracture: {
      maxPieces: 2, snapChance: 0.2, fanCracks: false, farCrack: false, chunkyPieces: true,
      chunkyMinWidthBeams: 0.36, soundMinShare: 0.3, extraChunkChance: 0, jag: { depth: 1, roughness: 0.06 },
    },
  },
  holdMs: 0,
  // The parting push is per unit of hull radius (`wreckPushMax/Min`: 1 % /
  // 0.4 % of the radius per second), which reads at capital scale but left a
  // fighter's pieces as one hull with a crack (~0.1 u/s; hostile review
  // 2026-11-13). ×30 (×20 ÷ √share since the impulse kicks) throws the
  // wreck off the kill point; damping ×10 (slice 2's measured value: linear 0.6/s, sleep in ~14 game s) brings it to
  // rest; no piece drifts over ~1.5 radii. Lock: `destructionProfile.test.ts`.
  pushScale: 20,
  // That push runs away from the kill point, so on a hit at one end every
  // piece goes the SAME way: ×50 alone left the cracks shut (round-2 review:
  // robot pieces still touching ~1 s after the break; the seam pass opened
  // each cut at only 1.4 % of the radius a second). ×40: every shared cut
  // opens at >= ~0.56 radius/s, a gap of ~1/3 of the radius or more 1 s
  // after the break. Take 9 review (2026-11-14): that still read as a whole
  // hull with a crack, and two pieces carrying the dead ship's few hundred
  // u/s "drift side by side like two live ships" (~1 radius apart in all
  // under damping 0.6/s). ×160 (2.2 radii/s) still read small on the take
  // 10 film. ×240: every cut opens and every pair of centres parts at
  // >= ~3.3 radii/s (fighter ~86 u/s), ~2.5+ radii apart 1 s after the
  // break and ~6 at rest. Locks: `wreckPieces.subcapParting.test.ts`
  // (the kicks) + `subcapWrecks.test.ts` (the real server at 1 s).
  // Wreck mass (2026-11-15): the kicks became impulses against each piece's
  // mass. A sub-cap breaks into 2-3 near-equal chunks, so mass barely
  // changes their parting; the reviewed floor stays (×240), no extra crack
  // impulse on top, and the push is ×20 ÷ √share (≈ the old ×30 on a half).
  separateScale: 240,
  crackScale: 0,
  // Owner on the v5 film (2026-11-13): "they spin too much when destroyed".
  // The pieces carried the dying hull's whole turn (a fighter hard over at
  // 2 rad/s threw them at ~115 °/s); ×0.3 keeps a lazy tumble (≤ ~35 °/s
  // from a 2 rad/s turn). Lock: `wreckPieces.subcapParting.test.ts`.
  spinScale: 0.3,
  dampingScale: 10,
  // Shots on debris shove it a little (owner, slice 2 report): a small-arms
  // hit moves half a fighter wreck ~10-25 u/s, a naval shell at most ~18
  // u/s (fighter), then the damping slows it. The capital rule ("a blow
  // worth the whole hull moves it at wreckKnockSpeed") is < 1 u/s at
  // fighter size.
  knockScale: 320,
  knockMaxScale: 30,
  // Wreck sleep fix (2026-11-13; soak census in capital-destruction.md "Soak
  // results"): in a live fight ~40 % of wake-ups were small-arms knocks and
  // ~45 % slow ships brushing a resting piece, and each wake cost ~9 s of
  // drift down to Rapier's 0.4 u/s. A laser (12 dmg) on half a fighter is
  // ~15 u/s uncapped, a 5" shell ~75 u/s, so at 2× the 18 u/s cap small arms
  // leave a resting piece asleep and real hits still shove it. A piece under
  // 1/8 of a radius a second (fighter 3 u/s) and 0.3 rad/s for half a second
  // goes to sleep. Locks: `World.sleepSettle.test.ts`, `subcapWreckSleep.test.ts`.
  knockWakeScale: 2,
  settlePerRadius: 0.125,
  settleSpin: 0.3,
  piecesCollide: false,
  fx: {
    breakBurst: false,
    killBlasts: false,
    crackFront: false,
    ripples: false,
    hullDeathBlastReplaced: false,
    glowStyle: 'simple',
    glowSeconds: 1,
    // A cut kill glows like a capital's (violet ~1.5 s, ember, dark 4.5 s).
    cutGlowStyle: 'full',
    // Brief: no crack hold, so a sub-cap's pieces are drawable at once. The
    // held hull sits under its death explosion; 600 ms of it read as "dead
    // ship sits there, then pops" (round-2 review), so the pieces take over
    // within 250 ms or the hull goes.
    dyingHoldMs: 250,
    // No darkening (owner 2026-11-13: "It should just be broken, same
    // brightness"): pieces and held hull keep the ship's normal art.
    deadTint: null,
    burntArt: false,
    deadArt: true,
    deathBlastScale: 0.5,
    deathBlastLinger: 0.5,
  },
};

const NONE: DestructionProfile = {
  id: 'none',
  fracture: null,
  resplit: null,
  holdMs: 0,
  pushScale: 0,
  separateScale: 1,
  crackScale: 0,
  spinScale: 1,
  dampingScale: 1,
  knockScale: 1,
  knockMaxScale: 1,
  knockWakeScale: 0,
  settlePerRadius: 0,
  settleSpin: 0,
  piecesCollide: false,
  fx: {
    breakBurst: false,
    killBlasts: false,
    crackFront: false,
    ripples: false,
    hullDeathBlastReplaced: false,
    glowStyle: 'none',
    glowSeconds: 0,
    cutGlowStyle: 'none',
    dyingHoldMs: 0,
    deadTint: null,
    burntArt: false,
    deadArt: false,
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
