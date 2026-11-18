/**
 * Pilot-seat client messages — `pilot_ship`, `spectate` and `command`. Moved
 * verbatim out of `SectorRoom.onCreate`; each parses first, then drops a
 * message from an unknown session.
 */
import type { Client } from 'colyseus';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { CommandSchema, PilotShipSchema, SpectateSchema } from '../../../shared-types/messages.js';

/** What the handlers need from the room; getters read the live field. */
export interface PilotMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  reclaimLingeringHull(client: Client, playerId: string, shipId: string): void;
  enterSpectate(playerId: string): void;
}

export function registerPilotMessages(h: PilotMessageHost): RoomFeature {
  // ── Phase 4 WS-A2 — same-sector instant pilot swap ─────────────────────
  // The player (a spectator after death, or piloting another hull) reclaims
  // one of their OWN lingering hulls parked in THIS sector and resumes control
  // IN-ROOM (no leave/rejoin → no spool, no curtain). Owner-gated: the request
  // is dropped unless `shipId` is a lingering hull (isActive=false) owned by
  // the requester and present in this sector. A foreign / active / unknown id
  // is a silent no-op. The reclaim reuses the lingering-hull reactivation
  // machinery + `RosterPersistence.markActive` and preserves the rekey/abandon
  // identity invariant. The fresh `welcome` re-anchors the client's prediction.
  parsedMessage(h, 'pilot_ship', PilotShipSchema, (msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    h.reclaimLingeringHull(client, playerId, msg.shipId);
  });

  // Equinox Phase-5 audit — STOP PILOTING → spectate (the inverse of
  // `pilot_ship`). The player toggled Spectate while flying an active hull;
  // DISPLACE it into a lingering hull so it's parked in-world AND surfaces in
  // the player's own parked hulls for the in-world Pilot dropdown. Owner-
  // gated by construction (`displaceActiveHullToLingering` only touches the
  // CALLER's own active hull) + no-op when they have none (already spectating).
  parsedMessage(h, 'spectate', SpectateSchema, (_msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    h.enterSpectate(playerId);
  });
  // RTS command layer — `command` enters command view; today an alias of
  // `spectate` (same code path), so the parked hull becomes a wingman.
  parsedMessage(h, 'command', CommandSchema, (_msg, client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    h.enterSpectate(playerId);
  });
  return {};
}
