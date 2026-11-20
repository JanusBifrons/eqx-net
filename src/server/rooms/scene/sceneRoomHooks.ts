/**
 * Room side of a perf scene: parse the room's `sceneScript` option, open the
 * scene's tick rings, join the `/dev/perf` registry and build the
 * `SceneScriptRunner` with the room's spawn / hostility / fleet / rock hooks.
 * Moved verbatim out of `SectorRoom.initSceneScript` (god-file split slice
 * 26); the room hands in a narrow host (`() => value` for fields it
 * reassigns) and keeps the returned runner and rings. Runs once at room
 * creation (testMode only), never on the tick.
 */
import { FrameTimeRing } from '../../../core/perf/FrameTimeRing.js';
import type { AiController } from '../../../core/ai/AiController.js';
import { getShipKind, type ShipKindId } from '../../../shared-types/shipKinds.js';
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../../spawn/SwarmSpawner.js';
import type { CapitalWreckSubsystem } from '../CapitalWreckSubsystem.js';
import type { SectorSnapshotRestore } from '../SectorSnapshotRestore.js';
import { getDroneMaxHealth, getDroneShieldMax } from '../droneKindHelpers.js';
import { SceneScriptRunner, SceneScriptSchema, type SceneHooks } from './SceneScriptRunner.js';
import { registerScenePerfRoom, type ScenePerfSource } from './scenePerfRegistry.js';

/** What the scene hooks read from the room; getters read the live field. */
export interface SceneRoomHost {
  /** The room itself, as the `/dev/perf` source. */
  perfSource: ScenePerfSource;
  serverTick(): number;
  sectorKey(): string | null;
  playerToSlot(): ReadonlyMap<string, number>;
  swarmSpawner(): Pick<SwarmSpawner, 'spawnDrone' | 'spawnAsteroid'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
  swarmHealth(): Map<string, number>;
  swarmShield(): Map<string, number>;
  swarmShieldLastDmg(): Map<string, number>;
  aiController(): Pick<AiController, 'markHostile'>;
  broadcast(type: string, msg: unknown): void;
  spawnLivingWorldBot(spec: { botId: string; kind: ShipKindId; x: number; y: number }): boolean;
  snapshotRestore: Pick<SectorSnapshotRestore, 'restoreLingeringHulls'>;
  lingeringSlots: ReadonlyMap<string, number>;
  fleet: Pick<FleetCommandSubsystem, 'setStance' | 'setMode' | 'applyOrder'>;
  capitalWrecks(): Pick<CapitalWreckSubsystem, 'rockCut'> | null;
  /** Structure-restyle 2f sandbox: the rig clip / ship mover hooks (`RigScene.sceneHooks`). */
  rigSceneHooks(): Pick<SceneHooks, 'moveShip' | 'rigClip'>;
}

export interface SceneRoomParts {
  runner: SceneScriptRunner;
  tickRing: FrameTimeRing;
  workerRing: FrameTimeRing;
}

/** Throws on an invalid script (the room refuses to start). */
export function initSceneScript(host: SceneRoomHost, raw: unknown): SceneRoomParts {
  const parsed = SceneScriptSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid sceneScript: ${parsed.error.message}`);
  const tickRing = new FrameTimeRing(36_000);
  const workerRing = new FrameTimeRing(36_000);
  registerScenePerfRoom(host.perfSource);
  const runner = new SceneScriptRunner(parsed.data, {
    spawn: (id, kind, x, y, warpIn) => {
      if (warpIn) return host.spawnLivingWorldBot({ botId: id, kind, x, y });
      if (!host.swarmSpawner().spawnDrone({ id, x, y, kind })) return false;
      host.swarmHealth().set(id, getDroneMaxHealth(kind) ?? 40);
      host.swarmShield().set(id, getDroneShieldMax(kind));
      host.swarmShieldLastDmg().set(id, host.serverTick());
      return true;
    },
    markHostileToAll: (id) => {
      const rec = host.swarmRegistry.get(id);
      if (!rec) return;
      const tick = host.serverTick();
      for (const playerId of host.playerToSlot().keys()) {
        host.aiController().markHostile(rec.id, playerId, tick);
        host.broadcast('bot_aggro', { type: 'bot_aggro', botEntityId: `swarm-${rec.entityId}`, targetPlayerId: playerId, tick });
      }
    },
    // RTS fleet perf: a parked hull owned by the first pilot, built through
    // the same reconstruction path a restart uses (roster row + lingering
    // slot + AI pilot), then given its mode / stance through the
    // owner-checked fleet API. Under EQX_DISABLE_WINGMEN it just sits parked.
    ownedHull: (kind, x, y, opts) => {
      let owner: string | null = null;
      for (const pid of host.playerToSlot().keys()) { owner = pid; break; }
      if (owner === null) return false;
      const health = opts.health ?? getShipKind(kind).maxHealth;
      let shipId: string;
      try {
        shipId = getPlayerShipStore().create({ playerId: owner, userId: null, kind, sectorKey: host.sectorKey() ?? 'perf', x, y, health }).shipId;
      } catch { return false; }
      host.snapshotRestore.restoreLingeringHulls([{
        shipInstanceId: shipId, playerId: owner, kind, x, y, vx: 0, vy: 0, angle: 0, angvel: 0, health, shieldDown: false,
      }]);
      if (!host.lingeringSlots.has(shipId)) return false;
      host.fleet.setStance(owner, [shipId], opts.stance);
      host.fleet.setMode(owner, [shipId], opts.mode);
      if (opts.moveTo) host.fleet.applyOrder(owner, [shipId], { kind: 'move', x: opts.moveTo.x, y: opts.moveTo.y });
      return true;
    },
    // Rock-cut scene: still rocks, then each mined to a break (RockCutter.sceneCut).
    spawnRock: (id, x, y, radius) => host.swarmSpawner().spawnAsteroid({ id, x, y, vx: 0, vy: 0, radius, mass: 1 }),
    cutRock: (id) => host.capitalWrecks()?.rockCut.sceneCut(id) ?? false,
    ...host.rigSceneHooks(), // structure-restyle 2f sandbox
  });
  return { runner, tickRing, workerRing };
}
