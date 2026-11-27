/**
 * `?room=sandbox` (docs/features/sandbox.md): the owner builds a base for free
 * and tries every ship. A SEALED room (`sealed`: nothing leaves it, never
 * saved, so a restart wipes it) with free builds, on hex deck plates like the
 * base-platforms rooms. Empty and peaceful: no rocks, no drones, no NPC bases,
 * no living-world director (it is not in the galaxy room map).
 *
 * NOT testMode: the test-only join options (`initialWallet`, `timeScale`, …)
 * and `test_*` messages stay off for the public players who reach it.
 *
 * Client create options never reach the room (blocker B3). Colyseus merges a
 * client's create options under the define options (`MatchMaker.handleCreateRoom`),
 * so `client.create('sandbox', { testMode: true, tickBurnMs: 50 })` would
 * otherwise get a room with test knobs. `SandboxRoom.onCreate` drops whatever
 * it is handed and passes only `SANDBOX_OPTS`. And there is only ever ONE
 * sandbox: the boot creates it eagerly (`galaxyRoomsBoot.ts`), it never
 * auto-disposes (it has a sectorKey), and any second create is refused, so
 * every joiner (`joinOrCreate`, no `filterBy`) joins that one.
 */
import type { Server } from 'colyseus';
import { SectorRoom } from '../SectorRoom.js';
import { SANDBOX_SECTOR_KEY } from '../sealedSectors.js';
import type { SectorRoomOptions } from '../sectorRoomOptions.js';

/** Registered room name (`?room=sandbox`). */
export const SANDBOX_ROOM_NAME = 'sandbox';

export const SANDBOX_OPTS = {
  sectorKey: SANDBOX_SECTOR_KEY,
  sealed: true,
  freeBuilds: true,
  persistSector: false,
  deck: true,
  asteroidConfig: [],
  droneCount: 0,
  peacefulDrones: true,
  // West of the first plate's anchor (the world origin), so the build site
  // starts clear of the ship.
  defaultSpawnX: -1000,
  defaultSpawnY: 0,
} as const satisfies SectorRoomOptions;

/** True while the one sandbox instance is live. */
let sandboxLive = false;

export class SandboxRoom extends SectorRoom {
  /** This instance holds the one-sandbox slot. */
  private ownsSandbox = false;

  /** `_clientOptions` is ignored on purpose (B3): see the file header. */
  override async onCreate(_clientOptions: unknown): Promise<void> {
    if (sandboxLive) throw new Error('sandbox: only one instance exists; join it');
    sandboxLive = this.ownsSandbox = true;
    try {
      await super.onCreate({ ...SANDBOX_OPTS, asteroidConfig: [] });
    } catch (err) {
      sandboxLive = this.ownsSandbox = false;
      throw err;
    }
  }

  override onDispose(): void {
    if (this.ownsSandbox) sandboxLive = this.ownsSandbox = false;
    super.onDispose();
  }
}

/** Register the sandbox room (gated by `shouldRegisterSandboxRoom`). */
export function defineSandboxRoom(gameServer: Pick<Server, 'define'>): void {
  gameServer.define(SANDBOX_ROOM_NAME, SandboxRoom);
}
