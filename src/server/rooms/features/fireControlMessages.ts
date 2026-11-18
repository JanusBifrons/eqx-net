/**
 * Fire control: lock / unlock / group mode (`lock_request`, `lock_track`,
 * `lock_cancel`, `set_group_mode`), routed to the room's player
 * `LockSubsystem` with the caller's playerId. The four lock messages share a
 * per-session cap of `MAX_LOCK_MSGS_PER_TICK` per tick (like inputs); the
 * excess is silently dropped. The cap is checked BEFORE the parse, so these
 * register on `onMessage` directly rather than through `parsedMessage`.
 * Moved verbatim out of `SectorRoom.onCreate`; the room hands in live
 * accessors.
 */
import type { Client } from 'colyseus';
import { decodeAim } from '../../../core/combat/manualAim.js';
import type { LockSubsystem } from '../LockSubsystem.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import {
  LockCancelSchema,
  LockRequestSchema,
  LockTrackSchema,
  SetGroupModeSchema,
} from '../../../shared-types/messages.js';

/** What the fire-control handlers need from the room; getters read the live field. */
export interface FireControlMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  /** Count one lock message for `sessionId`; false = over this tick's cap (drop it). */
  lockMsgAllowed(sessionId: string): boolean;
  /** The player lock machine (the room builds it in `onCreate`). */
  fireControlLocks(): Pick<LockSubsystem, 'requestLock' | 'trackLock' | 'cancelLock' | 'setMode'>;
}

export function registerFireControlMessages(h: FireControlMessageHost): RoomFeature {
  h.onMessage('lock_request', (client: Client, raw: unknown) => {
    if (!h.lockMsgAllowed(client.sessionId)) return;
    const parsed = LockRequestSchema.safeParse(raw);
    if (!parsed.success) { h.malformed.record(client.sessionId, 'lock_request'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid !== undefined) h.fireControlLocks().requestLock(pid, parsed.data.groupId, parsed.data.target);
  });
  h.onMessage('lock_track', (client: Client, raw: unknown) => {
    if (!h.lockMsgAllowed(client.sessionId)) return;
    const parsed = LockTrackSchema.safeParse(raw);
    if (!parsed.success) { h.malformed.record(client.sessionId, 'lock_track'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    const b = parsed.data.b;
    if (pid !== undefined) h.fireControlLocks().trackLock(pid, parsed.data.groupId, parsed.data.target, b === undefined ? undefined : decodeAim(b));
  });
  h.onMessage('lock_cancel', (client: Client, raw: unknown) => {
    if (!h.lockMsgAllowed(client.sessionId)) return;
    const parsed = LockCancelSchema.safeParse(raw);
    if (!parsed.success) { h.malformed.record(client.sessionId, 'lock_cancel'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid !== undefined) h.fireControlLocks().cancelLock(pid, parsed.data.groupId, parsed.data.target);
  });
  h.onMessage('set_group_mode', (client: Client, raw: unknown) => {
    if (!h.lockMsgAllowed(client.sessionId)) return;
    const parsed = SetGroupModeSchema.safeParse(raw);
    if (!parsed.success) { h.malformed.record(client.sessionId, 'set_group_mode'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid !== undefined) h.fireControlLocks().setMode(pid, parsed.data.groupId, parsed.data.mode);
  });
  return {};
}
