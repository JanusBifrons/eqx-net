/**
 * Click-to-inspect selection-scoped live-stats channel (Item B5):
 * `select_entity` / `deselect_entity`. The renderer tells the main thread
 * which entity is selected; the client forwards ship/structure selections
 * here. The ~5 Hz emit happens on the room's `selectionStatsTimer` (off the
 * hot path); these handlers only register / clear the per-connection
 * selection. Per-session cleanup on disconnect / transit lives in the room's
 * `onLeave` (no 5 Hz leak). Moved verbatim out of `SectorRoom.onCreate`.
 */
import type { SelectionStatsSubsystem } from '../SelectionStatsSubsystem.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { DeselectEntitySchema, SelectEntitySchema } from '../../../shared-types/messages.js';

/** What the selection handlers need from the room; getters read the live field. */
export interface SelectionMessageHost extends ParsedMessageHost {
  selectionStats(): Pick<SelectionStatsSubsystem, 'select' | 'deselect'>;
}

export function registerSelectionMessages(h: SelectionMessageHost): RoomFeature {
  parsedMessage(h, 'select_entity', SelectEntitySchema, (msg, client) => {
    h.selectionStats().select(client.sessionId, msg.id, msg.kind);
  });
  parsedMessage(h, 'deselect_entity', DeselectEntitySchema, (_msg, client) => {
    h.selectionStats().deselect(client.sessionId);
  });
  return {};
}
