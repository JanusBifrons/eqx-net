/**
 * RTS command layer (slice 6b) — fleet commands: `fleet_order`, `set_mode`,
 * `set_stance`, `form_squad`, `disband_squad`. Routed to the owner-checked
 * `FleetCommandSubsystem` with the caller's playerId. Ids are checked PER ID
 * there: a foreign / unknown id drops silently, and so does the caller's
 * ACTIVE ship (its id is the playerId in the client's selection; it is never
 * attached because the player is flying it). Rate-limited per session per
 * tick like lock messages: the cap is checked BEFORE the parse, so these
 * register on `onMessage` directly rather than through `parsedMessage`.
 * Moved verbatim out of `SectorRoom.onCreate`; the room hands in live
 * accessors.
 */
import type { Client } from 'colyseus';
import type { FleetCommandSubsystem, FleetModeData } from '../../fleet/FleetCommandSubsystem.js';
import type { FleetStatusSoon } from '../../fleet/FleetStatusSoon.js';
import type { TransitOrchestrator } from '../../transit/TransitOrchestrator.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import {
  DisbandSquadSchema,
  FleetOrderSchema,
  FormSquadSchema,
  SetModeSchema,
  SetStanceSchema,
} from '../../../shared-types/messages.js';

/** The one `stop` order object (the brain only reads it). */
export const FLEET_STOP_ORDER = { kind: 'stop' } as const;

/** What the fleet handlers need from the room; getters read the live field. */
export interface FleetMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  /** Count one fleet command for `sessionId`; false = over this tick's cap (drop it). */
  fleetMsgAllowed(sessionId: string): boolean;
  fleet: Pick<FleetCommandSubsystem, 'applyOrder' | 'setMode' | 'setStance' | 'formSquad' | 'disbandSquad'>;
  fleetTransit(): Pick<TransitOrchestrator, 'fleetCommandIssued'> | null;
  fleetStatusSoon: Pick<FleetStatusSoon, 'request'>;
  serverTick(): number;
  playerToActiveShipInstance: ReadonlyMap<string, string>;
}

export function registerFleetMessages(h: FleetMessageHost): RoomFeature {
  /** Reused `set_mode` parameters (#14; the brain copies the route). */
  const fleetModeScratch: FleetModeData = {};
  h.onMessage('fleet_order', (client: Client, raw: unknown) => {
    if (!h.fleetMsgAllowed(client.sessionId)) return;
    const p = FleetOrderSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'fleet_order'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid === undefined) return;
    const d = p.data;
    // One order object per accepted command: the brain keeps it as its order.
    let accepted: readonly string[];
    if (d.kind === 'move') accepted = h.fleet.applyOrder(pid, d.shipIds, { kind: 'move', x: d.x!, y: d.y! });
    else if (d.kind === 'attack') accepted = h.fleet.applyOrder(pid, d.shipIds, { kind: 'attack', targetId: d.targetId! });
    else accepted = h.fleet.applyOrder(pid, d.shipIds, FLEET_STOP_ORDER);
    // RTS fleet warp: a new order to a spooling ship takes it out of the warp.
    h.fleetTransit()?.fleetCommandIssued(pid, accepted, false);
    h.fleetStatusSoon.request(client.sessionId, h.serverTick());
  });
  h.onMessage('set_mode', (client: Client, raw: unknown) => {
    if (!h.fleetMsgAllowed(client.sessionId)) return;
    const p = SetModeSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'set_mode'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid === undefined) return;
    const md = fleetModeScratch;
    // x/y: the retreat point (a lone x or y is ignored: no point).
    const hasPoint = p.data.x !== undefined && p.data.y !== undefined;
    md.x = hasPoint ? p.data.x : undefined;
    md.y = hasPoint ? p.data.y : undefined;
    md.route = p.data.route;
    // The client names its own active ship by playerId; the fleet knows it
    // by shipInstanceId (`pilotShipOf`, slice 4b).
    const esc = p.data.escortId;
    md.escortId = esc === pid ? (h.playerToActiveShipInstance.get(pid) ?? esc) : esc;
    const accepted = h.fleet.setMode(pid, p.data.shipIds, p.data.mode, md);
    md.route = undefined; md.escortId = undefined; md.x = undefined; md.y = undefined;
    // RTS fleet warp: the ship drops out and obeys (its hold is let go).
    h.fleetTransit()?.fleetCommandIssued(pid, accepted, true);
    h.fleetStatusSoon.request(client.sessionId, h.serverTick());
  });
  h.onMessage('set_stance', (client: Client, raw: unknown) => {
    if (!h.fleetMsgAllowed(client.sessionId)) return;
    const p = SetStanceSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'set_stance'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid === undefined) return;
    const accepted = h.fleet.setStance(pid, p.data.shipIds, p.data.stance);
    // RTS fleet warp: the ship drops out and obeys (its hold is let go).
    h.fleetTransit()?.fleetCommandIssued(pid, accepted, true);
    h.fleetStatusSoon.request(client.sessionId, h.serverTick());
  });
  h.onMessage('form_squad', (client: Client, raw: unknown) => {
    if (!h.fleetMsgAllowed(client.sessionId)) return;
    const p = FormSquadSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'form_squad'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid === undefined) return;
    h.fleet.formSquad(pid, p.data.shipIds);
    h.fleetStatusSoon.request(client.sessionId, h.serverTick());
  });
  h.onMessage('disband_squad', (client: Client, raw: unknown) => {
    if (!h.fleetMsgAllowed(client.sessionId)) return;
    const p = DisbandSquadSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'disband_squad'); return; }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid === undefined) return;
    h.fleet.disbandSquad(pid, p.data.squadId);
    h.fleetStatusSoon.request(client.sessionId, h.serverTick());
  });
  return {};
}
