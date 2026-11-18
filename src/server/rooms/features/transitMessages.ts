/**
 * Transit client messages — `engage_transit` and `cancel_transit` (Phase 8
 * sub-phase B). Moved verbatim out of `SectorRoom.onCreate`. Both check the
 * sender and the orchestrator BEFORE the parse (a message from an unknown
 * session is dropped without a malformed note), so they register directly
 * rather than through `parsedMessage`.
 */
import type { Client } from 'colyseus';
import type { TransitOrchestrator } from '../../transit/TransitOrchestrator.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { CancelTransitSchema, EngageTransitSchema } from '../../../shared-types/messages.js';

/** What the handlers need from the room; getters read the live field. */
export interface TransitMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  transitOrchestrator(): Pick<
    TransitOrchestrator,
    'beginTransit' | 'beginFleetTransit' | 'cancelTransit' | 'cancelFleetTransits'
  > | null;
}

export function registerTransitMessages(h: TransitMessageHost): RoomFeature {
  h.onMessage('engage_transit', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    const transitOrchestrator = h.transitOrchestrator();
    if (!playerId || !transitOrchestrator) return;
    const parsed = EngageTransitSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'engage_transit');
      return;
    }
    // RTS fleet warp: the selected ships warp together (Command view).
    if (parsed.data.shipIds !== undefined) {
      transitOrchestrator.beginFleetTransit(
        playerId,
        parsed.data.targetSectorKey,
        parsed.data.shipIds,
        parsed.data.arrival,
      );
      return;
    }
    transitOrchestrator.beginTransit(
      playerId,
      parsed.data.targetSectorKey,
      parsed.data.arrival,
      parsed.data.shipId,
    );
  });

  h.onMessage('cancel_transit', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    const transitOrchestrator = h.transitOrchestrator();
    if (!playerId || !transitOrchestrator) return;
    const parsed = CancelTransitSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'cancel_transit');
      return;
    }
    transitOrchestrator.cancelTransit(playerId, 'manual');
    // …and any fleet warp they ordered (a disconnect does not cancel those).
    transitOrchestrator.cancelFleetTransits(playerId, 'manual');
  });
  return {};
}
