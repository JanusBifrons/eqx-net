/**
 * Graceful bulk-gap recovery (2026-05-17, diag `xxiyix`).
 *
 * Root finding (evidence, server + client-CPU exonerated): the server
 * broadcasts snapshots metronomically every 50 ms, but mobile networks
 * deliver them BUNCHED — observed client-side receipt gaps of 116 / 149 /
 * 571 ms. When the bunched snapshot finally lands, the recovery discharges
 * in a SINGLE frame as a player position correction AND a synchronized
 * re-anchor of the entire in-interest drone set. Severity scales with
 * in-sector entity count (the 25-bot Living-World pack co-locates on the
 * player), so one network hiccup = one giant synchronized teleport. At the
 * 500-objects/sector target this is catastrophic by construction.
 *
 * We cannot fix mobile delivery jitter (environmental). We CAN stop the
 * architecture from amplifying one hiccup into an instantaneous N-entity
 * snap: spread the discharge over a few frames so it reads as a brief
 * smooth catch-up. Two pure decisions live here:
 *
 *  1. `playerCorrectionHalfLifeMs(drift)` — the reconciler's correction
 *     spring half-life. Was binary (12 ms sub-pixel / 25 ms everything),
 *     so a 249 u gap-correction settled in ~5 frames (a teleport). Now
 *     magnitude-scaled: tiny corrections stay snappy (steady-state feel +
 *     the feel-test-lockstep canary UNCHANGED — small drifts keep 12/25 ms),
 *     large gap-induced corrections glide.
 *
 *  2. `anchoredDroneReseedSmoothing(...)` — Phase C deliberately skips the
 *     `_droneRenderOffsets` spring for snapshot-anchored drones ("snapshot
 *     owns predWorld, no jolt to smooth"). That assumption holds ONLY when
 *     snapshots arrive on cadence. After a delivery gap the re-seed IS a
 *     large jolt. This decides — purely from the snapshot interval vs the
 *     steady-state cadence + the re-seed distance — whether to engage the
 *     spring for an anchored drone. Steady-state (no gap) ⇒ `engage:false`
 *     ⇒ behaviour byte-identical to pre-fix (chapter-2 lockstep intact).
 *
 * Pure / deterministic / no DOM / no I/O — unit-tested in
 * `correctionSmoothing.test.ts`.
 */

/** Below this the correction is float-noise; settle almost instantly. */
const SUBPIXEL_DRIFT = 0.5;
/** Up to here a correction is "normal steady-state combat jitter" — keep
 *  the pre-fix snappy 25 ms so the lockstep FEEL and the feel-test-lockstep
 *  canary are unchanged. Above it we're recovering an accumulated gap. */
const SNAPPY_DRIFT_MAX = 20;
const SNAPPY_HALF_LIFE_MS = 25;
const SUBPIXEL_HALF_LIFE_MS = 12;
/** Drift at/above which the gap-recovery glide is at its gentlest. */
const GLIDE_DRIFT_MAX = 220;
/** Gentlest half-life — ~3–4 half-lives ≈ 0.7–1 s total settle: the eye
 *  reads it as a fast catch-up, not a teleport. */
const GLIDE_HALF_LIFE_MAX_MS = 220;

/**
 * Correction-spring half-life for a player reconciliation of magnitude
 * `drift` (world units). Monotonic non-decreasing: sub-pixel → 12 ms,
 * normal steady-state corrections → 25 ms (UNCHANGED from pre-fix), then
 * linearly gentler up to {@link GLIDE_HALF_LIFE_MAX_MS} for large
 * gap-recovery corrections. The corrected END pose is identical; only the
 * visual approach is spread.
 */
export function playerCorrectionHalfLifeMs(drift: number): number {
  if (drift < SUBPIXEL_DRIFT) return SUBPIXEL_HALF_LIFE_MS;
  if (drift <= SNAPPY_DRIFT_MAX) return SNAPPY_HALF_LIFE_MS;
  if (drift >= GLIDE_DRIFT_MAX) return GLIDE_HALF_LIFE_MAX_MS;
  // Linear ramp SNAPPY_HALF_LIFE_MS → GLIDE_HALF_LIFE_MAX_MS across
  // (SNAPPY_DRIFT_MAX, GLIDE_DRIFT_MAX].
  const t = (drift - SNAPPY_DRIFT_MAX) / (GLIDE_DRIFT_MAX - SNAPPY_DRIFT_MAX);
  return SNAPPY_HALF_LIFE_MS + t * (GLIDE_HALF_LIFE_MAX_MS - SNAPPY_HALF_LIFE_MS);
}

/** A snapshot whose inter-arrival exceeds `nominalMs × this` is a delivery
 *  gap (bunched mobile delivery), not steady cadence. 1.8× of the ~50 ms
 *  nominal ⇒ > ~90 ms ⇒ at least one missed broadcast. */
export const GAP_INTERVAL_FACTOR = 1.8;
/** Below this re-seed distance there's no visible jolt to smooth even on a
 *  gap — leave it instant (cheaper, and matches steady-state). */
const DRONE_RESEED_SMOOTH_MIN_DIST = 1;
/** Anchored-drone gap glide half-life. Matches the existing
 *  `droneRenderOffsetHalfLifeForDrift` non-trivial-drift value so drone and
 *  player recovery feel consistent. */
const DRONE_GAP_HALF_LIFE_MS = 150;

export interface AnchoredDroneReseedInput {
  /** This snapshot's inter-arrival (ms) — `stats.snapshotIntervalMs`. */
  readonly intervalMs: number;
  /** Steady-state cadence (ms) — the ~50 ms nominal or its EWMA. */
  readonly nominalMs: number;
  /** Re-seed jolt distance (u): |predicted pose − snapshot-anchored pose|. */
  readonly dist: number;
}
export interface AnchoredDroneReseedDecision {
  /** Engage the `_droneRenderOffsets` spring for this anchored drone? */
  readonly engage: boolean;
  /** Spring half-life (ms) when `engage`. */
  readonly halfLifeMs: number;
}

/**
 * Decide whether to glide an anchored drone's gap-recovery re-seed instead
 * of snapping it. `engage` ONLY when the snapshot arrived after a delivery
 * gap (`intervalMs > nominalMs × GAP_INTERVAL_FACTOR`) AND the jolt is
 * visible. Steady cadence ⇒ `{ engage: false }` ⇒ the caller does exactly
 * what it did pre-fix (no spring for anchored drones — Phase C invariant
 * + feel-test-lockstep canary preserved). Pure.
 */
export function anchoredDroneReseedSmoothing(
  i: AnchoredDroneReseedInput,
): AnchoredDroneReseedDecision {
  const isGap = i.nominalMs > 0 && i.intervalMs > i.nominalMs * GAP_INTERVAL_FACTOR;
  if (!isGap || i.dist < DRONE_RESEED_SMOOTH_MIN_DIST) {
    return { engage: false, halfLifeMs: 0 };
  }
  return { engage: true, halfLifeMs: DRONE_GAP_HALF_LIFE_MS };
}
