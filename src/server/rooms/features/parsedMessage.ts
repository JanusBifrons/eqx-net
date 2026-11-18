/**
 * The room's one client-message boundary helper: register `type` on the
 * host, zod-parse every payload with `schema`, record a parse failure on the
 * room's `MalformedMessageTracker`, and hand only a valid message to `act`.
 */
import type { Client } from 'colyseus';
import type { MalformedMessageTracker } from '../MalformedMessageTracker.js';

/** What `parsedMessage` needs from the room. */
export interface ParsedMessageHost {
  onMessage(type: string, handler: (client: Client, raw: unknown) => void): void;
  malformed: Pick<MalformedMessageTracker, 'record'>;
}

/** Any zod schema (structural, so callers pass the schema object as is). */
export interface MessageSchema<T> {
  safeParse(raw: unknown): { success: true; data: T } | { success: false };
}

/** A feature's register function returns this; the room calls `dispose` in `onDispose`. */
export interface RoomFeature {
  dispose?: () => void;
}

export function parsedMessage<T>(
  host: ParsedMessageHost,
  type: string,
  schema: MessageSchema<T>,
  act: (msg: T, client: Client) => void,
): void {
  host.onMessage(type, (client: Client, raw: unknown): void => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      host.malformed.record(client.sessionId, type);
      return;
    }
    act(parsed.data, client);
  });
}
