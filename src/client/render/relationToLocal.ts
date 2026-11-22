/**
 * Relationship of an entity to the local player: the ONE rule the far-zoom
 * icons, the radar colours and the contacts list share. Pure (no Pixi, no
 * DOM), so React panels import it without pulling in the renderer.
 */
export type FarIconRelation = 'self' | 'friendly' | 'hostile' | 'neutral' | 'trader';

/** Relationship of an entity to the local player, as the radar and contacts
 *  list read it: `isOwn` = yours (the ship you fly or your fleet); other
 *  pilots' ships (AI-flown too) are friendly; a drone is hostile when its AI
 *  targets you (`isHostileToLocal`), a trade hauler is a trader, else neutral. */
export function farIconRelation(isOwn: boolean, isPlayer: boolean, hostile: boolean, shipKind: string | undefined): FarIconRelation {
  if (isOwn) return 'self';
  if (isPlayer) return 'friendly';
  if (hostile) return 'hostile';
  return shipKind === 'trader-hauler' ? 'trader' : 'neutral';
}
