import { FC_MOUNT_FIRE_TOLERANCE } from '../combat/fireControlBearing.js';

/**
 * Fixed-gun trigger discipline (owner 2026-11-14: fire only when the shot will
 * hit; pilot skill, not a special power). The cone (rad) the target's hull
 * covers seen from `dist`: atan(hitRadius / dist), never wider than the
 * player's fixed-gun window `FC_MOUNT_FIRE_TOLERANCE`. `hitRadius` is the
 * target's hit circle plus the shot's own radius; Infinity ⇒ the window.
 */
export function hullFireCone(hitRadius: number, dist: number): number {
  if (!(dist > 0)) return FC_MOUNT_FIRE_TOLERANCE;
  const c = Math.atan(hitRadius / dist);
  return c < FC_MOUNT_FIRE_TOLERANCE ? c : FC_MOUNT_FIRE_TOLERANCE;
}
