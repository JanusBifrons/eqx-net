/**
 * RTS command layer, slice 5 — what a wingman shoots at, by stance.
 *
 * Pure: the room gathers the candidates (each already filtered to a live,
 * lockable target hostile to the OWNER, or the owner's explicit attack target),
 * this picks one. Firing then goes through the PLAYER weapon pipeline (locks,
 * bearing, cooldown, energy), so a wingman has a pilot's powers and no more.
 *
 * - `holdFire` never fires.
 * - `defensive` fires only back: at its explicit attack target, at whatever
 *   recently damaged it or its squad, or at a hostile inside its guard radius.
 * - `aggressive` fires at its own target (the hunt / attack target), else at
 *   the same defensive candidates, else at any hostile within weapon reach.
 *
 * A ship running away (retreat mode or a morale break) only returns fire at
 * whoever hit it: it doesn't start fights on the way out.
 */
import type { WingmanStance } from '../../core/ai/wingman/types.js';

export interface WingmanFireCandidates {
  /** Explicit `attack` order target (any entity the owner named), or null. */
  orderTargetId: string | null;
  /** The brain's own target (hunt pick or attack order), or null. */
  brainTargetId: string | null;
  /** Last ship that damaged this one or its squad, recently, or null. */
  recentAttackerId: string | null;
  /** Nearest owner-hostile contact inside the guard radius, or null. */
  guardHostileId: string | null;
  /** Nearest owner-hostile contact within weapon reach, or null. */
  reachHostileId: string | null;
  /** Retreat mode or a morale break: only return fire. */
  retreating: boolean;
}

export function pickWingmanFireTarget(stance: WingmanStance, c: Readonly<WingmanFireCandidates>): string | null {
  if (stance === 'holdFire') return null;
  if (c.retreating) return c.recentAttackerId;
  if (stance === 'defensive') return c.orderTargetId ?? c.recentAttackerId ?? c.guardHostileId;
  return c.brainTargetId ?? c.orderTargetId ?? c.recentAttackerId ?? c.guardHostileId ?? c.reachHostileId;
}

/** How long a hit counts as "recent" for the Defensive stance (10 s at 60 Hz). */
export const WINGMAN_RETALIATE_TICKS = 600;
