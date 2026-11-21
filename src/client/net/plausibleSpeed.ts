/**
 * Teleport plausible-speed bound — the single definition shared by every
 * client-side interpolator that must tell real motion from a server
 * discontinuity (drone swarm interpolation today; the other-ship teleport
 * snap next).
 *
 * A server-side discontinuity — full-snapshot keyframe
 * (`FULL_SNAPSHOT_INTERVAL_TICKS=60`, once/sec), `SET_POSITION`, swarm
 * despawn+entityId-reuse, sleep→wake, or a remote ship's warp / respawn —
 * lands as two adjacent buffered poses thousands of units apart. An
 * unconditional lerp animates the sprite ACROSS that gap over the bracket
 * window (the entity "flies across the sector"). When the gap between two
 * bracketing poses exceeds what a real entity could plausibly travel in that
 * span, we are looking at a teleport, not motion — SNAP to the newer
 * authoritative pose instead of interpolating. `TELEPORT_MAX_PLAUSIBLE_SPEED`
 * sits comfortably above any ship/drone top speed (post-slow-down ~950 u/s);
 * the floor catches short-span jumps where `speed × span` underflows.
 */
export const TELEPORT_MAX_PLAUSIBLE_SPEED = 2500; // u/s — well above any entity
export const TELEPORT_FLOOR_U = 64; // absolute floor for tiny spans

/**
 * True when moving `distanceU` world units in `spanMs` milliseconds is too far
 * for real motion: strictly greater than max(floor, speed × span). A negative
 * span is treated as zero (floor only). Pure, allocation-free.
 */
export function isImplausibleJump(distanceU: number, spanMs: number): boolean {
  const maxPlausible = Math.max(
    TELEPORT_FLOOR_U,
    (TELEPORT_MAX_PLAUSIBLE_SPEED * Math.max(0, spanMs)) / 1000,
  );
  return distanceU > maxPlausible;
}
