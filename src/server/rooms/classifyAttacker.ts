import { isDirectorBotId } from '../livingworld/directorBotIds.js';

/**
 * Coarse audit attribution from a shooter id's prefix — drone (`swarm-` /
 * `lwbot-`), structure turret (`pstruct-`), or a player otherwise. The raw
 * `attackerId` is always logged too, so this is a convenience label for
 * "what destroyed my base?" (a drone? a player?), not a precise lookup.
 * Moved out of `SectorRoom` so `features/shipProgression.ts` shares it.
 */
export function classifyAttacker(id?: string): string | undefined {
  if (!id) return undefined;
  if (id.startsWith('pstruct-')) return 'structure';
  if (id.startsWith('swarm-') || isDirectorBotId(id) || id.startsWith('scenario-drone')) return 'drone';
  return 'player';
}
