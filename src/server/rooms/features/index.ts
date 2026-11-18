/**
 * The room's client-message features. `SectorRoom.onCreate` calls
 * `registerRoomFeatures` once; each feature registers its messages on the
 * host in the order listed and may return a `dispose` the room calls from
 * `onDispose`. A new client→server message is one `register<Feature>` file
 * here plus one row below.
 */
import { registerDevTestMessages, type DevTestMessageHost } from './devTestMessages.js';
import type { RoomFeature } from './parsedMessage.js';
import { registerTeleportMessages, type TeleportMessageHost } from './teleportMessages.js';

/** Every feature's narrow host, intersected. */
export type RoomFeaturesHost = DevTestMessageHost & TeleportMessageHost;

const FEATURES: ReadonlyArray<(host: RoomFeaturesHost) => RoomFeature> = [
  registerDevTestMessages,
  registerTeleportMessages,
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
