/**
 * `JoinHandlerDeps` — the narrow room host the join path (`JoinHandler`,
 * `joinFreshSpawn`) runs against. Built once by SectorRoom in `onCreate`.
 */

import type { Client } from 'colyseus';
import type { MapSchema } from '@colyseus/schema';
import type { Logger } from 'pino';
import type { ShellSalvo } from '../../../shared-types/messages/shellEvents.js';
import type { Bus } from '../../../core/events/Bus.js';
import type { AiController } from '../../../core/ai/AiController.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { StatAlloc as CoreStatAlloc } from '../../../core/leveling/shipStats.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { StructureGridSubsystem } from '../../structures/StructureGridSubsystem.js';
import type { SnapshotRing } from '../../lagcomp/SnapshotRing.js';
import type { ShipState } from '../schema/SectorState.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { SectorObstacles } from '../SectorObstacles.js';
import type { CutFieldSubsystem } from '../CutFieldSubsystem.js';
import type { LockSubsystem } from '../LockSubsystem.js';
import type { PendingJoinRecord, WreckWelcomeFields } from './joinConstants.js';

/** The room state the join path reads and writes. Scalars the room may
 *  reassign are live getters (setters where the join writes them). */
export interface JoinHandlerDeps {
  readonly sectorKey: string | null;
  readonly roomId: string;
  readonly testMode: boolean;
  readonly enforceHullGate: boolean;
  readonly defaultSpawnX: number | null;
  readonly defaultSpawnY: number | null;
  readonly testWalletSeed: number;
  readonly serverTick: number;
  forceBroadcastUntilTick: number;
  testChargeTicksCap: number | undefined;
  testTraverseTicksCap: number | undefined;
  readonly sabF32: Float32Array;
  readonly sabU32: Uint32Array;
  readonly shipsMap: MapSchema<ShipState>;
  readonly sessionToPlayer: Map<string, string>;
  readonly playerToSession: Map<string, string>;
  readonly sessionRegisteredPlayer: Map<string, string>;
  readonly playerToUser: Map<string, string | null>;
  readonly playerToSlot: Map<string, number>;
  readonly slotToPlayer: Map<number, string>;
  readonly freeSlots: number[];
  readonly playerToActiveShipInstance: Map<string, string>;
  readonly lingeringSlots: Map<string, number>;
  readonly ownerlessShips: Map<string, ReturnType<typeof setTimeout> | null>;
  readonly initialSpawnPositions: Map<string, { x: number; y: number }>;
  readonly shipPoseCache: Map<string, ShipPhysicsState>;
  readonly lastFireClientTick: Map<string, number>;
  readonly playerToLingerMs: Map<string, number>;
  readonly pendingJoin: Map<string, PendingJoinRecord>;
  readonly pendingCommandStart: Set<string>;
  readonly sandboxHostileDroneIds: readonly string[];
  readonly obstacles: SectorObstacles;
  readonly cutField: CutFieldSubsystem | undefined;
  readonly bus: Bus;
  readonly swarmRegistry: SwarmEntityRegistry;
  readonly structureRegistry: StructureRegistry;
  readonly structureGrid: StructureGridSubsystem;
  readonly snapshotRing: SnapshotRing;
  readonly locks: LockSubsystem;
  readonly aiController: AiController;
  readonly logger: Logger;
  postToWorker(cmd: WorkerCmd): void;
  broadcast(type: string, message: unknown): void;
  wreckWelcomeFields(): WreckWelcomeFields;
  shellWelcomeFields(client: Client, playerId: string): { shellEvents?: true; shellsInFlight?: ShellSalvo[] };
  shipHullMax(kindMax: number, alloc: CoreStatAlloc | undefined, shipInstanceId: string): number;
  setTimeScale(scale: number): number;
  setLockTimeCap(capS: number): void;
  sendNotice(client: Client, text: string): void;
  resolveActiveShipKey(playerId: string): string | undefined;
  getActiveShip(playerId: string): ShipState | undefined;
  markAllDronesHostileTo(playerId: string): void;
  landingPoint(playerId: string, x: number, y: number, kind: string | undefined): { x: number; y: number };
  evictSessionForTakeover(sessionId: string): Promise<void>;
  evictOwnerlessShip(shipInstanceId: string): void;
  attachWingman(shipInstanceId: string): void;
  applyStatMulToWorker(bodyKey: string, alloc: CoreStatAlloc | undefined): void;
  /**
   * Upsert a `player_ships` row for the newly-bound ship. Looks up
   * existing roster entries for the player and reuses the most-recent;
   * creates a fresh row if none exists. Returns the row's `shipId` so
   * the caller can stamp it onto `ShipState.shipInstanceId`. Returns
   * empty string for engineering rooms or when the operation fails
   * (e.g. roster cap on a fresh-spawn fallback — caller continues; the
   * ship still spawns, just without a roster row).
   */
  bindRosterEntry(
    playerId: string,
    userId: string | null,
    kind: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
    preferredShipId?: string,
    forceFreshCreate?: boolean,
  ): string;
}

