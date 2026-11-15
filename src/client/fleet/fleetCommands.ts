/**
 * The fleet panel's command seam (RTS command layer, slice 14).
 *
 * The panel and strip call these; the network slice plugs its senders in with
 * {@link setFleetCommands} at boot. Until then every command is a no-op
 * (except `takeControls`, which already has a sender: `sendPilotShip`).
 * Ids are own-ship ids as in `selection.ids` (active ship = playerId,
 * parked hull = shipInstanceId).
 */
import type { FleetMode, FleetStance } from '@shared-types/messages/fleetStatusMessages';
import { sendPilotShip, type SetModeParams } from '../ships/shipActionsClient.js';

export interface FleetCommands {
  /** `data`: patrol `route`, escort `escortId`, retreat point `x`/`y` (slice 14b). */
  setMode(ids: readonly string[], mode: FleetMode, data?: SetModeParams): void;
  setStance(ids: readonly string[], stance: FleetStance): void;
  stop(ids: readonly string[]): void;
  formSquad(ids: readonly string[]): void;
  disbandSquad(squadId: string): void;
  takeControls(id: string): void;
}

const noop = (): void => {};

// TODO(rts): the network slice replaces these with the real senders.
const DEFAULTS: FleetCommands = {
  setMode: noop,
  setStance: noop,
  stop: noop,
  formSquad: noop,
  disbandSquad: noop,
  takeControls: (id) => {
    sendPilotShip(id);
  },
};

let current: FleetCommands = DEFAULTS;

/** Plug in (some of) the command senders. Missing ones keep the default. */
export function setFleetCommands(impl: Partial<FleetCommands>): void {
  current = { ...current, ...impl };
}

/** Back to the defaults (tests). */
export function resetFleetCommands(): void {
  current = DEFAULTS;
}

/** The commands in force. Read at call time, so a later plug-in applies. */
export function fleetCommands(): FleetCommands {
  return current;
}
