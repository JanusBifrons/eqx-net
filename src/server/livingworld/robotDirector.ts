/**
 * Robot director configuration (Living World P1b, plan peppy-jumping-pinwheel).
 *
 * The robots are a third AI side run by a SECOND `LivingWorldDirector`
 * instance — the same roam / flock / respawn / hop machinery as the drones,
 * with three differences:
 *   - bots are minted `rbot-*` in `rsquad-*` squads (no id collisions);
 *   - squads are MIXED-TIER (one hexagon lead, two circles, three cubes);
 *   - no waves: robots are hostile to players, drones and traders ON SIGHT via
 *     the shared stance table (`src/shared-types/allegiances.ts`), so the
 *     director only roams them and the room AI does the fighting.
 *
 * Kill switch: `EQX_DISABLE_ROBOTS=1` (independent of the drone director's
 * `EQX_DISABLE_LIVING_WORLD`, which disables both).
 */
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { SquadLayout } from './director/SquadPool.js';
import { ROBOT_BOT_ID_PREFIX } from './directorBotIds.js';
import type { LivingWorldOptions } from './LivingWorldDirector.js';

/** Robot squads. Smaller than drone squads (6 vs 8) but individually tougher. */
export const ROBOT_SQUAD_COUNT = 4;
export const ROBOT_SQUAD_SIZE = 6;
export const ROBOT_BOT_COUNT = ROBOT_SQUAD_COUNT * ROBOT_SQUAD_SIZE;

/** Slot → hull: a hexagon leads, two circles flank, cubes fill the rest. */
export function robotMemberKind(_squadIndex: number, memberIndex: number): ShipKindId {
  if (memberIndex === 0) return 'robot-hexagon';
  if (memberIndex <= 2) return 'robot-circle';
  return 'robot-square';
}

export const ROBOT_SQUAD_LAYOUT: SquadLayout = {
  squadCount: ROBOT_SQUAD_COUNT,
  squadSize: ROBOT_SQUAD_SIZE,
  squadIdPrefix: 'rsquad-',
  memberKind: robotMemberKind,
};

/** The option overlay that turns a `LivingWorldDirector` into the robot one. */
export const ROBOT_DIRECTOR_OPTIONS: Partial<LivingWorldOptions> = {
  allegiance: 'robots',
  botIdPrefix: ROBOT_BOT_ID_PREFIX,
  botCount: ROBOT_BOT_COUNT,
  squadLayout: ROBOT_SQUAD_LAYOUT,
  leadKind: 'robot-hexagon',
  wavesEnabled: false,
};

/** `EQX_DISABLE_ROBOTS=1|true` keeps the robot side out of the galaxy. */
export function isRobotsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['EQX_DISABLE_ROBOTS'];
  return v === '1' || v === 'true';
}
