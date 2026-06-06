/**
 * WeaponMountController — pure, lockstep-safe target-pick + (Phase 4b) mount
 * rotation helpers shared between drone AI and the server-side player turret AI.
 *
 * Multi-mount/turret refactor (Phase 4a, 2026-05-11). Pure module: zero zone
 * awareness, no DI, no side effects. Same inputs → same outputs on every
 * caller, so the server and the client's mirrored controller pick the same
 * target every tick (the core lockstep requirement before Phase 4b layers in
 * rotation that depends on the target choice).
 *
 * **What this module does today (Phase 4a):**
 *
 *   - `pickTarget` — given a ship's position, a candidate list, a hostility
 *     filter, and the previously-picked target id, return the chosen target
 *     for this tick. Sticky hysteresis suppresses oscillation when two
 *     hostiles are near-equidistant.
 *
 * **What it grows in Phase 4b:**
 *
 *   - `rotateMountToward` — clamp a mount's desired bearing into its arc
 *     limits and slew the current mount angle toward it by at most
 *     `rotationSpeed * dtSec` per tick.
 *
 *   - `tickSlot` — the convenience entry point that combines pickTarget +
 *     rotateMountToward across every mount in a slot, returning the new
 *     angles + the slot's chosen target.
 *
 * The hysteresis constant lives here (not in the catalogue) because it's a
 * universal AI policy — every slot wants the same "don't flap on near-ties"
 * behaviour. A future per-ship-kind override could move it onto `ShipKind.ai`
 * if a use case emerges, but for now one number is enough.
 */

/** A potential target the controller can pick. Pure-data shape so the caller
 *  can adapt drones, players, or any other entity type into this view without
 *  the module needing to import their concrete records. */
export interface MountTargetView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Current health of the target. Optional — when present (with `maxHealth`)
   *  AND `PickTargetOptions.healthWeight > 0`, the pick is biased toward
   *  lower-health targets ("finish the wounded one"). Low health == lots of
   *  damage already taken, so this also captures the "weight by damage done"
   *  intent in solo / primary-attacker play. Omit on both sides to keep the
   *  pure nearest-target behaviour. */
  readonly health?: number;
  readonly maxHealth?: number;
}

/** A single mount's static configuration — the subset of `WeaponMount` the
 *  rotation maths cares about. Pulled into a narrow interface so test
 *  fixtures can construct them without going through `ShipKindSchema`. */
export interface MountConfig {
  readonly localX: number;
  readonly localY: number;
  readonly baseAngle: number;
  readonly arcMin: number;
  readonly arcMax: number;
  readonly rotationSpeed: number;
}

/** Distance hysteresis factor for sticky target switching. The previously-
 *  picked target is kept as long as
 *
 *    distance(prev) <= distance(nearestCandidate) * STICKY_FACTOR
 *
 *  ...so a near-tied alternative doesn't yank the turret unless it's
 *  meaningfully closer. 1.1 = "must be 10 % closer before we switch". Small
 *  enough that legitimate closer threats win; large enough that frame-to-frame
 *  micro-jitter doesn't flap targets. */
export const STICKY_HYSTERESIS_FACTOR = 1.1;

