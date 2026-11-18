/**
 * Bounty client message — Living World P4c-2: a player places a bounty on
 * another player, paid from the placer's wallet. Moved verbatim out of
 * `SectorRoom.onCreate`; it looks the player and board up before parsing,
 * exactly as it did there, so it registers directly rather than through
 * `parsedMessage`.
 */
import type { Client } from 'colyseus';
import { getBountyBoard, type BountyRoom } from '../../economy/BountyBoard.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { PlaceBountySchema, type BountyResult } from '../../../shared-types/contracts.js';

/** What the handler needs from the room; getters read the live field. */
export interface BountyMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  sectorKey(): string | null;
  /** Where a placed bounty is announced (this room's world notice). */
  bountyRoom: BountyRoom;
}

export function registerBountyMessages(h: BountyMessageHost): RoomFeature {
  // ── Living World P4c-2 — place a player bounty ───────────────────────────
  h.onMessage('place_bounty', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    const board = getBountyBoard();
    if (!playerId || !board) return;
    const p = PlaceBountySchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'place_bounty'); return; }
    const reply = (ok: boolean, message: string): void => {
      try { client.send('bounty_result', { type: 'bounty_result', ok, message } satisfies BountyResult); } catch { /* closing */ }
    };
    if (h.sectorKey() === null) { reply(false, 'Bounties are only available in the galaxy.'); return; }
    // Economy v2 W1 — paid from the placer's WALLET (anywhere; guests too).
    const v = board.place(h.bountyRoom, playerId, p.data.targetPlayerId, p.data.amount);
    reply(v.ok, v.message);
  });

  return {};
}
