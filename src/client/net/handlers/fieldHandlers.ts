/**
 * Server → client cut-field (macro terrain) edits: a rock consumed, a rock
 * moved. The cut field owns its state (`CutFieldClient`); these only forward.
 */
import type { Room } from 'colyseus.js';
import type { CutFieldClient } from '../CutFieldClient.js';

/** What the field handlers touch: the cut field's two message sinks. */
export interface FieldHandlerCtx {
  readonly cutField: Pick<CutFieldClient, 'onConsumedMessage' | 'onMovedMessage'>;
}

export function registerFieldHandlers(room: Room, ctx: FieldHandlerCtx): void {
  const cutField = ctx.cutField;
  room.onMessage('field_consumed', (raw: unknown) => cutField.onConsumedMessage(raw)); // macro terrain C3
  room.onMessage('field_moved', (raw: unknown) => cutField.onMovedMessage(raw)); // C2 deep sleep
}
