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
import { registerDevTestMessages, type DevTestMessageHost } from './devTestMessages.js';
import { registerFireControlMessages, type FireControlMessageHost } from './fireControlMessages.js';
import { registerFleetMessages, type FleetMessageHost } from './fleetMessages.js';
import { registerLabMessages, type LabMessageHost } from './labMessages.js';
import type { RoomFeature } from './parsedMessage.js';
import { registerSelectionMessages, type SelectionMessageHost } from './selectionMessages.js';
import { registerShipUpgradeMessages, type ShipUpgradeMessageHost } from './shipUpgradeMessages.js';
import { registerStructureMessages, type StructureMessageHost } from './structureMessages.js';
import { registerStructureSettingMessages, type StructureSettingMessageHost } from './structureSettingMessages.js';
import { registerTeleportMessages, type TeleportMessageHost } from './teleportMessages.js';
import { registerTradeMessages, type TradeMessageHost } from './tradeMessages.js';
import { registerWebRtcMessages, type WebRtcMessageHost } from './webrtcMessages.js';

/** Every feature's narrow host, intersected (one per feature). */
export type RoomFeaturesHost =
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
  & WebRtcMessageHost;

const FEATURES: ReadonlyArray<(host: RoomFeaturesHost) => RoomFeature> = [
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