export interface PickTargetOptions {
  /** Override the default hysteresis factor for tests / future tuning. */
  stickyHysteresisFactor?: number;
  /** Maximum acquisition distance, in world units. Candidates outside this
   *  radius are treated as "not in view" — they're skipped during the
   *  nearest-hostile scan and also evict the sticky pin (so a target that
   *  drifts past `maxDistance` is dropped on the next tick, not held).
   *  Caller-driven so the same module covers different engagement ranges
   *  (e.g. hitscan vs longer-range projectile). Omit (or pass `Infinity`)
   *  to disable the range gate. */
  maxDistance?: number;
  /** Bias toward LOW-health targets. Each candidate's effective score is
   *  `distance² * (1 + healthWeight * health/maxHealth)`, so a full-health
   *  target is penalised by up to `healthWeight×` its distance² while a
   *  near-dead one keeps the raw distance² — letting a wounded target a bit
   *  farther away win over a pristine closer one. `0` (default) ⇒ pure
   *  nearest-target, byte-identical to the pre-Part-C behaviour. Requires
   *  `health`/`maxHealth` on the candidates; missing values fall back to
   *  distance-only for that candidate. */
  healthWeight?: number;
  /** Commitment margin in SCORE space: the previous target is kept unless a
   *  challenger's score beats it by this factor (`prevScore <= bestScore *
   *  switchMargin` ⇒ keep prev). Larger ⇒ stickier ("don't abandon the target
   *  you're finishing"). When omitted it defaults to `stickyHysteresisFactor²`,
   *  which makes the score-space comparison reduce EXACTLY to the legacy
   *  squared-distance hysteresis (the byte-identical guarantee). */
  switchMargin?: number;
  /** Hard switch-DELAY (in ticks). While `ticksSincePrevTarget < dwellTicks`
   *  the previous target is kept outright (as long as it's still hostile +
   *  in range), even if a better challenger exists. Caller owns the dwell
   *  clock (`ticksSincePrevTarget`). Tick-based ⇒ deterministic; use ONLY where
   *  both sides share a tick reference (server drone AI). Default `0` (no
   *  hard delay) ⇒ legacy behaviour. */
  dwellTicks?: number;
  /** Ticks since the caller last switched its target — paired with
   *  `dwellTicks`. Caller-owned per-instance state (kept off the controller for
   *  lockstep, like `prevTargetId`). Defaults to `Infinity` (no active dwell). */
  ticksSincePrevTarget?: number;
}

/**
 * Choose the slot's target for this tick.
 *
 * Algorithm:
 *
 *   1. Collect every entry in `targets` that passes `isHostile(id)`.
 *   2. Find the nearest hostile to `(shipX, shipY)`.
 *   3. If `prevTargetId` is still hostile AND still present in the targets
 *      list, prefer it UNLESS the nearest other candidate is meaningfully
 *      closer (`distance(nearest) * factor < distance(prev)`). This is the
 *      sticky-hysteresis branch — prevents oscillation between two near-
 *      equidistant hostiles.
 *   4. Otherwise return the nearest hostile (or `null` when no hostiles
 *      are in view).
 *
 * Determinism: when two hostiles are exactly tied by squared distance, the
 * one that appears first in the `targets` iteration order wins. Server and
 * client must therefore iterate `targets` in the same order; the upstream
 * AI controller is responsible for that ordering.
 */
export function pickTarget(
  shipX: number,
  shipY: number,
  targets: ReadonlyArray<MountTargetView>,
  prevTargetId: string | null,
  isHostile: (id: string) => boolean,
  options?: PickTargetOptions,
): MountTargetView | null {
  const factor = options?.stickyHysteresisFactor ?? STICKY_HYSTERESIS_FACTOR;
  const maxDistance = options?.maxDistance ?? Infinity;
  const healthWeight = options?.healthWeight ?? 0;
  // Commitment margin in score space. Default = factor² so that, with
  // healthWeight 0 (score === d²), this reduces EXACTLY to the legacy
  // squared-distance hysteresis (`prevD2 <= nearestD2 * factor²`).
  const switchMargin = options?.switchMargin ?? factor * factor;
  const dwellTicks = options?.dwellTicks ?? 0;
  const ticksSincePrev = options?.ticksSincePrevTarget ?? Infinity;
  // Pre-square the gate so the hot loop stays sqrt-free.
  const maxD2 = maxDistance === Infinity ? Infinity : maxDistance * maxDistance;
  let best: MountTargetView | null = null;
  let bestScore = Infinity;
  let prev: MountTargetView | null = null;
  let prevScore = Infinity;

  for (const t of targets) {
    if (!isHostile(t.id)) continue;
    const dx = t.x - shipX;
    const dy = t.y - shipY;
    const d2 = dx * dx + dy * dy;
    // Out-of-range candidates don't count — neither as the best, nor as the
    // sticky pin's renewal. A target that drifts past `maxDistance` is dropped
    // from `prev` as well, so the next call returns the best in-range candidate
    // (or null, slewing mounts back to forward).
    if (d2 > maxD2) continue;
    // Score = distance² biased toward low health (lower score = preferred).
    // healthWeight 0 (or missing health) ⇒ score === d² ⇒ pure nearest.
    let score = d2;
    if (healthWeight > 0 && t.health !== undefined && t.maxHealth !== undefined && t.maxHealth > 0) {
      let frac = t.health / t.maxHealth;
      if (frac < 0) frac = 0;
      else if (frac > 1) frac = 1;
      score = d2 * (1 + healthWeight * frac);
    }
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
    if (prevTargetId !== null && t.id === prevTargetId) {
      prev = t;
      prevScore = score;
    }
  }

  // No hostiles in view: drop the slot's target. The caller's next-tick
  // call sees `prevTargetId = null` and starts fresh.
  if (!best) return null;

  // No previous target (first frame, or it died / left): take the best.
  if (!prev) return best;

  // Hard switch-delay: hold the previous target until the dwell elapses,
  // even if a better challenger exists (AI only; default dwellTicks 0 = off).
  if (ticksSincePrev < dwellTicks) return prev;

  // Commitment branch: keep `prev` unless the best candidate beats it by the
  // margin. `prev` wins when `prevScore <= bestScore * switchMargin`. With the
  // default margin (factor²) + score==d² this is the legacy hysteresis exactly.
  if (prevScore <= bestScore * switchMargin) return prev;
  return best;
}

