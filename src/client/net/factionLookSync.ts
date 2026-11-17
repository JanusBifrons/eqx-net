/**
 * Claimed faction ship looks on the client: the welcome carries every claim
 * (`setFactionLooks`, #16) and `faction_look_claimed` adds one live. Both feed
 * the one registry in `shared-types/factions` that `teamColorOf` /
 * `teamSigilOf` / `teamEdgeOf` read; the desktop renderer worker gets its copy
 * from `WorkerRendererClient` (SET_FACTION_LOOKS) when the version moves.
 */
import { claimFactionLook } from '../../shared-types/factions.js';
import { FactionLookClaimedSchema } from '../../shared-types/messages/factionMessages.js';

/** `faction_look_claimed` handler: parse-and-drop (#3), then claim locally. */
export function onFactionLookClaimed(raw: unknown): void {
  const parsed = FactionLookClaimedSchema.safeParse(raw);
  if (!parsed.success) return;
  const { factionId, colorSlot, sigil } = parsed.data.look;
  claimFactionLook(factionId, colorSlot, sigil);
}
