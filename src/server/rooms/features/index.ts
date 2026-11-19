/**
 * The room's client-message features. `SectorRoom.onCreate` calls
 * `registerRoomFeatures` once; each feature registers its messages on the
 * host in the order listed and may return a `dispose` the room calls from
 * `onDispose`. A new client→server message is one `register<Feature>` file
 * here plus one row below.
 */
import { registerBlueprintMessages, type BlueprintMessageHost } from './blueprintMessages.js';
import { registerBountyMessages, type BountyMessageHost } from './bountyMessages.js';
import { registerCargoMessages, type CargoMessageHost } from './cargoMessages.js';
import { registerControlMessages, type ControlMessageHost } from './controlMessages.js';
import { registerDevTestMessages, type DevTestMessageHost } from './devTestMessages.js';
import { registerFireControlMessages, type FireControlMessageHost } from './fireControlMessages.js';
import { registerFleetMessages, type FleetMessageHost } from './fleetMessages.js';
import { registerLabMessages, type LabMessageHost } from './labMessages.js';
import { registerNavMessages, type NavMessageHost } from './navMessages.js';
import type { RoomFeature } from './parsedMessage.js';
import { registerPilotMessages, type PilotMessageHost } from './pilotMessages.js';
import { registerSelectionMessages, type SelectionMessageHost } from './selectionMessages.js';
import { registerShipUpgradeMessages, type ShipUpgradeMessageHost } from './shipUpgradeMessages.js';
import { registerStructureMessages, type StructureMessageHost } from './structureMessages.js';
import { registerStructureSettingMessages, type StructureSettingMessageHost } from './structureSettingMessages.js';
import { registerTeleportMessages, type TeleportMessageHost } from './teleportMessages.js';
import { registerTradeMessages, type TradeMessageHost } from './tradeMessages.js';
import { registerTransitMessages, type TransitMessageHost } from './transitMessages.js';
import { registerWebRtcMessages, type WebRtcMessageHost } from './webrtcMessages.js';

/** Every feature's narrow host, intersected (one per feature). */
export type RoomFeaturesHost =
  & TransitMessageHost
  & ControlMessageHost
  & DevTestMessageHost
  & TeleportMessageHost
  & TradeMessageHost
  & LabMessageHost
  & BlueprintMessageHost
  & CargoMessageHost
  & StructureMessageHost
  & StructureSettingMessageHost
  & BountyMessageHost
  & ShipUpgradeMessageHost
  & FleetMessageHost
  & FireControlMessageHost
  & SelectionMessageHost
  & WebRtcMessageHost
  & PilotMessageHost
  & NavMessageHost;

const FEATURES: ReadonlyArray<(host: RoomFeaturesHost) => RoomFeature> = [
  registerTransitMessages,
  registerControlMessages,
  registerDevTestMessages,
  registerTeleportMessages,
  registerTradeMessages,
  registerLabMessages,
  registerBlueprintMessages,
  registerCargoMessages,
  registerStructureMessages,
  registerStructureSettingMessages,
  registerBountyMessages,
  registerShipUpgradeMessages,
  registerFleetMessages,
  registerFireControlMessages,
  registerSelectionMessages,
  registerWebRtcMessages,
  registerPilotMessages,
  registerNavMessages,
];

export function registerRoomFeatures(host: RoomFeaturesHost): Required<RoomFeature> {
  const disposers: Array<() => void> = [];
  for (const register of FEATURES) {
    const { dispose } = register(host);
    if (dispose) disposers.push(dispose);
  }
  return {
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}
