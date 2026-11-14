/**
 * Plugs the fleet panel's command seam (`fleetCommands.ts`) into the real
 * network senders (RTS command layer, slice 12). Called once at client boot
 * (`App.tsx`, beside `setGameClient`). Each sender is a no-op without a live
 * room, so installing before the join is safe. `takeControls` keeps its
 * default (`sendPilotShip`).
 */
import { setFleetCommands } from './fleetCommands.js';
import {
  sendDisbandSquad,
  sendFleetOrder,
  sendFormSquad,
  sendSetMode,
  sendSetStance,
} from '../ships/shipActionsClient.js';

export function installFleetCommandSenders(): void {
  setFleetCommands({
    setMode: (ids, mode) => { sendSetMode([...ids], mode); },
    setStance: (ids, stance) => { sendSetStance([...ids], stance); },
    stop: (ids) => { sendFleetOrder([...ids], { kind: 'stop' }); },
    formSquad: (ids) => { sendFormSquad([...ids]); },
    disbandSquad: (squadId) => { sendDisbandSquad(squadId); },
  });
}