/** Wrap an angle into the [-π, π] range. Centralised so every rotation
 *  callsite uses the same wrap, avoiding the `0 vs 2π` ambiguity. */
export function wrapPi(rad: number): number {
  let r = rad;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/**
 * Slew a mount's current angle (ship-relative, RELATIVE to `mount.baseAngle`)
 * toward `desiredBearing` (also ship-relative, also relative to baseAngle),
 * clamped by:
 *
 *   - `[mount.arcMin, mount.arcMax]` — the mount's mechanical rotation arc.
 *     A mount with `arcMin === arcMax === 0` is fixed and the result is 0.
 *   - `mount.rotationSpeed * dtSec` — the per-tick angular travel limit.
 *
 * Returns the new mount angle for this tick. Pure, deterministic — same
 * inputs on server and client produce the same output, so the lockstep
 * "both sides agree on mount angle" property is structurally guaranteed
 * once both sides receive the same `desiredBearing` (which is itself
 * derived from the same target via `pickTarget`).
 *
 * `desiredBearing` is the angle FROM ship-forward TO the target bearing,
 * with the mount's `baseAngle` already subtracted out. The caller computes
 * it as `wrapPi(targetBearingRelativeToShip - mount.baseAngle)`. We accept
 * it pre-subtracted so this function doesn't need to know about baseAngle
 * conventions, only about the arc-and-speed limits.
 */
export function rotateMountToward(
  currentMountAngle: number,
  desiredBearing: number,
  mount: MountConfig,
  dtSec: number,
): number {
  // Degenerate mount — fixed in place. Skip the slew entirely.
  if (mount.rotationSpeed <= 0 || mount.arcMax <= mount.arcMin) {
    return clampToArc(0, mount);
  }
  // Clamp the request into the arc; the mount can't rotate past its
  // mechanical limit even if the target is further round.
  const clampedTarget = clampToArc(wrapPi(desiredBearing), mount);
  // Limit per-tick travel by the rotation speed.
  const maxStep = mount.rotationSpeed * dtSec;
  const delta = wrapPi(clampedTarget - currentMountAngle);
  if (Math.abs(delta) <= maxStep) return clampedTarget;
  // Sign of `delta` is the rotation direction (positive = counter-clockwise
  // in the ship-relative frame). Inch toward target by `maxStep`.
  return clampToArc(currentMountAngle + Math.sign(delta) * maxStep, mount);
}

/** Clamp a ship-relative mount angle into `[arcMin, arcMax]`. Internal —
 *  exported only so test fixtures can poke at the boundary explicitly. */
export function clampToArc(angle: number, mount: MountConfig): number {
  if (angle < mount.arcMin) return mount.arcMin;
  if (angle > mount.arcMax) return mount.arcMax;
  return angle;
}
