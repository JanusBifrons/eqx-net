import { isDirectorBotId } from '../livingworld/directorBotIds.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import { SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';

/**
 * Coarse audit attribution from a shooter id's prefix — drone (`swarm-` /
 * `lwbot-`), structure turret (`pstruct-`), or a player otherwise. The raw
 * `attackerId` is always logged too, so this is a convenience label for
 * "what destroyed my base?" (a drone? a player?), not a precise lookup.
 * Moved out of `SectorRoom` so `features/shipProgression.ts` shares it.
 *
 * With `swarm`, an id that is a registry entity of any other kind (an
 * asteroid, scrap, a wreck piece: a ram "killer") is `environment`, by its
 * registry kind, never a `player`: a rock never earns a bounty, XP or a
 * wallet. Rock ids (`belt:…-asteroid-N`, `field:…`) carry no common prefix.
 */
export function classifyAttacker(id?: string, swarm?: Pick<SwarmEntityRegistry, 'get'>): string | undefined {
  if (!id) return undefined;
  if (id.startsWith('pstruct-')) return 'structure';
  if (id.startsWith('swarm-') || isDirectorBotId(id) || id.startsWith('scenario-drone')) return 'drone';
  const rec = swarm?.get(id);
  if (rec && rec.kind !== SWARM_KIND_DRONE && rec.kind !== SWARM_KIND_STRUCTURE) return 'environment';
  return 'player';
}
