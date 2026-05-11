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
  let nearest: MountTargetView | null = null;
  let nearestD2 = Infinity;
  let prev: MountTargetView | null = null;
  let prevD2 = Infinity;

  for (const t of targets) {
    if (!isHostile(t.id)) continue;
    const dx = t.x - shipX;
    const dy = t.y - shipY;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestD2) {
      nearestD2 = d2;
      nearest = t;
    }
    if (prevTargetId !== null && t.id === prevTargetId) {
      prev = t;
      prevD2 = d2;
    }
  }

  // No hostiles in view: drop the slot's target. The caller's next-tick
  // call sees `prevTargetId = null` and starts fresh.
  if (!nearest) return null;

  // No previous target (first frame, or it died / left): take the nearest.
  if (!prev) return nearest;

  // Sticky branch: keep `prev` unless the nearest is meaningfully closer.
  // We compare squared distances against `(d * factor)²` so we don't need
  // a sqrt on the hot path. `prev` wins when
  //   d(prev) <= d(nearest) * factor
  //   ⇔ d²(prev) <= d²(nearest) * factor²
  const threshold = nearestD2 * factor * factor;
  if (prevD2 <= threshold) return prev;
  return nearest;
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
