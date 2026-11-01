/**
 * Director-owned bot id prefixes (Living World P1b, plan peppy-jumping-pinwheel).
 *
 * Every allegiance director mints its bots under its own prefix so squads,
 * persisted rows and incoming banners never collide. Code that classifies an
 * id as "an NPC bot" (attacker classification, missile splash kind, XP) MUST go
 * through `isDirectorBotId` rather than a hard-coded `lwbot-` check, or a new
 * director's bots would be mistaken for players.
 */

export const DRONE_BOT_ID_PREFIX = 'lwbot-';
export const ROBOT_BOT_ID_PREFIX = 'rbot-';
/** P2 — trade haulers (owned by the `TradeDirector`, not a squad director). */
export const HAULER_ID_PREFIX = 'hauler-';

/** True for any director-owned NPC id (drone, robot or trade hauler). Alloc-free. */
export function isDirectorBotId(id: string): boolean {
  return id.startsWith(DRONE_BOT_ID_PREFIX) || id.startsWith(ROBOT_BOT_ID_PREFIX) || id.startsWith(HAULER_ID_PREFIX);
}

export function isHaulerId(id: string): boolean {
  return id.startsWith(HAULER_ID_PREFIX);
}
