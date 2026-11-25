import { Room, Client } from 'colyseus';
import { playerInMiningBeam, MINING_BEAM_HALF_WIDTH } from '../../core/combat/miningBeamHazard.js';
// clampFireTick now used inside PlayerFireResolver.ts
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { SimulationClock } from '../../core/clock/SimulationClock.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import {
  subscribeGcPause,
  unsubscribeGcPause,
  type GcPauseEvent,
} from '../debug/GcMonitor.js';
import type { GcPauseEventMessage } from '../../shared-types/messages.js';
import type { WarpWarningEvent, WarpWarningClearEvent } from '../../shared-types/messages.js';
import { SESSION_REPLACED_CLOSE_CODE, type SessionReplacedMessage } from '../../shared-types/messages.js';
import {
  unregisterPlayerSession,
} from '../identity/PlayerSessionRegistry.js';
import { isHaulerId } from '../livingworld/directorBotIds.js';
import { getTradeSink } from '../economy/tradeSink.js';
import type { TradeNetworkSnapshot, TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import type { TradeNotice } from '../../shared-types/economy.js';
import { SectorState, ShipState } from './schema/SectorState.js';
import type { MineFieldSubsystem } from '../structures/MineFieldSubsystem.js';
import type { ShellBlast } from '../../shared-types/shellBlast.js';
import { assertRoomSeedBounds } from './roomSeedBounds.js';
import type { SectorRoomOptions } from './sectorRoomOptions.js';
import { StructuresSliceSync } from './structuresSlice.js';
import { seedScaleGrid, seedScenarioScrap, seedStructureScenario, structureRowsForTests, type StructureScenarioHost } from './scenarioLayouts.js';
import { seedRoomStartup } from './roomStartupSeed.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { LoadShedder } from '../orchestration/LoadShedder.js';
import { SpatialGrid } from '../interest/SpatialGrid.js';
import { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import { CollisionBroadcastGate } from '../net/CollisionBroadcastGate.js';
import {
  createIdleTracker,
  type IdleTracker,
} from '../net/snapshotScheduler.js';
import { SwarmSpawner, type AsteroidSpec } from '../spawn/SwarmSpawner.js';
import { ScrapSpawner, spawnScrapFromDrone, type DroneScrapHost } from '../spawn/ScrapSpawner.js';
import { wreckSwitchOn } from './wreckSwitch.js';
// Vec2 was used by the inline WorkerCmd union; now in PhysicsWorkerProxy.
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { AiController } from '../../core/ai/AiController.js';
import { AiInputBatch } from '../../core/ai/AiInputBatch.js';
import { HostileDroneBehaviour } from '../../core/ai/HostileDroneBehaviour.js';
import { PassiveDroneBehaviour } from '../../core/ai/PassiveDroneBehaviour.js';
// pickTarget / rotateMountToward / wrapPi / MountTargetView now used
// inside WeaponMountTicker.ts; this file no longer imports them.
import type { AiPlayerView, AiStructureView, AiSwarmView, AiEntity, AiEntityPoseOut } from '../../core/contracts/IAiBehaviour.js';
import { getShipKind, allegianceOfKind, isShipKindId, type ShipKind, type ShipKindId, type WeaponMount } from '../../shared-types/shipKinds.js';
import { isFriendly } from '../../shared-types/allegiances.js';
import { effectiveShipMaxHealth, type StatAlloc as CoreStatAlloc } from '../../core/leveling/shipStats.js';
// applyLayeredDamage + regenStep + ShieldHullState now used inside ShieldHullRouter.ts.
import { shipScrapGroups } from '../../core/geometry/shipScrapGroups.js';
import { SWARM_KIND_DRONE, SWARM_KIND_SCRAP } from '../../shared-types/swarmWireFormat.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { pushNotifier } from '../push/PushNotifier.js';
import { unregisterConnectedPlayer } from '../push/connectedPlayers.js';
import type { BotCarry } from '../livingworld/botTypes.js';

// Drone-kind catalogue helpers moved to ./droneKindHelpers.ts.
import { getDroneMaxHealth } from './droneKindHelpers.js';
import { StructureRegistry, type StructureRecord } from '../structures/StructureRegistry.js';
import { FactionLedger, type BaseReadinessHost } from '../faction/FactionLedger.js';
import type { FactionBaseReadiness, SectorLiveCounts } from '../livingworld/LivingWorldRoom.js';
import { RecentCombatLog } from './RecentCombatLog.js';
import type { RecentCombat } from '../../shared-types/galaxySnapshot.js';
import { leavePlateBlueprint } from '../structures/plateAnchorRebuild.js';
import { StructurePlacementSubsystem, packedGateForBuild, repackItem, type PackedGateHost } from '../structures/StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from '../structures/StructureGridSubsystem.js';
import { canTakeFullDraw } from '../structures/structurePowerSwitch.js';
import { ShieldWallManager } from '../structures/ShieldWallManager.js';
import type { GateController } from '../structures/GateController.js';
import { buildGateController } from '../structures/gateControllerFactory.js';
import { createRelationContext, isNpcOwner, npcOwner, parseOwner, relationOf, walletOwnerOf, type StandingQuery } from '../../shared-types/relations.js';
import { BreakInSubsystem } from './BreakInSubsystem.js';
import { ForceFieldSubsystem, lockKeyBodyId } from './ForceFieldSubsystem.js';
import { registerRoomFeatures } from './features/index.js';
import { HostileActLedger } from '../../core/relations/HostileActLedger.js';
import { ProductionSubsystem } from '../structures/ProductionSubsystem.js';
import { swapBlueprintFor } from '../structures/blueprintSwap.js';
import { seedAlienGates, seedPocketPads, type NpcGateSeedHost, type TeleporterSubsystem } from '../structures/TeleporterSubsystem.js';
import { getTeleportBroker, type TeleportRoom } from '../teleport/TeleportBroker.js';
import { isNpcBasesDisabled, seedGalaxyBase, seedNpcBases, type NpcBaseSeedHost } from '../bases/NpcBaseSubsystem.js';
import { hashString } from '../../core/bases/baseProfile.js';
import { nearestClearPoint } from '../../core/bases/baseSite.js';
import { SECTOR_PLAYABLE_HALF_EXTENT, SOLAR_SECTORS } from '../../shared-types/sectorBounds.js';
import { SOLAR_HALF_EXTENT } from '../../core/galaxy/sectorSites.js';
import type { CraneHaulJob, NpcBaseTrade } from '../economy/convoyRoom.js';
import { npcBaseTrade } from '../economy/npcBaseTrade.js';
import { buildStructureRigs, type StructureRigs } from './features/structureRigs.js';
import { LAUNCH_COSTS_ON } from '../../shared-types/launch.js';
import { chargeLaunchFor } from './launchGate.js';
import { ASTEROID_YIELD, rollAsteroidResource, type AsteroidFieldFeature, type AsteroidResourceId } from '../../shared-types/asteroidResources.js';
import { getSector } from '../../core/galaxy/galaxy.js';

/** P2d — one unit of munitions (a turret's magazine reload). */
const ONE_MUNITION = Object.freeze({ munitions: 1 });
const WRECK_WELCOME: WreckWelcomeFields = Object.freeze({ capitalWrecks: true as const });
const SUBCAP_WRECK_WELCOME: WreckWelcomeFields = Object.freeze({ subcapWrecks: true as const });
const BOTH_WRECK_WELCOME: WreckWelcomeFields = Object.freeze({ capitalWrecks: true as const, subcapWrecks: true as const });
const NO_WELCOME_FIELDS: WreckWelcomeFields = Object.freeze({});

/** P2c — give each asteroid in a roster its resource kind, rolled from the
 *  sector's features and seeded by the asteroid's id (stable across restarts). */
function withAsteroidResources<T extends { id: string }>(roster: readonly T[], features: readonly AsteroidFieldFeature[]): Array<T & { resource: AsteroidResourceId }> {
  return roster.map((a) => {
    let h = 2166136261;
    for (let i = 0; i < a.id.length; i++) h = Math.imul(h ^ a.id.charCodeAt(i), 16777619);
    return { ...a, resource: rollAsteroidResource((h >>> 0) / 4294967296, features) };
  });
}
import { NPC_ALLEGIANCE_IDS, type NpcAllegianceId } from '../../shared-types/allegiances.js';
import {
  defaultFactionPolicy,
  type FactionPolicy,
} from '../../shared-types/factions.js';
import type { FactionLookClaimed } from '../../shared-types/messages/factionMessages.js';

/** B2 — the party string of each roaming NPC side (`npc:<allegiance>`), built
 *  once so turret and missile queries never build strings. */
/** Factions F1 — the standing web, read through the trade sink (the economy
 *  store owns it). No sink (tests, Living World off) reads as 0. */
const ROOM_STANDING: StandingQuery = { of: (from, to) => getTradeSink()?.standing?.(from, to) ?? 0 };
/** F3 — a faction's policy, read through the trade sink (players' own
 *  settings live in the economy store). No sink ⇒ the catalogue defaults. */
const ROOM_POLICY = (faction: string): FactionPolicy => getTradeSink()?.policyOf?.(faction) ?? defaultFactionPolicy(faction);
const NPC_SIDE_PARTY = Object.fromEntries(NPC_ALLEGIANCE_IDS.map((a) => [a, npcOwner(a)])) as Record<NpcAllegianceId, string>;
import { AiStructureTargets } from './features/aiStructureTargets.js';
import { AlienGateGuard, isAlienGatesDisabled } from '../structures/AlienGateGuard.js';
import { PatrolSubsystem } from '../bases/PatrolSubsystem.js';
import { alienGateSites } from '../../core/galaxy/alienGates.js';
import { TRANSFER_PULSE_MS, TURRET_TICK_MS } from '../../core/structures/structureGridConstants.js';
import { clampToSectorBounds } from '../../shared-types/sectorBounds.js';
// Mount/slot geometry helpers moved to ./mountGeometry.ts.
import { resolveSlotMounts, mountWorldOrigin } from './mountGeometry.js';
import { resolveInstanceMounts, resolveInstanceFireMounts } from '../../shared-types/shipKinds/slots.js';
import { podSizeClass } from '../../shared-types/shipKinds/cargoPod.js';
import { WeaponMountTicker } from './WeaponMountTicker.js';
import type { LockSubsystem } from './LockSubsystem.js';
import type { NpcLockSubsystem } from './NpcLockSubsystem.js';
import { fillRangeShape } from '../../core/combat/fireControlBearing.js';
import type { PhysicsWorkerProxy, WorkerCmd } from './PhysicsWorkerProxy.js';
import { classifyAttacker } from './classifyAttacker.js';
import { RoomHitStanding, adjustStanding } from './features/hitStanding.js';
import { ShipProgression } from './features/shipProgression.js';
import { ProjectilePipeline } from './ProjectilePipeline.js';
import { MissileSimulation } from './MissileSimulation.js';
import { ShieldHullRouter } from './ShieldHullRouter.js';
import { AiFireResolver } from './AiFireResolver.js';
import { PlayerFireResolver } from './PlayerFireResolver.js';
import { DamageRouter } from './DamageRouter.js';
import { RespawnHandler } from './RespawnHandler.js';
import { SwarmEvictor } from './SwarmEvictor.js';
import { RosterPersistence } from './RosterPersistence.js';
import { SnapshotBroadcaster } from './SnapshotBroadcaster.js';
import { WebRtcChannelManager, type WebRtcEntryCounters } from '../transport/webrtcChannel.js';
import { nodeDataChannelPeerConnectionFactory } from '../transport/webrtcChannelFactory.js';
import { SwarmBroadcaster } from './SwarmBroadcaster.js';
import { EntitySyncRouter } from './EntitySyncRouter.js';
import { isLingeringHull } from '../../core/entity/shipLiveness.js';
import { MalformedMessageTracker } from './MalformedMessageTracker.js';
import { guarded } from './guardedLoop.js';
import { BattleWreckSaves, battleWreckStore, WRECK_LINEAGE_FLUSH_MS } from './wreckLineageSaves.js';
import { CutFieldSubsystem } from './CutFieldSubsystem.js';
import type { ChunkSource } from '../../core/terrain/chunkStreamer.js';
import type { WreckFieldSource } from './WreckFieldSource.js';
import { RoomNav } from '../nav/RoomNav.js';
import type { SectorRoomInternals } from './sectorRoomInternals.js';
import { SectorPersistence } from './SectorPersistence.js';
import { LivingWorldBotHooks } from './LivingWorldBotHooks.js';
import type { SceneScriptRunner, SceneStatus } from './scene/SceneScriptRunner.js';
import { initSceneScript } from './scene/sceneRoomHooks.js';
import { unregisterScenePerfRoom, sceneSimTime, sceneBodyCensus, SCENE_RECENT_TICKS, type ScenePerfView, type SceneBodyCensusHost } from './scene/scenePerfRegistry.js';
import { SceneWorkCounters } from './scene/SceneWorkCounters.js';
import type { EventLoopUtilization } from 'node:perf_hooks';
import { FrameTimeRing } from '../../core/perf/FrameTimeRing.js';
import { OwnerlessShipEvictor } from './OwnerlessShipEvictor.js';
import { FleetCommandSubsystem } from '../fleet/FleetCommandSubsystem.js';
import { LeaveHandler } from './LeaveHandler.js';
import { JoinHandler } from './join/JoinHandler.js';
import { TeleportTolls } from './features/teleportTolls.js';
import { TeleportPadRiders, buildTeleporters } from './features/teleportMessages.js';
import { WingmanPilots } from './features/wingmanPilots.js';
import { FleetRoomHooks } from './features/fleetRoomHooks.js';
import { PilotSwap } from './features/pilotSwap.js';
import { RoomRayHits, playerHitscanDist, swarmRayHit } from './features/rayHits.js';
import { RoomWreckSpawns } from './features/wreckSpawns.js';
import { structureSpillPoint } from './features/structureSpill.js';
import { FireControlLocks } from './features/fireControlLocks.js';
import { swarmLockId } from './lockSalvage.js';
import { transitHostRoom } from './features/transitMessages.js';
import { HullHandOff, newHullOrigin } from './features/hullHandOff.js';
import { BreakInHooks } from './features/breakInHooks.js';
import { TurretTargeting } from './features/turretTargeting.js';
import { SectorTimeScale } from './features/sectorTimeScale.js';
import { MineHooks, buildMineField } from './features/mineHooks.js';
import { StorageRaid } from './features/tradeMessages.js';
import {
  ALLOW_DEV_OVERRIDES,
  JOIN_BROADCAST_GRACE_TICKS,
  hullExtent,
  type PendingJoinRecord,
  type WreckWelcomeFields,
} from './join/joinConstants.js';
import { ChargeTicksCapSchema, LockTimeCapSchema, TimeScaleSchema, TraverseTicksCapSchema } from './join/joinOptions.js';
import { mirrorSabPoses } from './SabPoseMirror.js';
import { createPhysicsWorker } from './contactFilter.js';
import { updateSwarmInterestGrid } from './swarmInterestUpdater.js';
import { recordLagCompPoses } from './lagCompRecorder.js';
import { TickBudgetTelemetry } from './TickBudgetTelemetry.js';
import { TickHealthWindow } from './TickHealthWindow.js';
import { processTickHealth } from './ProcessTickHealth.js';
import {
  evaluateSectorIdle,
  findAbandonedShips,
} from './sectorIdleEvaluator.js';
import { runAiTick } from './aiTickRunner.js';
import { AiNeighbourFill } from './AiNeighbourFill.js';
import { SectorObstacles } from './SectorObstacles.js';
import {
  TICK_IDX,
  WORKER_TICK_US_IDX,
  WORKER_DROPPED_TICKS_IDX,
  COUNT_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  // FLAG_INPUT_* now used inside SnapshotBroadcaster.ts; the warp flags feed
  // the warp travel tracker below.
  SLOT_FLAGS_OFF,
  FLAG_WARP_SPOOL,
  FLAG_WARP_CRUISE,
  FLAG_SLEEPING,
  // SEQLOCK_IDX + SLOT_APPLIED_TICK_OFF moved into SabPoseMirror.ts
  slotBase,
  SAB_TOTAL_BYTES,
  MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';
import { SnapshotRing } from '../lagcomp/SnapshotRing.js';
import { WarpTravelTracker } from './warpTravel.js';
import { WarpRouteCheck } from './warpRouteCheck.js';
// checkBackpressure now used inside SnapshotBroadcaster.ts + SwarmBroadcaster.ts
import { saveSnapshot } from '../stats/StatsService.js';
import { db } from '../db/Database.js';
import { SectorSnapshotRestore } from './SectorSnapshotRestore.js';
import { getPlayerShipStore, getHoldStore, getWallet, getLabBoard, terrainRecordStoreFor } from '../db/PersistenceWorker.js';
import { ResearchLabSubsystem } from '../structures/ResearchLabSubsystem.js';
import type { LootSubsystem } from '../cargo/LootSubsystem.js';
import { buildLootPods } from './features/lootPods.js';
import { NpcLootHolds } from '../cargo/NpcLootHolds.js';
import { LootSearch } from '../cargo/LootSearch.js';
import { dropTestPodRow } from '../cargo/cargoWindow.js';
import { LootCollectors } from '../cargo/LootCollectors.js';
import { OreDraw } from './OreDraw.js';
import { StorageService } from '../cargo/StorageService.js';
import { fittedModuleIds, isOperationalStorage, structureUid } from '../cargo/storageHolds.js';
import { cloneHold, emptyHold, holdWeight, isHoldEmpty, mergeInto, packedCount } from '../../core/cargo/hold.js';
import { liveSectorHolder } from '../livingworld/RobotTerritory.js';
import { sectorHeldBy, territoryLockRefusal } from '../structures/territoryLockRules.js';
import { cargoCapacityForMaxHealth, GOOD_IDS, type Hold } from '../../shared-types/goods.js';
import { DEATH_POD_PUSH, deathHullLoot } from '../cargo/hullLoot.js';
import { ELITE_HEALTH_MUL } from '../../shared-types/elites.js';
import { ELITE_BOUNTY_CREDITS } from '../../shared-types/contracts.js';
import {
  qualityHullFactor,
  fittedCargoMul,
  fittedHullMul,
  fittedUid,
} from '../../shared-types/blueprints.js';

const EMPTY_FITTED: readonly string[] = Object.freeze([]);
/** Economy v2 — a repacked structure with no recorded quality (pre-repack rows). */
const REPACK_DEFAULT_QUALITY = 50;
import type { WorldNotice } from '../../shared-types/worldNotice.js';
// RosterFullError is handled inside RosterPersistence.ts
import { TransitOrchestrator } from '../transit/TransitOrchestrator.js';
import { SelectionStatsSubsystem } from './SelectionStatsSubsystem.js';
import { ownerGateStats, resolveSelectionStats, type SelectionStatsResolveHost } from './selectionStatsResolve.js';
import { sectorLiveCounts, sectorPlayerCount, type SectorLiveCountsHost } from './sectorLiveCounts.js';
import { auditCombatDestruction, onShipDestroyed, type CombatDestructionAuditHost, type ShipDestroyedHost } from './combatDestructionAudit.js';
import {
  // WEAPON_COOLDOWN_TICKS now used inside PlayerFireResolver + AiFireResolver
  // Player-hull HIT-tests derive a per-kind bounding-circle from
  // `getShipKind(ship.kind).radius + SHIELD_RADIUS_PAD` (2026-05-27) so they
  // match the visible ShieldAura; SHIP_COLLISION_RADIUS remains the shared
  // broad-phase radius for the scalar sweeps/rays that haven't gone per-kind
  // (mining beam here; missile sweep; lingering ray — campaign 5.3).
  SHIP_COLLISION_RADIUS,
} from '../../core/combat/Weapons.js';
// getWeapon/isWeaponId/HitscanWeaponDef/ProjectileWeaponDef now used inside PlayerFireResolver.ts
import { getWeapon, weaponLayerMul, type WeaponId, type MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';
import { tickShipEnergy, type ShipEnergyTickHost } from './shipEnergyTick.js';
import { shipBodyMass, shellViewHalfExtent } from '../../shared-types/shipScale/tuning.js';
import { createRoomShellHub, type ShellEventHub, type ShellViewer } from './ShellEventHub.js';
import { type ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import { tuningFor } from '../../shared-types/shipScale/lookup.js';
import { landingReach } from '../../shared-types/shipScale/landingReach.js';
import { shipSweepHit } from '../../core/combat/shipHitShape.js';
import type { MountRangeTarget } from '../../core/combat/mountReach.js';
import type { CapitalWreckSubsystem, WreckPiecePose } from './CapitalWreckSubsystem.js';
import { buildCapitalWrecks } from './capitalWreckRoomWiring.js';
import { rockViewOf } from './rockCut.js';
import { isWeaponTransparent, isWreckPiece } from '../net/SwarmEntityRegistry.js';
import type { LofBody } from './lofShipBody.js';
import { NpcLineOfFire } from './features/npcLineOfFire.js';
import { isTerrainLockKind } from '../../core/combat/lockState.js';
import { createSectorClock, type GameTimer } from '../time/gameTime.js';
import type { GameClock } from '../../core/clock/GameClock.js';
import { advanceSchedule, tickPeriodMs, type CatchUpResult } from '../../core/physics/catchUp.js';



const logger = pino({
  name: 'SectorRoom',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

const WORKER_TS_PATH = fileURLToPath(
  new URL('../../core/physics/worker.ts', import.meta.url),
);


/** `EQX_TIME_SCALE`: every sector's starting game speed (dev, demos, video).
 *  Ignored in production unless `EQX_ALLOW_DEV_OVERRIDES=1`. */
const ENV_TIME_SCALE: number | null = (() => {
  const raw = process.env['EQX_TIME_SCALE'];
  if (raw === undefined || raw === '') return null;
  if (process.env['NODE_ENV'] === 'production' && !ALLOW_DEV_OVERRIDES) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
})();


/** Fire control: lock messages per session per tick (all four kinds together).
 *  A pilot sends one on a lock-line change, two when switching groups mid-hold;
 *  a flood beyond this is silently dropped (src/server/CLAUDE.md thresholds). */
export const MAX_LOCK_MSGS_PER_TICK = 3;
/** A line of sight is blocked by any body but a loot pod or a road
 *  (`isWeaponTransparent`; pre-bound for `LineOfFireGate.firstOnLine`, #14). */
const notTransparent = (rec: LofBody): boolean => !isWeaponTransparent(rec);
// LAG_COMP_WINDOW now used inside PlayerFireResolver.ts

/** Click-to-inspect live-stats emit cadence (Item B5). ~5 Hz on its OWN
 *  timer — low-frequency + off the snapshot/physics hot path; only does work
 *  while a client has an entity selected. */
const SELECTION_STATS_INTERVAL_MS = 200;

/** Stage 5 — sector idle threshold. After this many ticks without any
 *  motion-above-epsilon or projectile-in-flight event, the room
 *  suppresses snapshot broadcasts entirely. 60 ticks = 1 second at
 *  60 Hz physics. */
const IDLE_THRESHOLD_TICKS = 60;


/** Stage 5 — motion epsilon. A ship is considered "moving" if its speed
 *  squared exceeds this. 0.05 u/s²  → ~0.22 u/s actual speed; below
 *  that the ship is essentially drifting to a stop and idle suppression
 *  is safe. Squared-comparison saves a sqrt per ship per tick. */
const IDLE_MOTION_EPSILON_SQ = 0.05;

/** Phase 1 AI safety net: drones that drift past this distance from
 *  origin (twice `SECTOR_PLAYABLE_HALF_EXTENT`) get teleported back
 *  in-bounds. Patrol behaviour normally keeps them inside the playable
 *  region — this is the "should never fire" guard for runaway pursuits
 *  and the long-session drift bug captured 2026-05-10 (drones at ~4 M
 *  units). Asteroids are unaffected. */
const DRONE_MAX_BOUNDS = SECTOR_PLAYABLE_HALF_EXTENT * 2;

// WorkerCmd union extracted to PhysicsWorkerProxy.ts

/** Fixed asteroid roster for the multiplayer diagnostic. Deterministic so the
 *  initial swarm population matches between sessions. Spawned via SwarmSpawner
 *  in onCreate(), then shipped via the binary swarm broadcast — no longer on
 *  Colyseus MapSchema. Mass is omitted — the spawner applies
 *  `ASTEROID_DEFAULT_MASS`. Radii vary so silhouettes read as different. */
const ASTEROIDS: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  200, y:    0, vx: 0,   vy: 0,    radius: 32 },
  { id: 'asteroid-1', x: -180, y:  120, vx: 0.3, vy: -0.2, radius: 22 },
  { id: 'asteroid-2', x:   80, y: -220, vx: 0,   vy: 0,    radius: 46 },
];

interface ProjectileRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  birthTick: number;
  damage: number;
  radius: number;
  maxTicks: number;
  weaponId: WeaponId;
}

/** Audit throttle window for the "your base is under attack" signal. */
const STRUCTURE_ATTACK_AUDIT_WINDOW_MS = 15_000;

/** Web Push throttle window for the "your base is under attack" notification —
 *  much longer than the audit window above, because a phone alert should be
 *  rare (one per base per 15 min) rather than once per sustained-fire burst. */
const STRUCTURE_ATTACK_PUSH_WINDOW_MS = 15 * 60_000;

export class SectorRoom extends Room<SectorState> {
  /** Owns the physics worker (lifecycle + message routing + typed
   *  postMessage facade). Extracted to PhysicsWorkerProxy.ts (commit 20
   *  of v3 refactor plan). */
  private physicsWorkerProxy!: PhysicsWorkerProxy;
  /** Which contacts go out as `collision_resolved` (lasting contacts are
   *  re-sent only every 150 ms; see CollisionBroadcastGate). */
  private readonly collisionGate = new CollisionBroadcastGate();
  /** /dev/memory: this room's physics worker heap. */
  workerHeapStats(gc = false): Promise<{ usedBytes: number; totalBytes: number; workerIndex: number } | null> {
    return this.physicsWorkerProxy ? this.physicsWorkerProxy.heapStats(gc) : Promise.resolve(null);
  }
  private sab!: SharedArrayBuffer;
  private sabU32!: Uint32Array;
  private sabF32!: Float32Array;

  // Slot management — maps playerId ↔ integer SAB slot index.
  private playerToSlot = new Map<string, number>();
  private slotToPlayer = new Map<number, string>();
  private freeSlots: number[] = [];
  private initialSpawnPositions = new Map<string, { x: number; y: number }>();

  /** Phase 6a — `playerId → shipInstanceId` indirection. The schema map
   *  (`state.ships`) and the snapshot wire keys both use shipInstanceId
   *  in 6a. Inbound `input` / `fire` / `engage_transit` handlers receive
   *  a playerId (via `sessionToPlayer`) and translate through this map
   *  before looking up the per-ship surface. Internal slot / pose maps
   *  stay playerId-keyed in 6a (Option A) — the one-active-ship-per-
   *  player invariant still holds, so the 1:1 mapping is preserved.
   *  Phase 6b will rekey the slot maps when lingering hulls need
   *  multiple entries per player. */
  private readonly playerToActiveShipInstance = new Map<string, string>();

  /** Phase 6b — lingering hulls' SAB slots. When a player fresh-spawns
   *  while their previous ship is still in the linger window, that
   *  previous ship's slot moves here so the snapshot loop and physics
   *  bookkeeping continue to iterate it. The fresh ship occupies
   *  `playerToSlot[playerId]` while the lingering ship sits in this
   *  parallel map. Cleaned up by `evictOwnerlessShip` (15-min TTL)
   *  and by the abandon→scrap flow if a lingering hull is abandoned. */
  private readonly lingeringSlots = new Map<string, number>();
  /** Phase 6b — pose mirror for lingering hulls. Mirrors `shipPoseCache`
   *  but keyed by shipInstanceId. Updated once per `update()` from
   *  the SAB so the snapshot can include them. */
  private readonly lingeringPoseCache = new Map<string, ShipPhysicsState>();
  /** RTS — the owned ships' orders (the owner-checked fleet facade). Every
   *  LINGERING hull (a key of `lingeringSlots`) is attached at each entry
   *  into that map and detached at each exit (`attachWingman` /
   *  `detachWingman`); the AI pilot brain registered there flies it with the
   *  pilot's INPUT command on the hull's slot. Liveness covered: LINGERING
   *  only (#17) — an ACTIVE hull is flown by its pilot, a DEAD one is gone. */
  private readonly fleet: FleetCommandSubsystem = new FleetCommandSubsystem({
    ownerOf: (id) => (this.lingeringSlots.has(id) ? (this.state.ships.get(id)?.playerId ?? null) : null),
    // A group move spreads the ships round the point from where they sit.
    readPose: (id, out) => this.wingmen.readLingeringPose(id, out),
    // The ship the caller flies, in the fleet's id space (its shipInstanceId,
    // so a squad member the owner pilots is recognised and leads; slice 4b).
    // The client names its active ship by playerId: `set_mode` maps an escort
    // of it here, the status stream maps it back. Null while spectating.
    pilotShipOf: (playerId) => {
      const ship = this.getActiveShip(playerId);
      return ship?.alive && this.playerToSlot.has(playerId) ? ship.shipInstanceId : null;
    },
    // RTS Part B: an owner's order reaches the AI pilot brain flying the hull.
    orderIssued: (id, order) => this.wingmen.orderIssued(id, order),
    // RTS Part B: the standing mode and the attitude reach the AI pilot brain.
    modeSet: (id) => this.wingmen.applyHullMode(id),
    stanceSet: (id) => this.wingmen.applyHullStance(id),
    // RTS Part B slice 9: the panel's activity comes from the AI pilot brain
    // (a Retreat on its way reads "retreating").
    activityOf: (id) => {
      const a = this.aiController.getBehaviour(id)?.getActivity?.();
      if (a === undefined) return null;
      // Navigation slice 9: on its way but no way fits, so it waits short of the goal.
      if ((a === 'moving' || a === 'patrolling') && this.nav.waiting(id)) return 'blocked';
      if (a === 'moving') {
        const w = this.fleet.ordersOf(id);
        if (w !== null && w.mode === 'retreat' && w.order === null) return 'retreating';
      }
      return a;
    },
  });
  /** The AI view's `resolveEntityInto`: a swarm ship, else an owned hull or a
   *  pilot's active ship (`entityPoseInto`). Bound once (#14). */
  private readonly _resolveAiEntityInto = (id: string, out: AiEntityPoseOut): boolean =>
    this.swarmEntityPoseInto(id, out) || this.wingmen.entityPoseInto(id, out);
  /** playerId → shipInstanceId of the hull the pilot parked by toggling
   *  Spectate (owner decision 2026-11-12: NPCs keep their locks and keep
   *  firing at it). Set by the `spectate` handler; cleared when the pilot
   *  reclaims a hull or leaves, and lazily once the hull is no longer parked.
   *  Read through `engageablePilotHull`. */
  private readonly spectateParkedHull = new Map<string, string>();
  /** RTS slice 10 — players whose join asked `startMode: 'command'` (galaxy
   *  rooms only). `drainPendingJoin` parks their hull via `fleetHooks.enterSpectate` at
   *  the arrival flip and sends `control_mode`; cleared there, on leave and on
   *  an in-sector reclaim. */
  private readonly pendingCommandStart = new Set<string>();

  // Wrecks RETIRED (Equinox P6.3 / C3) — an abandoned hull now shatters into
  // SCRAP (kind 3) and leaves the world. The former WreckLifecycleCoordinator
  // (ship→wreck conversion + slot⇄wreck index + wreck pose cache) is removed;
  // see `abandonShipToScrap` / `abandonLingeringHullToScrap`.

  // Phase 5c: swarm entities (asteroids, drones) live in the same SAB slot
  // pool as ships, but their wire-side metadata (kind, radius, last-broadcast
  // pose, sleeping flag) is owned by the swarm registry and shipped via the
  // binary swarm channel — never on MapSchema.
  private readonly swarmRegistry = new SwarmEntityRegistry();
  private readonly swarmEncoder = new BinarySwarmBroadcast();
  /** Phase 5d: per-client interest grid. 2048-unit cells, 3×3 query window. */
  private readonly interestGrid = new SpatialGrid();
  /** Reused per-tick scratch sets so query9 doesn't allocate per call.
   *  Owned by SnapshotBroadcaster (extracted); aliased here so the
   *  swarm-broadcast block earlier in update() keeps reading the same
   *  Map identity. */
  private get interestScratch(): Map<string, Set<number>> { return this.snapshotBroadcaster.interestScratch; }
  /** Per-client snapshot broadcaster. Extracted to `SnapshotBroadcaster.ts`. */
  private snapshotBroadcaster!: SnapshotBroadcaster;
  /**
   * Phase 1 of swift-otter — per-room WebRTC DataChannel transport. Owns
   * one PeerConnection per sessionId. Snapshot routing is wired through
   * `SnapshotBroadcaster.sendSnapshot` to call `webrtcChannelManager
   * .sendSnapshot(sessionId, snap, () => client.send('snapshot', snap))`.
   *
   * Null on engineering rooms (`sectorKey === null`) — those rooms are
   * test fixtures and don't need the additional native-binding init cost.
   */
  private webrtcChannelManager: WebRtcChannelManager | null = null;
  /** Per-client binary swarm packet encode + send. Extracted to `SwarmBroadcaster.ts`. */
  private swarmBroadcaster!: SwarmBroadcaster;
  /** GEP B4 — single orchestration entry point for per-tick entity sync (routes
   *  pose-core then json-slice in HC#4 order). Extracted to `EntitySyncRouter.ts`. */
  private entitySync!: EntitySyncRouter;
  /** Sector volatile-state persistence (swarm health snapshots). Extracted to `SectorPersistence.ts`. */
  private sectorPersistence!: SectorPersistence;
  /** Living World bot lifecycle (spawn/despawn/markHostile). Extracted to `LivingWorldBotHooks.ts`. */
  private livingWorldBotHooks!: LivingWorldBotHooks;
  /** Ownerless ship full-despawn (TTL expiry + lingering destruction). Extracted to `OwnerlessShipEvictor.ts`. */
  private ownerlessShipEvictor!: OwnerlessShipEvictor;
  /** Player onLeave handler (lingering / transit / despawn branches). Extracted to `LeaveHandler.ts`. */
  private leaveHandler!: LeaveHandler;
  /** Player onJoin handler (identity / spectator / rebind / fresh spawn). Extracted to `join/JoinHandler.ts`. */
  private joinHandler!: JoinHandler;
  private swarmSpawner!: SwarmSpawner;
  /** Scrap-on-death (Phase 2b-ii) — breaks a dying composite ship/drone into
   *  floating scrap pieces; owns the global FIFO cap. */
  private scrapSpawner!: ScrapSpawner;
  /** Living World P1a — loot pods, pickup, spill-on-death (see LootSubsystem). */
  private loot!: LootSubsystem;
  /** Loot window search time per (viewer, pod) (cargo-pods slice 12). */
  private readonly lootSearch = new LootSearch();
  /** Asteroid ore: the one draw path (Miner, harvesters, mining-laser hits paid on the pulse). */
  private readonly oreDraw = new OreDraw({ swarmRegistry: this.swarmRegistry, sectorKey: () => this.sectorKey, oreAtCentre: (r, out) => this.cutField?.oreAtCentre(r, out) ?? false, oreAtRest: (rx, ry, px, py, a, x, y, out) => this.cutField?.oreAtRest(rx, ry, px, py, a, x, y, out) !== undefined });
  /** Living World P1a-2 — base storage holds (deposit / refine / spill). */
  private storage!: StorageService;
  /** Economy v2 W3 — Research Lab jobs (research / copy / combine). */
  private researchLabs!: ResearchLabSubsystem;
  /** This sector's game clock (game speed is per sector, time scale stream).
   *  Every gameplay read and timer in the room uses it; at 1× it IS Date.now(). */
  readonly gameClock: GameClock = createSectorClock();
  /** Hit-side standing + economy notes (`features/hitStanding.ts`); `applyDamage` and the tractor call them. */
  private readonly hitStanding = new RoomHitStanding({ swarmRegistry: this.swarmRegistry, gameClock: this.gameClock, playerToSlot: () => this.playerToSlot, structureRegistry: () => this.structureRegistry });

  /** C2 — break-ins (channels + access grants); ticked with the structure tick. */
  private readonly breakIns = new BreakInSubsystem({
    now: () => this.gameClock.now(),
    canContinue: (actor, sid) => {
      const rec = this.structureRegistry.get(sid);
      if (rec !== undefined) return this.breakInHooks.pilotNear(actor, rec);
      // C3 — a ship: its LIVE pose (a target flying away ends it).
      const t = this.breakInHooks.shipTargetById(sid);
      return t !== null && this.breakInHooks.pilotNearPoint(actor, t.x, t.y, t.radius);
    },
    exists: (sid) => this.structureRegistry.get(sid) !== undefined || this.breakInHooks.shipTargetById(sid) !== null,
    onStart: (actor, sid) => this.breakInHooks.onBreakInStart(actor, sid),
    onEnd: (actor, sid, outcome, reason) => this.breakInHooks.onBreakInEnd(actor, sid, outcome, reason),
  });
  /** Force fields in this room's physics world (teleporter pad push today). */
  private readonly forceFields = new ForceFieldSubsystem({ post: (cmd) => this.postToWorker(cmd), tractors: {
    tick: () => this.serverTick, poseOf: (id, out) => this.rayHits.aiFireTargetShape(id, out), wireRef: (id) => this.swarmRegistry.get(id)?.entityId ?? id,
    lineBodies: (fx, fy, tx, ty, w, a, b, ids, cap) => this.lineOfFire.gate().lineBodies(fx, fy, tx, ty, w, a, b, ids, cap),
    // Line of sight: what a shot would hit first (loot pods pass, as for every beam).
    lineBlocker: (fx, fy, tx, ty, e, t) => this.lineOfFire.gate().firstOnLine(fx, fy, tx, ty, e, t, notTransparent),
    inCrackHold: (id) => this.capitalWrecks?.inCrackHold(id) === true, isTerrain: (id) => isTerrainLockKind(this.swarmRegistry.get(id)?.kind ?? -1), isWreckPiece: (id) => { const r = this.swarmRegistry.get(id); return r != null && isWreckPiece(r); },
    // Tractoring a ship is a hostile act, like a hit (weapon-mounts.md "Tractor beam"); terrain is neutral.
    onShipTractored: (e, t) => { this.hitStanding.noteStandingHit(t, e); if (this.playerToSlot.has(t)) this.refreshNpcAttackHostility(e, t); else if (this.swarmRegistry.get(t)?.kind === 1 && !this.isFriendlyFire(t, e)) this.aiController.markHostile(t, e, this.serverTick); },
  } });
  /** C2 bespoke trigger (testMode `breakInMs`). */
  private testBreakInMs: number | null = null;
  /** Bespoke test/recording trigger (testMode `lockTimeCapS`): the longest
   *  any NON-player lock may take, in seconds. Undefined = off. */
  private testLockTimeCapS: number | undefined = undefined;
  /** Bespoke test/recording trigger (testMode `chargeTicksCap`): the longest
   *  a capital-turret charge may take, in ticks. Undefined = off. */
  private testChargeTicksCap: number | undefined = undefined;
  /** Bespoke test/recording trigger (testMode `traverseTicksCap`): the longest
   *  a capital turret takes to train a full turn, in ticks. Undefined = off. */
  private testTraverseTicksCap: number | undefined = undefined;
  /** Capital destruction S2a (`capitalWrecks` room option / EQX_CAPITAL_WRECKS):
   *  a dying capital breaks into wreck bodies. On by default since 2026-11-14
   *  (`wreckSwitchOn`); null = both switches off.
   *  Sub-capital break-up slice 2: the same subsystem (the generalised wreck
   *  system) also breaks sub-capitals when `subcapWrecks` is on; it exists
   *  when EITHER flag is on, and `capitalWrecksOn` / `subcapWrecksOn` say
   *  which kinds break (`wreckKindAllowed`). Field name kept for the
   *  in-flight descriptor-transport slice. */
  private capitalWrecks: CapitalWreckSubsystem | null = null;
  private capitalWrecksOn = false;
  /** Wreck fields 0a2c: battle wrecks survive a restart (wreckLineageSaves.ts). */
  private wreckSaves: BattleWreckSaves | null = null;
  private subcapWrecksOn = false;
  /** Reused per-hit weapon layer multiplier (`applyDamage`, #14). */
  private readonly _layerMul = { shield: 1, hull: 1 };
  /** Reused `WRECK_IMPULSE` command (overkill knock-back, #14). */
  private readonly _wreckPose: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly _wreckImpulseCmd = { type: 'WRECK_IMPULSE' as const, entityId: '', jx: 0, jy: 0, px: 0, py: 0 };
  /** Reused `WRECK_RIGID_IMPULSE` command (a hit during the crack hold, #14). */
  private readonly _wreckRigidImpulseCmd: { type: 'WRECK_RIGID_IMPULSE'; entityIds: readonly string[]; jx: number; jy: number; px: number; py: number } =
    { type: 'WRECK_RIGID_IMPULSE', entityIds: [], jx: 0, jy: 0, px: 0, py: 0 };
  /** The hulls that collect loot: the pickup pass, a pod's hull contact, auto-deposit (and the hand-moved set, `manualCargo`). */
  private readonly lootCollectors = new LootCollectors({ sectorKey: () => this.sectorKey, pilots: this.playerToSlot, activeShip: (pid) => this.getActiveShip(pid), hasHold: (id) => this.hasHold(id), pilotPose: (pid) => this.shipPoseCache.get(pid), cargoCapacity: (k, id) => this.shipCargoCapacity(k, id), swarm: this.swarmRegistry, sab: () => this.sabF32,
    playerToSession: () => this.playerToSession, clients: () => this.clients });
  /** Structure-restyle rigs (`features/structureRigs.ts`): rig clips + sandbox scene hooks (`RigScene`), auto-deposit + crane bays (`CraneBays`). */
  private readonly rigs = buildStructureRigs({
    structures: () => this.structureRegistry, swarm: () => this.swarmRegistry, lootCollectors: this.lootCollectors, sab: () => this.sabF32,
    serverTick: () => this.serverTick, post: (cmd) => this.postToWorker(cmd), state: () => this.state as SectorState,
    registerAi: (id, slot, b) => this.aiController.register(id, slot, b), storage: () => this.storage, shipHold: (id) => this.loot.shipHold(id),
  });
  /** `RigScene.start`: start / clear a structure's rig clip (integration tests). */
  startStructureRigClip(...a: Parameters<StructureRigs['rigScene']['start']>): boolean { return this.rigs.rigScene.start(...a); }
  /** Placed-structure bookkeeping (structures plan, Phase 2). */
  private readonly structureRegistry = new StructureRegistry();
  /** Equinox Phase 9 (item 5) — sliding-window tally of recent destruction
   *  events for the galaxy-map "recent combat" indicator + drawer breakdown. Fed
   *  from the discrete combat-death hooks; read on the director's control tick. */
  private readonly recentCombatLog = new RecentCombatLog();
  /** Audit throttle — structureId → wall-clock ms of the last `structure_attacked`
   *  audit. Bounds the "your base is under attack" signal to one record per
   *  STRUCTURE_ATTACK_AUDIT_WINDOW_MS so a sustained beam doesn't firehose the
   *  log. Steady-state is allocation-free (Map.get + compare); only a fresh
   *  first-hit allocates (invariant #14). Entry cleared on the structure's
   *  removal in `evictSwarmEntity`. */
  private readonly structureAttackAuditAtMs = new Map<string, number>();
  /** P5 — fitted blueprints per ship instance (filled at hull seed / install;
   *  read by the snapshot without allocating). */
  private readonly fittedCache = new Map<string, readonly string[]>();
  /** Web Push throttle — structureId → wall-clock ms of the last "base under
   *  attack" PUSH notification (separate, far longer window than the audit map
   *  above). Same alloc-free steady state; cleared in `evictSwarmEntity`. */
  private readonly structureAttackPushAtMs = new Map<string, number>();
  private structurePlacement!: StructurePlacementSubsystem;
  /** Monotonic id source for player-placed structures (session-scoped). */
  private placedStructureCounter = 0;
  /** Power-grid pulse subsystem (structures plan, Phase 3). */
  private structureGrid!: StructureGridSubsystem;
  /** Shield-wall lifecycle (shield-fence plan) — forms/teardowns the blocking
   *  span between paired pylons + drives its collider. */
  private shieldWalls!: ShieldWallManager;
  /** Gates: open/close on approach (phase V gates). */
  private gates!: GateController;
  /** P2c — this sector's galaxy features (asteroid mix, nebula). */
  private sectorFeatures: readonly AsteroidFieldFeature[] = [];
  /** P2b — processors on the grid pulse (take inputs, run, put outputs). */
  private production!: ProductionSubsystem;
  /** v4 T1 — teleporter capacitors, pairing, rules and the jump cycle. */
  private teleporters!: TeleporterSubsystem;
  /** Showcase / tests (`teleportFullCharge`): keep capacitors full. */
  private testTeleportFullCharge = false;
  /** v4 M2 — garrison patrols (spawned with their military bases). */
  private readonly patrols = new PatrolSubsystem({
    // (Not before the room can spawn ships; the next tick retries.)
    spawn: (id, x, y) => this.livingWorldBotHooks !== undefined && this.spawnLivingWorldBot({ botId: id, kind: 'patrol-fighter', x, y }),
    poseOf: (id, out) => {
      const rec = this.swarmRegistry.get(id);
      if (!rec) return false;
      const b = slotBase(rec.slot);
      out.x = this.sabF32[b + SLOT_X_OFF]!;
      out.y = this.sabF32[b + SLOT_Y_OFF]!;
      return true;
    },
    moveTo: (id, x, y) => this.setBotMoveTarget(id, x, y),
    markHostile: (id, playerId) => {
      // Refresh quietly when it already is; tell clients the first time.
      if (this.aiController.isEntityHostileToPlayer(id, playerId)) this.aiController.markHostile(id, playerId, this.serverTick);
      else this.livingWorldBotHooks.markBotHostileToFaction(id, playerId, []);
    },
    forEachPilot: (cb) => {
      for (const [pid, slot] of this.playerToSlot) {
        const ship = this.getActiveShip(pid);
        if (!ship?.alive || !ship.isActive) continue;
        const b = slotBase(slot);
        cb(pid, this.sabF32[b + SLOT_X_OFF]!, this.sabF32[b + SLOT_Y_OFF]!);
      }
    },
    isHostileToOwner: (playerId, owner) => relationOf(playerId, owner, this.relationCtx) === 'hostile',
  });
  private readonly liveCountsHost: SectorLiveCountsHost = { playerToSlot: () => this.playerToSlot, getActiveShip: (pid) => this.getActiveShip(pid), swarmRegistry: this.swarmRegistry, structureRegistry: this.structureRegistry, patrols: this.patrols, npcHostileTo: (e, p) => this.npcHostileTo(e, p) };
  private readonly combatAuditHost: CombatDestructionAuditHost = { sectorKey: () => this.sectorKey, structureRegistry: this.structureRegistry, recentCombatLog: this.recentCombatLog, now: () => this.gameClock.now(), payEliteBounty: (k, n, c) => this.payEliteBounty(k, n, c), awardKillXp: (k, h) => this.shipProgression.awardKillXp(k, h), swarmRegistry: this.swarmRegistry };
  private readonly shipDestroyedHost: ShipDestroyedHost = { sectorKey: () => this.sectorKey, swarmRegistry: this.swarmRegistry, roomId: () => this.roomId, recentCombatLog: this.recentCombatLog, now: () => this.gameClock.now(), awardKillXp: (k, h) => this.shipProgression.awardKillXp(k, h), getActiveShip: (pid) => this.getActiveShip(pid), ships: () => this.state.ships, forgetSquadMember: (id) => this.fleet.forgetSquadMember(id), vaporisedActiveDeath: () => this.wreckSpawns.vaporisedActiveDeath, clearVaporisedActiveDeath: () => { this.wreckSpawns.vaporisedActiveDeath = null; }, playerToUser: () => this.playerToUser, bountyRoom: () => this, playerToSlot: () => this.playerToSlot, shipPoseCache: () => this.shipPoseCache, sabF32: () => this.sabF32, spillOrLoseShipHold: (...a) => this.spillOrLoseShipHold(...a), deleteRosterRow: (id) => this.deleteRosterRow(id), ownerlessShips: () => this.ownerlessShips, evictOwnerlessShip: (id) => this.evictOwnerlessShip(id), scrapSpawner: () => this.scrapSpawner };
  /** v4 A — the alien gates' guns: who is disabled, and for how long. */
  private readonly gateGuard = new AlienGateGuard({
    swarmSlotOf: (id) => this.swarmRegistry.get(id)?.slot,
    onDisabled: (actorId, gate) => {
      serverLogEvent('alien_gate_disabled', { sectorKey: this.sectorKey ?? '', actorId, gate: gate.id });
    },
  });
  /** v4 T3 — this room as the teleport broker sees it. */
  private teleportRoom!: TeleportRoom;
  /** Mine Layers' proximity mines (10 Hz with the structure tick). */
  private mineField!: MineFieldSubsystem;
  /** 1 Hz grid heartbeat timer (unref'd; off the physics tick). */
  private structureGridTimer: GameTimer | undefined;
  private cutField: CutFieldSubsystem | undefined; // macro terrain v2 (room option `cutField`)
  private wreckFieldSource: WreckFieldSource | undefined; // wreck fields 3b (room option `wreckField`)
  /** Navigation: the cut field's nav maps, AI routes and autopilot requests (`nav/RoomNav.ts`). */
  private readonly nav: RoomNav = new RoomNav({
    now: () => this.gameClock.now(), logger, sectorKey: () => this.sectorKey, stopped: () => this.simLoopStopped, structures: () => this.structureRegistry,
    resting: () => ({ swarm: this.swarmRegistry, sabF32: () => this.sabF32, sabU32: () => this.sabU32, bus: this.bus }),
    hullOf: (sid) => {
      const playerId = this.sessionToPlayer.get(sid), ship = playerId ? this.getActiveShip(playerId) : undefined;
      const pose = playerId ? this.shipPoseCache.get(playerId) : undefined;
      return playerId && ship?.alive && pose ? { playerId, x: pose.x, y: pose.y, angle: pose.angle, kind: ship.kind } : null;
    },
  });
  /** Faster turret aim/fire timer (Phase 5; unref'd). */
  private structureTurretTimer: GameTimer | undefined;
  /** Click-to-inspect live-stats channel (structures follow-up Item B5) +
   *  its ~5 Hz emit timer (unref'd; OFF the snapshot/physics hot path). */
  private selectionStats!: SelectionStatsSubsystem;
  private selectionStatsTimer: ReturnType<typeof setInterval> | undefined;
  /** Per-connection malformed-packet counter + sampled warn (campaign 1.3 —
   *  invariant #3's second half). Every onMessage parse failure routes
   *  through it; cleared per session in onLeave. */
  private readonly malformed = new MalformedMessageTracker(logger);
  /** Cached low-cadence structures snapshot slice (rebuilt on pulse / place;
   *  attached by reference to every recipient). Undefined ⇒ no structures. */
  /** A2 — the snapshot's slim cosmetic slice (turret / mining targets only);
   *  structure grid state itself lives in `state.structures`. */
  private structuresSlice: number[] | undefined = undefined;
  /** A2 — the `state.structures` sync + stale-row sweep, plus the grid pulse and
   *  turret tick cadences (`structuresSlice.ts`), built once. */
  private readonly structuresSliceSync = new StructuresSliceSync({
    state: () => this.state as SectorState, gameClock: this.gameClock, structureRegistry: this.structureRegistry,
    swarmRegistry: this.swarmRegistry, swarmHealth: () => this.swarmHealth, breakIns: this.breakIns,
    structureGrid: () => this.structureGrid, shieldWalls: () => this.shieldWalls, gates: () => this.gates,
    teleporters: () => this.teleporters, internStructureOwner: (o) => this.internStructureOwner(o),
    sectorHeldBy: () => sectorHeldBy(this.sectorKey ?? '', liveSectorHolder(this.sectorKey ?? '')),
    hostileActs: () => this.hostileActs, patrols: this.patrols, gateGuard: this.gateGuard, production: () => this.production,
    researchLabs: () => this.researchLabs, storage: () => this.storage, mineField: () => this.mineField,
    turretTargeting: () => this.turretTargeting, relationCtx: () => this.relationCtx,
    testTeleportFullCharge: () => this.testTeleportFullCharge, rebuildStructuresSlice: () => this.rebuildStructuresSlice(),
    broadcastGridPulse: (msg) => { this.broadcast('grid_pulse', msg); },
  });
  /** B2 (plan soft-leaping-truffle v3) — hostile acts against owners in this
   *  room (attacking an NPC base's structure), read by `relationOf`. */
  private readonly hostileActs = new HostileActLedger();
  /** The ONE relation context for this room; `nowMs` is refreshed in place on
   *  the turret tick (no allocation per query). */
  private readonly relationCtx = createRelationContext({ hostileActs: this.hostileActs, standing: ROOM_STANDING, policyOf: ROOM_POLICY });
  /** A2 — owner id → interned index in `state.structureOwners`. */
  private readonly structureOwnerIdx = new Map<string, number>();
  /** Interned index keys ("0", "1", …), cached so syncing never allocates. */
  private readonly structureOwnerKeys: string[] = [];
  private aiController!: AiController;
  /** Pilot layer: this tick's AI control keys, posted as ONE AI_INPUTS. */
  private readonly aiInputBatch = new AiInputBatch();
  /** Reused per-tick view for the AI controller — avoids per-tick allocation. */
  private aiPlayerScratch: AiPlayerView[] = [];
  /** Wave-system Phase 1 — per-room faction hostility/peace ledger, membership
   *  derived live from this room's structure registry. */
  private readonly factionLedger = new FactionLedger({
    structures: () => this.structureRegistry.all(),
  });
  /** The AI's per-tick structure targets (drone raids + owners' enemy bases, `aiStructureTargets.ts`). */
  private readonly aiStructureScratch: AiStructureView[] = [];
  private readonly aiStructures = new AiStructureTargets({ structures: () => this.structureRegistry, isHostileToDrones: (o) => this.factionLedger.isHostileToDrones(o), health: (id) => this.swarmHealth.get(id), fleetSize: () => this.fleet.size, fleetOwnerAt: (i) => this.fleet.ownerAt(i), relationCtx: this.relationCtx, now: () => this.gameClock.now(), npcHostileTo: (e, p) => this.npcHostileTo(e, p) });

  // ── Phase 4b.3 (multi-mount turret refactor, 2026-05-11) ────────────────
  /** Authoritative per-mount rotation angle (ship-relative, arc-local) for
   *  each alive player ship's active slot. Indexed by mount-order in the
   *  ship-kind catalogue. Computed each `update()` by the server-side
   *  WeaponMountController tick; consumed by `handleFire` for ray geometry
   *  and shipped per-recipient in `SnapshotMessage.states[id].mountAngles`
   *  so remote observers see the same turret rotation the firer's screen
   *  is drawing. */
  /**
   * Per-tick weapon-mount aim updater. Owns:
   *   - `playerMountAngles` / `droneMountAngles` (per-mount slewed angles)
   *   - `playerSlotTargets` / `droneSlotTargets` (sticky pickTarget hysteresis)
   *   - pooled MountTargetView scratch arrays
   *
   * Consumers (`handleFire`, `handleAiFire`, snapshot serialiser, eviction
   * paths) read/write through `mountTicker.playerMountAngles` etc. directly;
   * the underlying Map identity is the same as the pre-extraction fields.
   *
   * Extracted to `WeaponMountTicker.ts` (commit 21 of the v3 refactor plan).
   */
  private mountTicker!: WeaponMountTicker;
  /** Fire control (exp/fire-control): per-player, per-weapon-group target locks. */
  private locks!: LockSubsystem;
  /** RTS slice 5: the same lock machine for AI-flown (lingering) hulls, keyed
   *  by shipInstanceId. Separate so NPC pilot locks (`locks.enabledPlayers`)
   *  never iterate a wingman; hostility reads go through the hull's OWNER. */
  private wingmanLocks!: LockSubsystem;
  /** Fire control: NPCs lock fire-control pilots before firing at them. */
  private npcLocks!: NpcLockSubsystem;
  /** Alias accessors so the rest of SectorRoom keeps the old field-style
   *  reads (`this.playerMountAngles.get(id)`). Initialised in `onCreate`
   *  after the ticker is constructed. */
  private get playerMountAngles(): Map<string, Float32Array> { return this.mountTicker.playerMountAngles; }
  private get droneMountAngles(): Map<string, Float32Array> { return this.mountTicker.droneMountAngles; }
  private get playerSlotTargets(): Map<string, string | null> { return this.mountTicker.playerSlotTargets; }
  private get droneSlotTargets(): Map<string, string | null> { return this.mountTicker.droneSlotTargets; }

  private bus!: Bus;
  /** Phase 6 — TiDi simulation clock. Owned by the room; the worker reads its
   *  rate via SAB. Named `simClock` to avoid colliding with Colyseus `Room.clock`
   *  (a `ClockTimer` instance for `setInterval` / `setTimeout` helpers). */
  private simClock!: SimulationClock;
  /** Phase 6 — second-lever load shedder. Drops far drones in batches when
   *  the simClock is at its floor and the budget is still overrun. */
  private shedder!: LoadShedder;
  /** Last clockRate value pushed to the worker, used to gate CLOCK_RATE postMessages
   *  to once per RAMP_PER_TICK step (≈ once per ~6 server ticks at most). */
  private lastSentClockRate = 1.0;
  /** Physics-tick acceleration multiplier; see roomOpts.testTimeScale. */
  private testTimeScale = 1;
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  /** T4 — teleporter tolls (`features/teleportTolls.ts`). */
  private readonly tolls = new TeleportTolls({
    playerToSlot: () => this.playerToSlot, sabF32: () => this.sabF32, getActiveShip: (pid) => this.getActiveShip(pid),
    teleporters: () => this.teleporters, swarmRegistry: this.swarmRegistry, structureRegistry: this.structureRegistry,
    relationCtx: this.relationCtx, hostileActs: this.hostileActs, now: () => this.gameClock.now(), sectorKey: () => this.sectorKey,
    resolveOwnerName: (o) => this.rosterPersistence.resolveOwnerName(o), sendToPlayerHere: (pid, type, msg) => this.sendToPlayerHere(pid, type, msg),
    adjustStanding,
  });
  /** v4 T2/T3 — who rides a teleporter jump (`features/teleportMessages.ts`). */
  private readonly padRiders = new TeleportPadRiders({
    sectorKey: () => this.sectorKey, teleportRoom: () => this.teleportRoom, storage: () => this.storage,
    playerToSlot: () => this.playerToSlot, playerToSession: () => this.playerToSession,
    lingeringSlots: this.lingeringSlots, lingeringPoseCache: this.lingeringPoseCache, shipPoseCache: () => this.shipPoseCache,
    ships: () => this.state.ships, swarmRegistry: this.swarmRegistry, sabF32: () => this.sabF32, sabU32: () => this.sabU32,
    getActiveShip: (pid) => this.getActiveShip(pid), displaceActiveHullToLingering: (pid) => this.pilotSwap.displaceActiveHullToLingering(pid),
    transitOrchestrator: () => this.transitOrchestrator, handOffHullsTo: (to, moves, arrival) => this.hullHandOff.handOffHullsTo(to, moves, arrival),
    fleet: this.fleet, postToWorker: (cmd) => this.postToWorker(cmd), forceBroadcastUntil: (tick) => { this.forceBroadcastUntilTick = tick; },
  });
  /** C2/C3 — break-in start/end hooks (`features/breakInHooks.ts`). */
  private readonly breakInHooks = new BreakInHooks({
    testBreakInMs: () => this.testBreakInMs, playerToSession: this.playerToSession, clients: () => this.clients,
    structureRegistry: this.structureRegistry, swarmRegistry: this.swarmRegistry, sabF32: () => this.sabF32,
    hostileActs: this.hostileActs, relationCtx: this.relationCtx, aiController: () => this.aiController,
    now: () => this.gameClock.now(), serverTick: () => this.serverTick, sectorKey: () => this.sectorKey,
    adjustStanding, resolveOwnerName: (o) => this.rosterPersistence.resolveOwnerName(o),
    swarmGet: (id) => this.swarmRegistry.get(id), swarmByEntityId: (eid) => this.swarmRegistry.getByEntityId(eid),
    state: () => this.state as SectorState, getActiveShip: (pid) => this.getActiveShip(pid), playerToSlot: () => this.playerToSlot,
    shipPoseCache: () => this.shipPoseCache, lingeringSlots: this.lingeringSlots, lingeringPoseCache: this.lingeringPoseCache,
    shipCargoCapacity: (k, sid) => this.shipCargoCapacity(k, sid), broadcast: (type, msg) => { this.broadcast(type, msg); },
    rebuildStructuresSlice: () => this.rebuildStructuresSlice(),
  });
  private inputCountThisTick = new Map<string, number>();
  /** Fire control: lock messages (`lock_request` / `lock_track` /
   *  `lock_cancel` / `set_group_mode`) received this tick, per session. */
  private readonly lockMsgCountThisTick = new Map<string, number>();
  /** Count one lock message for `sessionId`; false = over this tick's cap (drop it). */
  private lockMsgAllowed(sessionId: string): boolean {
    const n = this.lockMsgCountThisTick.get(sessionId) ?? 0;
    if (n >= MAX_LOCK_MSGS_PER_TICK) return false;
    this.lockMsgCountThisTick.set(sessionId, n + 1);
    return true;
  }
  /** PlayerIds currently holding boost (energy-affordable), regardless of
   *  thrust. Surfaced on every snapshot so all clients can render an exhaust
   *  trail for that ship; also drives the per-tick boost energy drain.
   *  KEY: playerId for a pilot's ACTIVE ship (InputHandler). An AI-flown
   *  LINGERING hull never joins it: its brain pays its boost (RTS Part B),
   *  and its flame reaches the snapshot via the broadcaster's slot-FLAGS read
   *  (RTS Part A S2). */
  private readonly boostingPlayers = new Set<string>();
  /** Built once (no per-tick allocation, #14); `ships()` reads the live state. */
  private readonly energyTickHost: ShipEnergyTickHost = { ships: () => this.state.ships, boostingPlayers: this.boostingPlayers, getActiveShip: (pid) => this.getActiveShip(pid) };
  /** PlayerIds currently holding thrust (regardless of boost). Surfaced on
   *  every snapshot so observers can see a baseline thrust flame whenever
   *  a ship is accelerating. No longer a strict superset of `boostingPlayers`
   *  (boost without thrust is now valid). */
  private readonly thrustingPlayers = new Set<string>();
  /** Last client input tick the physics worker confirmed it applied, read from SAB.
   *  Owned by SnapshotBroadcaster (extracted); aliased here for the
   *  worker-read site + the room's onJoin/onLeave callers. */
  private get sabAppliedTicks(): Map<string, number> { return this.snapshotBroadcaster.sabAppliedTicks; }
  /** Per-tick mirror of player ship pose, sourced from SAB inside `update()`.
   *  Replaces the previous practice of mirroring pose into `ShipState` (a
   *  Colyseus schema) — that path was emitting a duplicate broadcast on top
   *  of the custom `SnapshotMessage`. The cache is the single in-memory
   *  source for snapshot construction, lag-comp recording, AI player view,
   *  collision math, and LoadShedder anchoring. Records are mutated in-place
   *  per tick to avoid GC churn. Entries are added on spawn/respawn and
   *  removed on player leave. */
  private readonly shipPoseCache = new Map<string, ShipPhysicsState>();
  /** The one obstacle gatherer (placement, line of sight, landing, spawns). */
  private readonly obstacles = new SectorObstacles({
    structures: this.structureRegistry, swarm: this.swarmRegistry, sab: () => this.sabF32,
    dormantRocks: (box, out, wrecks) => this.cutField?.dormantObstacles(box, out, wrecks),
    forEachHull: (sink) => {
      for (const [pid, pose] of this.shipPoseCache) sink.hull(pose.x, pose.y, this.getActiveShip(pid)?.kind, pid, undefined, this.pendingJoin.has(pid));
      for (const [shipId, pose] of this.lingeringPoseCache) { const h = this.state.ships.get(shipId); sink.hull(pose.x, pose.y, h?.kind || undefined, h?.playerId, shipId, false); }
    },
    forEachWall: (sink) => this.shieldWalls?.forEachBlockingWall(this.gameClock.now(), sink),
    clearanceOf: (kind) => (kind ? tuningFor(kind).spawnClearance : 60),
    extentOf: (kind) => (isShipKindId(kind) ? hullExtent(kind) : undefined),
  });
  private serverTick = 0;
  /** Pre-Stage-5: gated the 20 Hz broadcast — fired every 3 update() calls.
   *  Stage 5 replaces this with per-client {@link shouldBroadcastFar} /
   *  {@link shouldBroadcastClose} predicates. Field retained for the
   *  swarm broadcast (binary channel) which still uses the same 60 Hz
   *  cadence with no per-client phasing. */
  /** Owned by SnapshotBroadcaster (extracted). */
  private get broadcastCounter(): number { return this.snapshotBroadcaster.broadcastCounter; }
  /** Stage 5 — sector-wide idle tracker. Updated each update() with
   *  motion / projectile-in-flight signals; when isSectorIdle returns
   *  true, the snapshot broadcast block short-circuits entirely. */
  private readonly idleTracker: IdleTracker = createIdleTracker();
  /** Server tick until which snapshot broadcasts are forced ON,
   *  bypassing idle-suppression. Set on every player join/spawn — see
   *  `JOIN_BROADCAST_GRACE_TICKS`. */
  private forceBroadcastUntilTick = 0;

  /**
   * Plan: crispy-kazoo, Commit 2 — pending-join handshake registry.
   *
   * `onJoin` (and `RespawnHandler.handle`) sets the joining ship's
   * `isActive=false` and adds an entry here. The client bootstraps,
   * calls `client_ready`, the handler picks `arrivalTick` and
   * broadcasts `warp_in`. The per-tick drain in `update()` flips
   * `isActive=true` at `arrivalTick` and removes the entry. A
   * watchdog force-activates after `CLIENT_READY_TIMEOUT_TICKS`.
   *
   * Keyed by playerId for symmetry with `playerToSlot` / `lastFireClientTick`.
   */
  private pendingJoin = new Map<string, PendingJoinRecord>();
  /** Phase 4 warp travel: a ship on its warp run is out of the world
   *  (rooms/warpTravel.ts). Ticked after the pending-join drain. */
  /** Warp route check (rooms/warpRouteCheck.ts): no warp through the field or a structure. */
  private readonly warpRoute = new WarpRouteCheck({ sectorKey: () => this.sectorKey, solar: () => this.solar, fieldOpts: () => this.cutField?.navOpts ?? null, structures: this.structureRegistry, gateBoxes: (id) => this.swarmRegistry.get(id)?.boxes, pose: (pid) => this.shipPoseCache.get(pid), kindOf: (pid) => this.getActiveShip(pid)?.kind, accepted: (pid, x, y) => this.warpTravel.accepted(pid, x, y) });
  private readonly warpTravel = new WarpTravelTracker({
    phaseOf: (pid) => {
      const slot = this.playerToSlot.get(pid);
      if (slot === undefined) return 0;
      const f = this.sabU32[slotBase(slot) + SLOT_FLAGS_OFF] ?? 0;
      return f & FLAG_WARP_CRUISE ? 2 : f & FLAG_WARP_SPOOL ? 1 : 0;
    },
    clearPointNear: (pid, x, y) => this.warpLandingPoint(pid, x, y),
    retarget: (pid, x, y) => this.postToWorker({ type: 'WARP_RETARGET', entityId: pid, x, y }),
    setTravelling: (pid, on) => {
      const ship = this.getActiveShip(pid);
      if (ship) ship.travelling = on;
    },
    bumpPoseEpoch: (pid) => {
      const ship = this.getActiveShip(pid);
      if (ship) ship.poseEpoch++;
      this.forceBroadcastUntilTick = Math.max(this.forceBroadcastUntilTick, this.serverTick + 60);
    },
  });
  private testMode = false;
  /** Shells as events (shell-events.md): built in onCreate, in every room. */
  private shellHub: ShellEventHub | null = null;
  /** Reused viewer record the hub reads (alloc-free flush). */
  private readonly shellViewer: ShellViewer = { sessionId: '', playerId: '', x: 0, y: 0, half: 0 };
  /** Economy v2 W5b — a fresh spawn of a non-starter hull needs one you own
   *  (galaxy rooms). Off in test rooms unless `enforceHullGate` is set, so the
   *  many tests/showcases that join as other kinds are unaffected. */
  private enforceHullGate = false;
  /** Join flow — launch prices on (LAUNCH_COSTS_ON; test rooms may override). */
  private launchCostsOn = LAUNCH_COSTS_ON;
  private disableCollisionDamage = false;
  /** Phase 6 synthetic-load knob — extra ms of CPU burn per server update().
   *  Set via the `tickBurnMs` room option to push tick budget over the TiDi
   *  threshold deterministically (4000 real entities only consume ~1.5 ms,
   *  nowhere near the 14 ms `OVER_BUDGET_MS` threshold). */
  private tickBurnMs = 0;
  /** Phase 8 — stable galaxy-sector identity. Set via `roomOpts.sectorKey` for
   *  the 7 galaxy rooms; `null` for engineering rooms (test-sector, swarm-*).
   *  Persistence rows reference this, NOT `this.roomId`, so a sector's history
   *  survives Colyseus's autogenerated room id rotating across restarts. */
  private sectorKey: string | null = null;
  /** Solar-system sector rules for this room (room option, else the env switch). */
  private solar = SOLAR_SECTORS;
  /** Engineering test rooms can pin a default spawn anchor (e.g. origin in
   *  `feel-test`). `null` means use the existing ±200 u random scatter.
   *  URL-param `spawnX`/`spawnY` overrides this — set in `feel-test` so a
   *  player joining without params still lands at the known anchor. */
  private defaultSpawnX: number | null = null;
  private defaultSpawnY: number | null = null;
  /** Radar sandbox — `dronePoses` entries flagged `hostile`; marked hostile to
   *  every joining player (testMode only). */
  private readonly sandboxHostileDroneIds: string[] = [];
  /** Phase 8 — counter for the 60-second snapshot cadence (galaxy sectors only). */
  private ticksSinceSnapshot = 0;
  /** Phase 8 sub-phase B — set when an in-flight transit has committed (Limbo
   *  entry written with destination sectorKey, seat reserved, ship about to
   *  leave). The subsequent `onLeave` checks this and skips its own Limbo
   *  put so the destination-keyed entry survives intact. Cleared in onLeave. */
  readonly playerToTransitInFlight = new Set<string>();
  /** Phase 8 sub-phase B — per-room transit driver, set in onCreate. */
  private transitOrchestrator: TransitOrchestrator | null = null;
  /** Paradigm plan (quirky-rabbit) Phase 6 — fans process-wide GC pauses
   *  out to this room's clients so the on-device dev overlay can show
   *  the server's GC health alongside its own browser longtask stats.
   *  Stored as a bound function reference so onDispose can unsubscribe
   *  the exact callback. Initialised in onCreate, nulled in onDispose. */
  private gcPauseSubscriber: ((event: GcPauseEvent) => void) | null = null;
  /** Phase 8 sub-phase B (lingering ships) — 15-min auto-evict timers for
   *  hulls whose owners have disconnected from a galaxy room but whose ships
   *  remain in the live simulation. The ship keeps its SAB slot, ShipState
   *  entry, and physics body; the worker continues stepping it (drag decays
   *  vx/vy/angvel, so it drifts to a stop). Reconnect within the TTL re-binds
   *  the new session to the existing ship (live pose, not the snapshot). On
   *  TTL expiry `evictOwnerlessShip` runs full cleanup.
   *
   *  Phase 6b cleanup (2026-05-13) — keyed by **shipInstanceId**, not
   *  playerId. The previous playerId keying had a sharp edge: when a player
   *  fresh-spawned WHILE having a lingering hull, the timer (still pointed at
   *  playerId) would fire against the player's NEW active hull. The fix was
   *  to cancel the timer at the fresh-spawn-displace point — but that left
   *  displaced lingering hulls with no auto-evict, leaking them until room
   *  dispose. Keyed by the hull's stable shipInstanceId. WS-12 / R2.26: a
   *  lingering hull is recorded with a `null` value — a persist-forever
   *  presence marker with NO despawn timer (the hull never times out of the
   *  world; it leaves only via combat destruction, respawn-evict, or abandon →
   *  wreck). The map type allows a real Timeout for any other arm site. */
  private readonly ownerlessShips = new Map<string, ReturnType<typeof setTimeout> | null>();

  /** Test-only per-player disconnect-linger TTL override (ms), captured
   *  from the `lingerMs` JoinOption in testMode rooms. LeaveHandler reads
   *  it to shorten the linger window so the despawn→return-to-pool E2E
   *  runs in ~2 s instead of 15 min. Cleared on leave. */
  private readonly playerToLingerMs = new Map<string, number>();

  /** A fence stopped a shot: tell clients where, so they draw the impact
   *  (fence-hit fix). The point comes from the wall test just made. */
  private broadcastWallHit(kind: 'bolt' | 'missile'): void {
    this.broadcast('wall_hit', { type: 'wall_hit', x: this.shieldWalls.lastHitX, y: this.shieldWalls.lastHitY, kind });
  }

  /**
   * Test-only piercing surface (see src/server/CLAUDE.md "Testing
   * patterns"). Exposes private collaborators that integration tests
   * assert against without each declaring a local cast interface. NOT used
   * in production. Restored 2026-06-03 after the v3 subsystem extraction
   * dropped it (it was still referenced by 4 integration files, leaving
   * them RED). Each access reads through to the live field/method.
   */
  get _internals(): SectorRoomInternals {
    return {
      loot: this.loot,
      cutField: this.cutField?.streamer, cutFieldSub: this.cutField, wreckFieldSource: this.wreckFieldSource,
      serverTick: this.serverTick,
      roomUpdates: this.roomUpdateCount,
      droppedTicks: this.sabU32[WORKER_DROPPED_TICKS_IDX] ?? 0,
      sessionToPlayer: this.sessionToPlayer,
      ownerlessShips: this.ownerlessShips,
      lingeringSlots: this.lingeringSlots, forceFields: this.forceFields,
      restoreLingeringHulls: (rows) => this.snapshotRestore.restoreLingeringHulls(rows),
      fleet: this.fleet,
      aiNav: { get: () => this.aiController.nav, set: (nav) => { this.aiController.nav = nav; } },
      aiBrainOf: (id) => this.aiController.getBehaviour(id),
      lingeringPoseCache: this.lingeringPoseCache,
      sendFleetStatus: () => this.fleetHooks.fleetStatus.sendAll(),
      aiPlayerScratch: this.aiPlayerScratch,
      postToWorker: (cmd) => this.postToWorker(cmd),
      forceLock: (pid, key, groupId) => this.locks.forceLock(pid, key, groupId),
      locksOf: (id) => this.fireLocks.locksFor(id).wireFor(id),
      blockShotAtWall: (fx, fy, dx, dy, maxDist, damage) => this.blockShotAtWall(fx, fy, dx, dy, maxDist, damage),
      applyDamage: (targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId),
      swarmRegistry: this.swarmRegistry,
      swarmHealth: this.swarmHealth,
      structureRegistry: this.structureRegistry,
      pulseStructureGrid: () => this.structureGridTick(),
      getStructuresSlice: () => structureRowsForTests(this.state as SectorState, this.structuresSlice),
      upgradeStructure: (id) => this.structureGrid.upgradeStructure(id),
      reconnectStructure: (id) => this.structureGrid.reconnect(id),
      spawnTestAsteroid: (id, x, y, radius, resource) =>
        this.swarmSpawner.spawnAsteroid({ id, x, y, vx: 0, vy: 0, radius, mass: 1, ...(resource ? { resource } : {}) }),
      spawnTestDrone: (id, x, y, kind = 'fighter') => {
        const ok = this.swarmSpawner.spawnDrone({ id, x, y, kind });
        if (ok) {
          this.swarmHealth.set(id, getDroneMaxHealth(kind) ?? 40);
          this.swarmShield.set(id, 0); // hull exposed so turret damage lands
        }
        return ok;
      },
      tickStructureTurrets: () => this.structureTurretTick(),
      structureTurretLock: (id, i) => this.structureGrid.turretLockOf(id, i),
      spawnTestProjectile: (ownerId, x, y, vx, vy, weaponId = 'laser', damage = 10) =>
        this.projectiles.spawn(ownerId, x, y, vx, vy, damage, 4, 240, weaponId),
      aiFire: (shooterId, dirX, dirY, targetId) => this.handleAiFire(shooterId, dirX, dirY, this.serverTick, targetId),
      lineOfFireCounts: () => {
        const g = this.lineOfFire.built;
        return { checks: g?.checks ?? 0, candidates: g?.candidates ?? 0, narrow: g?.narrow ?? 0 };
      },
      setNpcLineOfFire: (on) => { this.lineOfFire.enabled = on; },
      setAiNeighbours: (on) => { this.aiGrids.neighboursOn = on; },
      setAiWreckAvoid: (on) => { this.aiGrids.wreckAvoidOn = on; },
      npcHostileTo: (id, otherId) => this.aiController.isEntityHostileToPlayer(id, otherId),
      mineField: this.mineField,
      rebuildStructuresSlice: () => this.rebuildStructuresSlice(),
      gateMask: (id) => this.gates.maskFor(id),
      playerPose: (pid) => {
        const slot = this.playerToSlot.get(pid);
        if (slot === undefined) return null;
        const b = slotBase(slot);
        return { x: this.sabF32[b + SLOT_X_OFF]!, y: this.sabF32[b + SLOT_Y_OFF]!, angle: this.sabF32[b + SLOT_ANGLE_OFF]!, poseEpoch:this.getActiveShip(pid)?.poseEpoch ?? 0 };
      },
      swarmPose: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (!rec) return null;
        const b = slotBase(rec.slot);
        return { x: this.sabF32[b + SLOT_X_OFF]!, y: this.sabF32[b + SLOT_Y_OFF]!, angle: this.sabF32[b + SLOT_ANGLE_OFF]! };
      },
      damageSwarmLayered: (rec, damage) => this.damageSwarmLayered(rec, damage),
      wreckState: (id) => this.wreckSpawns.wreckPose(id),
      wreckIntegrity: (id) => this.capitalWrecks?.pieceIntegrity(id), wreckSalvage: (id) => this.capitalWrecks?.pieceSalvageQty(id) ?? 0, wreckMass: (id) => { const v = { mass: 0, radius: 0, qty: 0, ore: undefined, holdWeight: 0, rockMass: 0 }; return this.capitalWrecks?.pieceStore(id, v) === true ? v.mass : undefined; },
      rockOf: (id) => rockViewOf(this.swarmRegistry, id, this.cutField?.navOpts ?? null),
      wreckParts: (id) => this.swarmRegistry.get(id)?.wreckParts ?? null,
      setWreckSeed: (seed) => { if (this.capitalWrecks) this.capitalWrecks.forcedSeed = seed; },
      swarmSleeping: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (!rec) return null;
        return ((this.sabU32[slotBase(rec.slot) + SLOT_FLAGS_OFF] ?? 0) & FLAG_SLEEPING) !== 0;
      },
      wreckCounts: () => ({ total: this.capitalWrecks?.liveCount() ?? 0, subcap: this.capitalWrecks?.liveSubcapCount() ?? 0 }),
      setSubcapWreckCap: (cap) => { if (this.capitalWrecks) this.capitalWrecks.subcapCapOverride = cap; },
      wreckDescriptors: () => this.capitalWrecks?.descriptors() ?? [],
      flushWreckSaves: (all) => this.wreckSaves?.flush(all),
      evictSwarm: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (rec) this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
      },
      rayHit: (fx, fy, dx, dy, maxDist, skipId) => {
        const h = this.rayHits.nonPlayerRayHit(fx, fy, dx, dy, maxDist, skipId);
        return h ? { id: h.id, dist: h.dist } : null;
      },
    };
  }

  // Auth — maps playerId → userId (null for anonymous)
  private readonly playerToUser = new Map<string, string | null>();

  // Combat
  private readonly snapshotRing = new SnapshotRing();
  private readonly lastFireClientTick = new Map<string, number>();
  /** Server-side projectile lifecycle (spawn + per-tick sweep + cleanup).
   *  Owns `liveProjectiles` + the monotonic id counter. Extracted to
   *  `ProjectilePipeline.ts` (commit 21 of v3 refactor plan). Aliased
   *  below as a getter so the `update()` callsites that read
   *  `this.liveProjectiles.size` keep the same Map identity. */
  private projectiles!: ProjectilePipeline;
  private get liveProjectiles(): Map<string, ProjectileRecord> { return this.projectiles.liveProjectiles; }
  /** Server-side missile simulation — pool, guidance, splash, impulse
   *  queue. See `MissileSimulation.ts`. Wired into the per-tick `update()`
   *  loop alongside `advanceProjectiles`. */
  private missileSim!: MissileSimulation;
  /** AI drone weapon-fire resolver (per-mount hitscan + laser_fired
   *  broadcast). Extracted to `AiFireResolver.ts` (commit 21 partial). */
  private aiFireResolver!: AiFireResolver;
  /** Player weapon-fire resolver — zod parse + cooldown + lag-comp
   *  rewind + 4-target sweep + aggregate hit_ack. Extracted to
   *  `PlayerFireResolver.ts`. */
  private playerFireResolver!: PlayerFireResolver;
  /** Damage routing — 3 branches (lingering / active / swarm).
   *  Extracted to `DamageRouter.ts`. */
  private damageRouter!: DamageRouter;
  /** Player respawn handler. Extracted to `RespawnHandler.ts`. */
  private respawnHandler!: RespawnHandler;
  /** Swarm entity eviction. Extracted to `SwarmEvictor.ts`. */
  private swarmEvictor!: SwarmEvictor;
  /** Roster persistence bridge. Extracted to `RosterPersistence.ts`. */
  private rosterPersistence!: RosterPersistence;
  /** Two-layer shield/hull damage + regen routing. Owns the swarm-side
   *  shield/hull state (swarmHealth, swarmShield, swarmShieldLastDmg) +
   *  the three layered-damage methods. Extracted to
   *  `ShieldHullRouter.ts`. Aliased below so the call sites in spawn
   *  / evict / persistence paths keep reading the same Map identity. */
  private shieldHullRouter!: ShieldHullRouter;
  private get swarmHealth(): Map<string, number> { return this.shieldHullRouter.swarmHealth; }
  private get swarmShield(): Map<string, number> { return this.shieldHullRouter.swarmShield; }
  private get swarmShieldLastDmg(): Map<string, number> { return this.shieldHullRouter.swarmShieldLastDmg; }

  // Tick-budget telemetry. Accumulated each `update()`; flushed every 60 ticks
  // (≈ 1 s wall-clock) to a single serverLogEvent so a diagnostic capture can
  // see the breakdown without saturating the 500-entry server-event buffer.
  // Per-tick accumulation + tick_hitch + tick_budget aggregation lives in
  // TickBudgetTelemetry.
  private readonly tickBudget = new TickBudgetTelemetry(new TickHealthWindow(processTickHealth(logger), () => this.sectorKey ?? this.roomId));

  private roomFeatures: { dispose: () => void } | null = null; // features/index.ts; disposed in onDispose
  override async onCreate(options: unknown): Promise<void> {
    this.setState(new SectorState());
    this.bus = new Bus();
    this.simClock = new SimulationClock(this.bus);
    this.shedder = new LoadShedder({
      registry: this.swarmRegistry,
      getPlayers: () => this.alivePlayerPositions(),
      getPosition: (rec) => {
        const b = slotBase(rec.slot);
        return { x: this.sabF32[b + SLOT_X_OFF]!, y: this.sabF32[b + SLOT_Y_OFF]! };
      },
      evict: (rec) => this.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false }),
      isInView: (rec) => this.droneInAnyView(rec),
      bus: this.bus,
      now: () => this.gameClock.now(),
      // At most once per 10 s per room (LoadShedder throttles).
      log: (line, msg) => logger.info({ sectorKey: this.sectorKey, roomId: this.roomId, shed: line.shed, skippedInView: line.skippedInView }, msg),
    });

    // Fill slot pool (push in reverse so slot 0 is popped first).
    for (let i = MAX_ENTITIES - 1; i >= 0; i--) this.freeSlots.push(i);

    // Shared memory buffer for zero-copy physics state transfer.
    this.sab    = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    this.sabU32 = new Uint32Array(this.sab);
    this.sabF32 = new Float32Array(this.sab);

    // Bundle + spawn the physics worker (`createPhysicsWorker`, contactFilter.ts).
    this.physicsWorkerProxy = createPhysicsWorker({
      sceneWork: this.sceneWork, collisionGate: this.collisionGate, cutField: () => this.cutField, bus: () => this.bus,
      broadcast: (type, msg) => { this.broadcast(type, msg); }, disableCollisionDamage: () => this.disableCollisionDamage,
      loot: () => this.loot, applyDamage: (target, shooter, dmg) => this.applyDamage(target, shooter, dmg),
      swarmRegistry: this.swarmRegistry, lingeringSlots: this.lingeringSlots, ships: () => this.state.ships,
      getActiveShip: (pid) => this.getActiveShip(pid),
      workerEntryPath: WORKER_TS_PATH, sab: this.sab, logger, playerToSlot: () => this.playerToSlot, sectorKey: () => this.sectorKey,
    });
    await this.physicsWorkerProxy.start();

    // gameServer.define()'s 3rd arg flows into onCreate(options). test-sector
    // passes { testMode: true, asteroidConfig: [] } to run with no obstacles.
    const roomOpts = (options ?? {}) as SectorRoomOptions;
    // Payload-DoS bound (S5): onCreate options are client-suppliable on room
    // create, so reject oversized seed arrays before they seed the sector.
    assertRoomSeedBounds(roomOpts as Record<string, unknown>);
    this.testMode = roomOpts.testMode ?? false;
    this.state.deck = this.structureRegistry.deck = this.testMode && roomOpts.deck === true; // base-platforms prototype flag (synced; client-suppliable, so testMode only; the registry feeds canConnect)
    this.enforceHullGate = !this.testMode || roomOpts.enforceHullGate === true;
    this.launchCostsOn = this.testMode ? (roomOpts.launchCosts ?? LAUNCH_COSTS_ON) : LAUNCH_COSTS_ON;
    this.disableCollisionDamage = this.testMode && (roomOpts.disableCollisionDamage ?? false);
    // Default 1.0 (no acceleration). Only honoured when testMode is true,
    // so a malicious / mis-targeted galaxy join can't ever speed it up.
    this.testTimeScale = this.testMode ? Math.max(1, roomOpts.testTimeScale ?? 1) : 1;
    this.sectorKey = roomOpts.sectorKey ?? null;
    this.tickBurnMs = Math.max(0, Math.min(50, roomOpts.tickBurnMs ?? 0));
    this.defaultSpawnX = roomOpts.defaultSpawnX ?? null;
    this.defaultSpawnY = roomOpts.defaultSpawnY ?? null;

    // Phase 8 sub-phase B — galaxy rooms are permanent. Without this,
    // Colyseus's default `autoDispose: true` tears the room down the moment
    // the last client leaves: physics worker terminated, swarm registry
    // wiped, lingering ships destroyed. The next join lazy-creates a fresh
    // room with seed-position drones — observable as "drones reset every
    // time I log in." Engineering rooms keep the default (auto-dispose)
    // because their state is ephemeral by design.
    if (this.sectorKey !== null) {
      this.autoDispose = false;
    }
    if (this.tickBurnMs > 0) {
      logger.info({ tickBurnMs: this.tickBurnMs }, 'Phase 6 synthetic tick burn enabled — TiDi will ramp to floor');
    }
    const useBulkSeed = typeof roomOpts.swarmCount === 'number' && roomOpts.swarmCount > 0;
    const useSingleAsteroid = roomOpts.singleAsteroid === true;
    const useDronePoses = this.testMode && Array.isArray(roomOpts.dronePoses) && roomOpts.dronePoses.length > 0;
    const useStructurePoses = this.testMode && Array.isArray(roomOpts.structurePoses) && roomOpts.structurePoses.length > 0;
    // P2c — the sector's features (galaxy sector, or a testMode override) decide
    // its asteroid mix and whether Gas Collectors work here.
    this.sectorFeatures =
      (this.testMode ? roomOpts.sectorFeatures : undefined)
      ?? (this.sectorKey !== null ? getSector(this.sectorKey)?.features : undefined)
      ?? [];
    const asteroidRoster = withAsteroidResources(
      (useBulkSeed || useSingleAsteroid || useDronePoses || useStructurePoses) ? [] : (roomOpts.asteroidConfig ?? ASTEROIDS),
      this.sectorFeatures,
    );

    // Phase 5c: seed swarm via the spawner, which owns slot allocation,
    // SAB priming, registry registration, and the worker spawn-obstacle
    // command. Asteroids and drones share the same physics body shape
    // (dynamic Rapier ball with damping=0); the AI behaviour determines
    // whether they drift passively or steer toward players.
    this.aiController = new AiController({
      postIntent: (slot, fx, fy, torque, setAngvel) => {
        // v4 A — a disabled NPC ship's engines are off.
        if (this.gateGuard.isSlotDisabled(slot, this.gameClock.now())) {
          fx = 0;
          fy = 0;
          torque = 0;
          setAngvel = undefined;
        }
        this.postToWorker({
          type: 'AI_INTENT',
          slot, fx, fy, torque,
          ...(setAngvel !== undefined ? { setAngvel } : {}),
        });
      },
      // Pilot layer: AI ships flown by control keys, batched into ONE
      // AI_INPUTS message a tick (no brain emits keys yet).
      postInput: (slot, bits, hullId) => {
        // RTS Part B: a player-owned hull's keys are its PILOT INPUT (the
        // flame shows; a reclaim's INPUT replaces them, `aiInputHeld` is
        // never set on the hull's slot).
        if (hullId !== undefined) { this.wingmen.postHullInput(hullId, bits); return; }
        // v4 A — a disabled NPC ship's engines are off (no keys held).
        this.aiInputBatch.push(slot, this.gateGuard.isSlotDisabled(slot, this.gameClock.now()) ? 0 : bits);
      },
      // RTS Part B: THE hull fire branch: the brain holds the hull's trigger
      // this tick (`tickWingmanFire` pulls it through the player pipeline).
      postHullFire: (hullId, targetId) => { this.wingmen.hullTrigger.set(hullId, targetId); },
      flushInputs: () => {
        if (this.aiInputBatch.count === 0) return;
        this.postToWorker(this.aiInputBatch.cmd);
        this.aiInputBatch.clear();
      },
    });

    // Per-tick weapon-mount aim updater. Owns playerMountAngles +
    // droneMountAngles + the sticky targets + the pooled scratches.
    // Extracted from SectorRoom (commit 21 of v3 refactor plan).
    this.locks = this.fireLocks.buildLockSubsystem();
    this.wingmanLocks = this.fireLocks.buildWingmanLockSubsystem();
    this.npcLocks = this.fireLocks.buildNpcLockSubsystem();

    this.mountTicker = new WeaponMountTicker({
      sabF32: this.sabF32,
      playerToSlot: this.playerToSlot,
      swarmRegistry: this.swarmRegistry,
      shipPoseCache: this.shipPoseCache,
      getActiveShip: (pid) => this.getActiveShip(pid),
      aiController: this.aiController,
      swarmHealth: () => this.swarmHealth,
      resolveSlotMounts: (kind, slotId) => this.resolveSlotMounts(kind, slotId),
      resolveInstanceMounts: (ship) => this.resolveInstanceMounts(ship),
      resolveInstanceFireMounts: (ship) => this.resolveInstanceFireMounts(ship),
      // Capital turret fire control (the resolver is built later; resolve lazily).
      currentTick: () => this.serverTick,
      fireDroneMount: (id, i, target, killAt, from) => this.aiFireResolver.fireMount(id, i, target, killAt, from),
      fireBlocked: (id, targetId) => this.npcLocks.fireBlocked(id, targetId),
      // Friendly fire slice 2: a turret holds while an escort is on its line.
      lineOfFireBlocked: (id, targetId, fx, fy, dx, dy, max, w, k) => this.lineOfFire.npcShipLineBlocked(id, targetId, fx, fy, dx, dy, max, w, k),
      // Capital turrets engage hostile structures too (the AI's per-tick set).
      hostileStructures: () => this.aiStructures.circles,
      lockTimeCapS: () => this.testLockTimeCapS,
      chargeTicksCap: () => this.testChargeTicksCap,
      traverseTicksCap: () => this.testTraverseTicksCap,
      onClearPlayer: (pid) => this.locks.clearLocks(pid),
      aimTargetFor: (pid, mountId, out) => this.fireLocks.lockAimTarget(pid, mountId, out),
      visitParkedPilotHulls: this.pilotSwap.visitParkedPilotHulls,
    });

    // Player weapon-fire resolver. Owns the zod parse, cooldown gate,
    // lag-comp rewind, 3-target sweep (other players, lingering hulls,
    // swarm), and the aggregate hit_ack. Per-mount laser_fired
    // broadcast per resolved fire.
    this.playerFireResolver = new PlayerFireResolver({
      sabF32: this.sabF32,
      serverTick: () => this.serverTick,
      sessionToPlayer: this.sessionToPlayer,
      getActiveShip: (pid) => this.getActiveShip(pid),
      lastFireClientTick: this.lastFireClientTick,
      snapshotRing: this.snapshotRing,
      shipPoseCache: this.shipPoseCache,
      playerToSlot: this.playerToSlot,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      lingeringShip: (sid) => this.state.ships.get(sid),
      swarmRegistry: this.swarmRegistry,
      playerMountAngles: this.mountTicker.playerMountAngles,
      resolveSlotMounts: (kind, slotId) => this.resolveSlotMounts(kind, slotId),
      resolveInstanceMounts: (ship) => this.resolveInstanceMounts(ship),
      resolveInstanceFireMounts: (ship, slotId) => this.resolveInstanceFireMounts(ship, slotId),
      mountWorldOrigin: (x, y, ang, m) => this.mountWorldOrigin(x, y, ang, m),
      playerHitscanDist,
      spawnServerProjectile: (ownerId, x, y, vx, vy, dmg, r, mt, wId) =>
        this.spawnServerProjectile(ownerId, x, y, vx, vy, dmg, r, mt, wId),
      spawnServerMissile: (ownerId, x, y, dx, dy, def) =>
        this.spawnServerMissile(ownerId, x, y, dx, dy, def),
      applyDamage: (targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId),
      blockBeamAtWall: (fx, fy, dx, dy, maxDist, damage) =>
        this.blockShotAtWall(fx, fy, dx, dy, maxDist, damage),
      broadcast: (type, msg) => this.broadcast(type, msg),
      serverLogEvent,
      logger,
      malformed: this.malformed,
      // RTS slice 5: a wingman's hull (shipInstanceId) gates on its own locks.
      fireAllowed: (pid, slotId) => this.fireLocks.locksFor(pid).hasLocked(pid, slotId),
      mountBearsOnLock: (pid, mountId, k, ox, oy, angle, weaponId, size) => this.fireLocks.mountBearsOnLock(pid, mountId, k, ox, oy, angle, weaponId, size),
      hullLineBlocked: (sid, fx, fy, dx, dy, weaponId, svx, svy, size) => this.lineOfFire.hullLineBlocked(sid, fx, fy, dx, dy, weaponId, svx, svy, size),
      fireTractor: (pid, m) => this.forceFields.renewTractor(pid, m, lockKeyBodyId(this.locks.aimKeyFor(pid, m.id), this.swarmRegistry)),
    });

    // AI drone weapon-fire resolver. Composes the per-mount hitscan +
    // laser_fired broadcast path that mirrors the player handleFire.
    this.aiFireResolver = new AiFireResolver({
      fireBlocked: (id, targetId) => this.npcLocks.fireBlocked(id, targetId),
      // One energy pool per AI-flown ship, shared by boost and guns, on its brain.
      trySpendEnergy: (id, cost) => {
        const b = this.aiController.getBehaviour(id);
        return b?.trySpendEnergy === undefined ? true : b.trySpendEnergy(cost);
      },
      // Friendly fire slice 2: a drone holds while an ally is in the way.
      lineOfFireBlocked: (id, targetId, fx, fy, dx, dy) => this.lineOfFire.droneLineBlocked(id, targetId, fx, fy, dx, dy),
      slotLineHeld: (id, targetId, k, w, fx, fy, tx, ty) => this.lineOfFire.lineHeld(id, k, w, fx, fy, tx, ty, id, targetId),
      lastFireClientTick: this.lastFireClientTick,
      swarmEntitySnapshot: (id) => this.swarmEntitySnapshot(id),
      targetShape: (id, out) => this.rayHits.aiFireTargetShape(id, out),
      fireTractor: (id, m, target) => this.forceFields.renewTractor(id, m, target),
      swarmRegistry: this.swarmRegistry,
      resolveSlotMounts: (kind, slotId) => this.resolveSlotMounts(kind, slotId),
      mountWorldOrigin: (x, y, ang, m) => this.mountWorldOrigin(x, y, ang, m),
      droneMountAngles: this.mountTicker.droneMountAngles,
      mountCharges: this.mountTicker.charges,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      playerHitscanDist,
      applyDamage: (targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId),
      // Friendly fire (owner decision 2026-11-10): the beam meets whatever is
      // in its path, its own side and neutral structures included.
      nonPlayerRayHit: (fx, fy, dx, dy, maxDist, skipId, hw) => this.rayHits.nonPlayerRayHit(fx, fy, dx, dy, maxDist, skipId, hw),
      blockBeamAtWall: (fx, fy, dx, dy, maxDist, damage) =>
        this.blockShotAtWall(fx, fy, dx, dy, maxDist, damage),
      broadcast: (type, msg) => this.broadcast(type, msg),
      spawnServerProjectile: (ownerId, x, y, vx, vy, dmg, r, mt, wId) =>
        this.spawnServerProjectile(ownerId, x, y, vx, vy, dmg, r, mt, wId),
      spawnServerMissile: (ownerId, x, y, dx, dy, def) =>
        this.spawnServerMissile(ownerId, x, y, dx, dy, def),
    });
    // A brain holds its line while its charge winds up (view.isCharging).
    this.aiController.isCharging = (id) => this.mountTicker.charges.mask(id) !== 0;
    // Owned ships engage what is hostile to their owner: the room's one
    // truce-aware NPC→player answer (RTS Part B slice 6).
    this.aiController.hostileToPlayer = (id, playerId) => this.aiStructures.hostileToPlayer(id, playerId);

    // Two-layer shield/hull damage + regen routing. Owns the swarm-side
    // shield state + the three layered-damage methods. Composes the pure
    // applyLayeredDamage + regenStep core with the room's bus / broadcast
    // / postToWorker / serverLogEvent seams.
    this.shieldHullRouter = new ShieldHullRouter({
      serverTick: () => this.serverTick,
      shipsMap: this.state.ships,
      swarmRegistry: this.swarmRegistry,
      bus: this.bus,
      serverLogEvent,
      postToWorker: (cmd) => this.postToWorker(cmd),
      broadcast: (type, msg) => this.broadcast(type, msg),
    });

    // Damage routing. Three branches (lingering / active /
    // swarm), each composing ShieldHullRouter + evictSwarmEntity.
    // Extracted to DamageRouter.ts.
    const droneScrapHost: DroneScrapHost = { sabF32: () => this.sabF32, scrapSpawner: () => this.scrapSpawner, hasCapitalWrecks: () => this.capitalWrecks !== null, wreckKindAllowed: (k) => this.wreckSpawns.wreckKindAllowed(k), spawnCapitalWreck: (...a) => this.wreckSpawns.spawnCapitalWreck(...a), structureWrecksOn: () => this.wreckSpawns.structureWrecksOn, structureOf: (id) => this.structureRegistry.get(id), spawnStructureWreck: (r) => this.wreckSpawns.spawnStructureWreck(r) };
    this.damageRouter = new DamageRouter({
      serverTick: () => this.serverTick,
      shipsMap: this.state.ships,
      shipPoseCache: this.shipPoseCache,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      freeSlots: this.freeSlots,
      shieldHullRouter: this.shieldHullRouter,
      getActiveShip: (pid) => this.getActiveShip(pid),
      sabF32: this.sabF32,
      swarmRegistry: this.swarmRegistry,
      evictSwarmEntity: (rec, opts) => this.evictSwarmEntity(rec as SwarmEntityRecord, opts),
      aiController: this.aiController,
      onDroneDamaged: (droneId, sourceId, atTick) =>
        this.escalateFactionOnDroneHit(droneId, sourceId, atTick),
      isFriendlyFire: (victimId, sourceId) => this.isFriendlyFire(victimId, sourceId),
      // RTS slice 5: a wingman's hit counts against its OWNER (hostility mirror).
      hostileActorOf: (sourceId) => this.wingmen.hostileActorOf(sourceId),
      // Scrap-on-death (Phase 2b-ii) — a composite-kind drone breaks into scrap
      // the instant before it's evicted on death. Deferred-eval closure (the
      // ScrapSpawner is constructed later in the ctor, before any death fires).
      spawnScrapFromDrone: (rec) => spawnScrapFromDrone(droneScrapHost, rec as SwarmEntityRecord),
      // P6.3 (Equinox Phase 6) — a composite LINGERING hull breaks into scrap
      // too. The lingering death policy reads the dying pose from
      // lingeringPoseCache (before its own teardown) and hands it here; we guard
      // polygon kinds + spawn, mirroring the active-hull SHIP_DESTROYED path.
      spawnScrapFromLingeringHull: (kind, pose, shipInstanceId) => {
        // S2a — a parked capital breaks into wreck bodies too (its
        // linger-<id> body is despawned by the death policy right after).
        const ship = this.state.ships.get(shipInstanceId);
        // The parked body (linger-<id>) goes before the pieces spawn.
        const vaporised = this.wreckSpawns.spawnCapitalWreck(shipInstanceId, kind, pose, ship?.maxHealth ?? getShipKind(kind).maxHealth,
          this.lingeringSlots.get(shipInstanceId), `linger-${shipInstanceId}`);
        this.spawnHullScrap(kind, pose, shipInstanceId);
        return vaporised;
      },
      spawnWreckFromActiveHull: (playerId) => this.wreckSpawns.spawnActiveHullWreck(playerId),
      // A1 — a lingering hull died in combat: the SHIP_DESTROYED handler can't
      // find it (already out of shipsMap), so the roster wipe + XP happen here.
      onLingeringHullDeath: (ship, pose, sourceId, vaporised) => this.ownerlessShipEvictor.onLingeringHullDeath(ship, pose, sourceId, vaporised === true),
      bus: this.bus,
      broadcastDamage: (msg) => this.broadcast('damage', msg),
      broadcastDestroy: (msg) => this.broadcast('destroy', msg),
      postToWorker: (cmd) => this.postToWorker(cmd),
      logger,
      serverLogEvent,
    });

    // Roster persistence bridge — wraps the four getPlayerShipStore()
    // calls (bind on spawn, mark-linger on disconnect, mark-stored on
    // eviction, delete on destruction). Engineering rooms (sectorKey
    // null) make all 4 no-ops.
    this.rosterPersistence = new RosterPersistence({
      sectorKey: () => this.sectorKey,
      roomId: () => this.roomId,
      logger,
      playerToUser: this.playerToUser,
    });

    // Swarm entity eviction. Single canonical teardown for combat-kill
    // + LoadShedder + livingWorld bot despawn. Extracted to SwarmEvictor.ts.
    this.swarmEvictor = new SwarmEvictor({
      bus: this.bus,
      logger,
      broadcastDestroy: (msg) => this.broadcast('destroy', msg),
      postToWorker: (cmd) => this.postToWorker(cmd),
      interestGrid: this.interestGrid,
      swarmRegistry: this.swarmRegistry,
      aiController: this.aiController,
      snapshotRing: this.snapshotRing,
      shieldHullRouter: this.shieldHullRouter,
      mountTicker: this.mountTicker,
      freeSlots: this.freeSlots, nav: this.nav,
    });

    // Player respawn handler. Composes worker proxy + SAB writer +
    // mount-ticker cleanup. Extracted to RespawnHandler.ts.
    this.respawnHandler = new RespawnHandler({
      // Join flow — a respawn re-launches the same hull, so it pays like a launch.
      chargeRespawn: (pid, kind) => !this.launchCharged() || chargeLaunchFor(this.launchCostsOn, pid, kind).kind !== 'refuse',
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      serverTick: () => this.serverTick,
      testMode: this.testMode,
      defaultSpawnX: this.defaultSpawnX,
      defaultSpawnY: this.defaultSpawnY,
      sessionToPlayer: this.sessionToPlayer,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      initialSpawnPositions: this.initialSpawnPositions,
      shipPoseCache: this.shipPoseCache,
      lastFireClientTick: this.lastFireClientTick,
      mountTicker: this.mountTicker,
      postToWorker: (cmd) => this.postToWorker(cmd),
      logger,
    });

    // Server-side projectile lifecycle. Spawn + per-tick sweep + cleanup.
    // Composes the 3-pass (player / swarm / lingering) collision
    // sweep with the injected playerProjectileSweep (shield-vs-hull
    // routing). Extracted to ProjectilePipeline.ts.
    this.projectiles = new ProjectilePipeline({
      sabF32: this.sabF32,
      serverTick: () => this.serverTick,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      playerSweep: (ship, fx, fy, sx, sy, r, cx, cy, ang) =>
        this.playerProjectileSweep(ship, fx, fy, sx, sy, r, cx, cy, ang),
      swarmRegistry: this.swarmRegistry,
      lingeringSlots: this.lingeringSlots,
      lingeringShip: (sid) => this.state.ships.get(sid),
      applyDamage: (targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY, dirX, dirY, weaponId),
      wallBlocksProjectile: (x, y, sx, sy, damage) => {
        if (!this.shieldWalls.blockProjectile(x, y, sx, sy, damage, this.gameClock.now())) return false;
        this.broadcastWallHit('bolt');
        return true;
      },
      // Coastal defences — a siege shell's blast (the damage lands separately).
      onBlast: (x, y, radius) => {
        const msg: ShellBlast = { type: 'shell_blast', x, y, radius };
        this.broadcast('shell_blast', msg);
      },
      // Shells as events (shell-events.md; the only way since slice 4): naval
      // shells travel as shell_salvo / shell_end, never in projectiles[].
      onShellSpawn: (id, rec) => this.shellHub?.onSpawn(id, rec),
      onShellEnd: (id, tick, x, y, r, continues) => this.shellHub?.onEnd(id, tick, x, y, r, continues),
      onShellExpire: (id) => this.shellHub?.onExpire(id),
    });
    this.shellHub = createRoomShellHub({
      serverTick: () => this.serverTick, snapshotBroadcaster: () => this.snapshotBroadcaster, clients: () => this.clients,
      sessionToPlayer: () => this.sessionToPlayer, shipPoseCache: this.shipPoseCache, getActiveShip: (pid) => this.getActiveShip(pid), shellViewer: this.shellViewer,
    });

    // Missile subsystem — guidance, splash damage, impulse queue. The
    // queue is drained each tick and posted to the physics worker as
    // MISSILE_IMPULSE commands; the worker has the live Rapier world.
    this.missileSim = new MissileSimulation({
      sabF32: this.sabF32,
      serverTick: () => this.serverTick,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      lingeringShip: (sid) => this.state.ships.get(sid),
      swarmRegistry: this.swarmRegistry,
      applyDamage: (targetId, shooterId, damage, hitX, hitY) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY),
      broadcastFired: (msg) => this.broadcast('missile_fired', msg),
      broadcastDetonated: (msg) => this.broadcast('missile_detonated', msg),
      // A fence stops missiles too (user ruling 2026-11-02).
      wallBlocksMissile: (x, y, sx, sy, damage) => {
        if (!this.shieldWalls.blockProjectile(x, y, sx, sy, damage, this.gameClock.now())) return false;
        this.broadcastWallHit('missile');
        return true;
      },
      bus: this.bus,
      serverLogEvent,
    });

    // Phase 1 swift-otter — instantiate the per-room WebRTC channel
    // manager BEFORE the SnapshotBroadcaster so the manager reference
    // can be captured into the sendSnapshot DI seam below.
    //
    // 2026-05-29 — gate removed (was: `if (this.sectorKey !== null)`).
    // Phase 4 E2E uses engineering rooms (`?room=feel-test-25`,
    // `sectorKey === null`) so gating on sectorKey meant the server
    // silently ignored every `webrtc_offer`, the client timed out, and
    // the measurement showed `dc_connected=false` across the board.
    // The PeerConnection isn't constructed until an offer actually
    // arrives (factory runs on `handleOffer`), so the cost on rooms
    // that never see a `?webrtc=1` client is zero — fine to create on
    // every room and let opt-in drive the actual binding load.
    this.webrtcChannelManager = new WebRtcChannelManager({
      peerConnectionFactory: nodeDataChannelPeerConnectionFactory({
        // STUN URL defaults to Google's freebie — works LAN + open
        // internet without TURN. TURN deployment for NAT-restricted
        // clients is scoped as a separate plan (hostile review #14).
        iceServers: ['stun:stun.l.google.com:19302'],
      }),
      sendAnswer: (sessionId, sdp) => {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) client.send('webrtc_answer', { type: 'webrtc_answer', sdp });
      },
      sendCandidate: (sessionId, candidate, mid) => {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) client.send('webrtc_ice', { type: 'webrtc_ice', candidate, mid });
      },
      serverLogEvent,
      logger,
    });

    // Per-client snapshot broadcaster. Owns broadcastCounter,
    // sabAppliedTicks, interestScratch. Composes the
    // per-client 20Hz phase-staggered loop with the global "all alive
    // ships" digest. Extracted to SnapshotBroadcaster.ts.
    this.snapshotBroadcaster = new SnapshotBroadcaster({
      shellEvents: () => this.shellHub,
      timeScale: () => (this.timeScale.timeScaleKey.s === 1 && this.timeScale.timeScaleKey.t === undefined ? undefined : this.timeScale.timeScaleKey),
      serverTick: () => this.serverTick,
      sabU32: this.sabU32,
      clients: this.clients,
      sessionToPlayer: this.sessionToPlayer,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      shipsMap: this.state.ships,
      liveProjectiles: this.projectiles.liveProjectiles,
      boostingPlayers: this.boostingPlayers,
      thrustingPlayers: this.thrustingPlayers,
      swarmRegistry: this.swarmRegistry,
      swarmHealth: this.swarmHealth,
      // Campaign 2.1 — the per-recipient `drones[].hostile` bit reads the
      // same hostility ledger the AI tick + liveCounts use (one truth).
      isDroneHostileTo: (droneId, playerId) => this.npcHostileTo(droneId, playerId),
      droneCharges: this.mountTicker.charges,
      // The AI pilot's boost key this tick, after the same disabled gate its
      // keys pass on the way to the worker (a disabled ship holds no keys).
      isDroneBoosting: (droneId) => {
        const slot = this.aiController.boostingSlot(droneId);
        return slot >= 0 && !this.gateGuard.isSlotDisabled(slot, this.gameClock.now());
      },
      // Living World P1a (#16) — own-ship cargo slice source.
      shipHoldOf: (shipInstanceId) => this.loot.shipHold(shipInstanceId),
      // P5 — the own ship's fitted blueprints (cache read only — alloc-free).
      fittedOf: (shipInstanceId) => this.fittedCache.get(shipInstanceId), ownShipKeyOf: (pid) => this.pilotSwap.ownShipKey(pid),
      // Economy v2 W1 — the own player's wallet balance on the snapshot.
      walletOf: (playerId) => getWallet().balance(playerId),
      // Join flow — free capital launches left (alloc-free Map read).
      freeLaunchesOf: (playerId) => getTradeSink()?.freeLaunches?.(playerId) ?? 0,
      disabledMsOf: (playerId) => this.gateGuard.remainingMs(playerId, this.gameClock.now()),
      droneFactionOf: (id) => (this.patrols.count > 0 ? this.patrols.factionOf(id) : undefined),
      droneWarpOf: (id) => (this.livingWorldBotHooks.npcWarps.size > 0 ? this.livingWorldBotHooks.botWarpPhase(id) : 0),
      warpingDrones: () => this.livingWorldBotHooks.npcWarps,
      depositProgressOf: (shipInstanceId) => this.rigs.craneBays.progressOf(shipInstanceId),
      lockGroupsOf: (pid) => this.locks.wireFor(pid),
      lockedByOf: (pid) => this.npcLocks.wireFor(pid),
      lockedByTotalOf: (pid) => this.npcLocks.totalFor(pid),
      lockedByLockedOf: (pid) => this.npcLocks.lockedTotalFor(pid),
      warpArrived: (playerId) => this.warpTravel.arrivedRecently(playerId, this.serverTick),
      // A reclaimed parked hull (`inWorld`) stays visible to others while it
      // joins (RTS Part A seamless take controls).
      isJoining: (playerId) => {
        const rec = this.pendingJoin.get(playerId);
        return rec !== undefined && rec.inWorld !== true;
      },
      // A pilot's own transit (keyed by playerId) or a ship spooling in a fleet
      // warp (keyed by shipInstanceId: parked hulls and a flown member).
      transitSpooling: (id) => {
        const t = this.transitOrchestrator;
        return t !== null && t !== undefined && (t.isInFlight(id) || t.fleetGroupOf(id) !== null);
      },
      playerMountAngles: this.mountTicker.playerMountAngles,
      droneMountAngles: this.mountTicker.droneMountAngles,
      missileSim: this.missileSim,
      logger,
      serverLogEvent,
      work: this.sceneWork,
      // Phase 1 swift-otter DI seam — when the WebRtc manager is live
      // (galaxy rooms), route via DC with WS fallback; on engineering
      // rooms the seam stays undefined and the legacy WS-only path runs.
      sendSnapshot: (client, snap) => {
        // The manager owns the routing decision (sendable + degraded
        // + buffered + try/catch). `onFallback` is the WS path; the
        // manager invokes it synchronously when DC is unavailable.
        // Non-null assertion is safe here — the manager is always
        // constructed above (the previous `sectorKey === null` gate
        // was removed 2026-05-29).
        this.webrtcChannelManager!.sendSnapshot(
          client.sessionId,
          snap,
          () => { client.send('snapshot', snap); },
        );
      },
      // Structures plan, Phase 3 — the cached slice (rebuilt at the 1 Hz grid
      // pulse / on placement), attached by reference to every recipient.
      getStructuresSlice: () => this.forceFields.beamLinks(this.structuresSlice),
      getStructureMountAngles: () => this.structuresSliceSync.structureMountAnglesSlice,
      // Capital destruction S2b: the wreck descriptors (null when off).
      getWrecks: () => this.capitalWrecks?.descriptors() ?? null,
      wrecksVersion: () => this.capitalWrecks?.version ?? 0,
    });

    // Player onJoin handler. Identity / spectator / rebind / fresh-spawn
    // paths. Extracted to join/JoinHandler.ts. Room scalars are live getters
    // (setters where the join writes them) so the handler always sees the
    // room's current value.
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters below read the room's private fields live
    const room = this;
    this.joinHandler = new JoinHandler({
      get sectorKey() { return room.sectorKey; },
      get roomId() { return room.roomId; },
      get testMode() { return room.testMode; },
      get enforceHullGate() { return room.enforceHullGate; },
      get launchCostsOn() { return room.launchCostsOn; },
      get defaultSpawnX() { return room.defaultSpawnX; },
      get defaultSpawnY() { return room.defaultSpawnY; },
      get testWalletSeed() { return room.testWalletSeed; },
      get serverTick() { return room.serverTick; },
      get forceBroadcastUntilTick() { return room.forceBroadcastUntilTick; },
      set forceBroadcastUntilTick(v: number) { room.forceBroadcastUntilTick = v; },
      get testChargeTicksCap() { return room.testChargeTicksCap; },
      set testChargeTicksCap(v: number | undefined) { room.testChargeTicksCap = v; },
      get testTraverseTicksCap() { return room.testTraverseTicksCap; },
      set testTraverseTicksCap(v: number | undefined) { room.testTraverseTicksCap = v; },
      get sabF32() { return room.sabF32; },
      get sabU32() { return room.sabU32; },
      get shipsMap() { return room.state.ships; },
      get sessionToPlayer() { return room.sessionToPlayer; },
      get playerToSession() { return room.playerToSession; },
      get sessionRegisteredPlayer() { return room.sessionRegisteredPlayer; },
      get playerToUser() { return room.playerToUser; },
      get playerToSlot() { return room.playerToSlot; },
      get slotToPlayer() { return room.slotToPlayer; },
      get freeSlots() { return room.freeSlots; },
      get playerToActiveShipInstance() { return room.playerToActiveShipInstance; },
      get lingeringSlots() { return room.lingeringSlots; },
      get ownerlessShips() { return room.ownerlessShips; },
      get initialSpawnPositions() { return room.initialSpawnPositions; },
      get shipPoseCache() { return room.shipPoseCache; },
      get lastFireClientTick() { return room.lastFireClientTick; },
      get playerToLingerMs() { return room.playerToLingerMs; },
      get pendingJoin() { return room.pendingJoin; },
      get pendingCommandStart() { return room.pendingCommandStart; },
      get sandboxHostileDroneIds() { return room.sandboxHostileDroneIds; },
      get obstacles() { return room.obstacles; },
      get cutField() { return room.cutField; },
      get bus() { return room.bus; },
      get swarmRegistry() { return room.swarmRegistry; },
      get structureRegistry() { return room.structureRegistry; },
      get structureGrid() { return room.structureGrid; },
      get snapshotRing() { return room.snapshotRing; },
      get locks() { return room.locks; },
      get aiController() { return room.aiController; },
      logger,
      postToWorker: (cmd) => this.postToWorker(cmd),
      broadcast: (type, message) => this.broadcast(type, message),
      wreckWelcomeFields: () => this.wreckWelcomeFields(),
      shellWelcomeFields: (client, playerId) => this.shellWelcomeFields(client, playerId),
      shipHullMax: (kindMax, alloc, id) => this.shipHullMax(kindMax, alloc, id),
      setTimeScale: (scale) => this.setTimeScale(scale),
      setLockTimeCap: (capS) => this.setLockTimeCap(capS),
      sendNotice: (client, text) => this.sendNotice(client, text),
      resolveActiveShipKey: (pid) => this.resolveActiveShipKey(pid),
      getActiveShip: (pid) => this.getActiveShip(pid),
      markAllDronesHostileTo: (pid) => this.markAllDronesHostileTo(pid),
      landingPoint: (pid, x, y, kind) => this.landingPoint(pid, x, y, kind),
      evictSessionForTakeover: (sessionId) => this.evictSessionForTakeover(sessionId),
      evictOwnerlessShip: (id) => this.evictOwnerlessShip(id),
      attachWingman: (id) => this.wingmen.attachWingman(id),
      applyStatMulToWorker: (bodyKey, alloc) => this.shipProgression.applyStatMulToWorker(bodyKey, alloc),
      startSceneClock: (tick) => this.sceneRunner?.start(tick),
      markWarpArrived: (pid, tick) => this.warpTravel.markArrived(pid, tick),
      startInCommand: (pid, sessionId) => this.fleetHooks.startInCommand(pid, sessionId),
      bindRosterEntry: (playerId, userId, kind, pose, preferredShipId = '', forceFreshCreate = false) =>
        this.rosterPersistence.bind(playerId, userId, kind, pose, preferredShipId, forceFreshCreate),
    });

    // Player onLeave handler. Three branches: shouldLinger / transit-
    // in-flight / despawn. Extracted to LeaveHandler.ts.
    this.leaveHandler = new LeaveHandler({
      sabF32: this.sabF32,
      sectorKey: () => this.sectorKey,
      shipsMap: this.state.ships,
      sessionToPlayer: this.sessionToPlayer,
      playerToSession: this.playerToSession,
      playerToSlot: this.playerToSlot,
      slotToPlayer: this.slotToPlayer,
      freeSlots: this.freeSlots,
      lastFireClientTick: this.lastFireClientTick,
      initialSpawnPositions: this.initialSpawnPositions,
      shipPoseCache: this.shipPoseCache,
      playerToUser: this.playerToUser,
      playerToActiveShipInstance: this.playerToActiveShipInstance,
      playerToTransitInFlight: this.playerToTransitInFlight,
      ownerlessShips: this.ownerlessShips,
      lingerMs: (pid) => this.playerToLingerMs.get(pid),
      clearLingerMs: (pid) => { this.playerToLingerMs.delete(pid); },
      forgetLocks: (pid) => { this.locks.forget(pid); this.npcLocks.forget(pid); this.spectateParkedHull.delete(pid); },
      boostingPlayers: this.boostingPlayers,
      thrustingPlayers: this.thrustingPlayers,
      snapshotBroadcaster: this.snapshotBroadcaster,
      snapshotRing: this.snapshotRing,
      mountTicker: this.mountTicker,
      rosterPersistence: this.rosterPersistence,
      getActiveShip: (pid) => this.getActiveShip(pid),
      resolveActiveShipKey: (pid) => this.resolveActiveShipKey(pid),
      aiController: this.aiController,
      cancelTransit: (pid, reason) => { this.transitOrchestrator?.cancelTransit(pid, reason); },
      evictOwnerlessShip: (id) => this.evictOwnerlessShip(id),
      postToWorker: (cmd) => this.postToWorker(cmd),
      bus: this.bus,
      logger,
      serverLogEvent,
    });

    // Ownerless-ship eviction (TTL expiry + lingering destruction
    // tail). Composes the wreck-keyed Limbo delete + roster mark-stored.
    this.ownerlessShipEvictor = new OwnerlessShipEvictor({
      sabF32: this.sabF32,
      sectorKey: () => this.sectorKey,
      shipsMap: this.state.ships,
      ownerlessShips: this.ownerlessShips,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      playerToSlot: this.playerToSlot,
      slotToPlayer: this.slotToPlayer,
      freeSlots: this.freeSlots,
      lastFireClientTick: this.lastFireClientTick,
      initialSpawnPositions: this.initialSpawnPositions,
      shipPoseCache: this.shipPoseCache,
      playerToUser: this.playerToUser,
      playerToActiveShipInstance: this.playerToActiveShipInstance,
      snapshotRing: this.snapshotRing,
      mountTicker: this.mountTicker,
      rosterPersistence: this.rosterPersistence,
      postToWorker: (cmd) => this.postToWorker(cmd),
      bus: this.bus,
      logger,
      serverLogEvent,
      getActiveShip: (pid) => this.getActiveShip(pid), fleet: this.fleet, wingmen: () => this.wingmen,
      clients: () => this.clients, playerToSession: () => this.playerToSession, sessionToPlayer: () => this.sessionToPlayer,
      spawnCapitalWreck: (id, kind, pose, maxHull, slot, bodyId) => this.wreckSpawns.spawnCapitalWreck(id, kind, pose, maxHull, slot, bodyId),
      spawnHullScrap: (kind, pose, sid) => this.spawnHullScrap(kind, pose, sid),
      spillOrLoseShipHold: (sid, pid, pose, cause, death) => this.spillOrLoseShipHold(sid, pid, pose, cause, death),
      awardKillXp: (killerId, maxHealth) => this.shipProgression.awardKillXp(killerId, maxHealth),
      deleteRosterRow: (sid) => this.deleteRosterRow(sid),
    });

    // Sector volatile-state persistence. Galaxy-only — engineering
    // rooms have no persistent identity. Snapshots swarm health every
    // 60 s + onDispose; hydrates on onCreate.
    this.sectorPersistence = new SectorPersistence({
      // A test room can keep its sectorKey (roster, cargo) yet not persist:
      // every room instance of one key shares one saved snapshot, so a test's
      // structures came back in the next run's room (persistSector: false).
      sectorKey: () => (this.persistSector ? this.sectorKey : null),
      sabF32: this.sabF32,
      swarmRegistry: this.swarmRegistry,
      swarmHealth: this.shieldHullRouter.swarmHealth,
      structures: () => this.structureRegistry.all(), gateDoorOf: (id) => this.gates.savedDoor(id),
      restoreStructures: (rows) => this.snapshotRestore.restoreStructures(rows),
      fallenBases: () => this.structureRegistry.fallenBases, restoreFallenBases: (o) => this.structureRegistry.restoreFallenBases(o), // 4E S6
      scrapEntities: () => this.snapshotRestore.scrapEntities(),
      restoreScrap: (rows) => this.snapshotRestore.restoreScrap(rows),
      lingeringHulls: () => this.snapshotRestore.lingeringHulls(),
      restoreLingeringHulls: (rows) => this.snapshotRestore.restoreLingeringHulls(rows),
      // RTS slice 9 — wingman squads (hydrate runs this after the hulls).
      fleetSquads: () => this.fleet.exportSquads(),
      restoreFleetSquads: (rows) => { this.fleet.restoreSquads(rows); },
      saveRow: (key, payload) => saveSnapshot(key, payload),
      loadRow: (key) =>
        db
          .prepare(
            'SELECT snapshot, created_at FROM game_snapshots WHERE sector_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(key) as { snapshot: string; created_at: number } | undefined,
      logger,
    });

    // Per-client binary swarm packet broadcaster. Encodes the swarm
    // packet per-client with the 9-cell interest window (Phase 5d).
    // The interestScratch Set populated here is REUSED by the snapshot
    // broadcaster's drone slice (same per-(client,tick) cell window).
    this.swarmBroadcaster = new SwarmBroadcaster({
      work: this.sceneWork,
      serverTick: () => this.serverTick,
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      clients: this.clients,
      sessionToPlayer: this.sessionToPlayer,
      playerToSlot: this.playerToSlot,
      interestGrid: this.interestGrid,
      swarmRegistry: this.swarmRegistry,
      swarmEncoder: this.swarmEncoder,
      snapshotBroadcaster: this.snapshotBroadcaster,
      logger,
      viewerRadius: (playerId) => getShipKind(this.getActiveShip(playerId)?.kind).radius,
      interestPointOf: (playerId) => this.warpTravel.interestPoint(playerId),
    });

    // GEP B4 — the single orchestration entry point for per-tick entity sync.
    // Routes pose-core binary FIRST (builds interestScratch), then the json-slice
    // snapshot slices (reuse it — HC#4), evaluating sector-idle between the two
    // sends exactly where update() used to (backpressure order preserved). The
    // idle closure is built ONCE here (no per-tick closure alloc, #14); its inner
    // options object is built per tick exactly as before. Construction also runs a
    // boot-time SyncProfile.transport governance check (makes `transport`
    // load-bearing). The proven broadcasters keep the byte-level encoding.
    this.entitySync = new EntitySyncRouter({
      swarmBroadcaster: this.swarmBroadcaster,
      snapshotBroadcaster: this.snapshotBroadcaster,
      evaluateSectorIdle: () =>
        evaluateSectorIdle({
          idleTracker: this.idleTracker,
          serverTick: this.serverTick,
          shipPoseCache: this.shipPoseCache,
          liveProjectiles: this.liveProjectiles,
          connectedClientCount: this.clients.length,
          swarmEntityCount: this.swarmRegistry.size(),
          forceBroadcastUntilTick: this.forceBroadcastUntilTick,
          idleMotionEpsilonSq: IDLE_MOTION_EPSILON_SQ,
          idleThresholdTicks: IDLE_THRESHOLD_TICKS,
        }),
    });

    // Deterministic per-room ship-kind sequence. When `roomOpts.droneKinds`
    // is set, the spawner advances through this array round-robin instead
    // of pickRandomShipKind, so the `mount-test` engineering room can
    // guarantee a known mix of interceptor + gunship drones for Phase 4c
    // smoke testing.
    const kindSeq = roomOpts.droneKinds;
    let kindCursor = 0;
    const pickDroneKind = kindSeq && kindSeq.length > 0
      ? (): ShipKindId => {
          const k = kindSeq[kindCursor % kindSeq.length]!;
          kindCursor++;
          return k;
        }
      : undefined;
    this.swarmSpawner = new SwarmSpawner(this.swarmRegistry, {
      takeSlot: () => this.freeSlots.pop(),
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass, vertices, linearDamping, staticBody, collisionGroups, angle, parts, shieldKindId, spin, shipKindId, sleeping) =>
        this.postToWorker({ type: 'SPAWN_OBSTACLE', slot, obstacleId: id, x, y, vx, vy, radius, mass, vertices, linearDamping, staticBody, collisionGroups, angle, parts, ...(shieldKindId ? { shieldKindId } : {}), ...(spin ? { angvel: spin.angvel, angularDamping: spin.angularDamping } : {}), ...(spin?.settleSpeed ? { settleSpeed: spin.settleSpeed, settleSpin: spin.settleSpin ?? 0 } : {}), ...(shipKindId !== undefined ? { shipKindId } : {}), ...(sleeping === true ? { sleeping } : {}) }),
      postRigAttach: (id, rigId) => this.postToWorker({ type: 'RIG_ATTACH', id, rigId }), postSetCollisionGroups: (id, groups) => this.postToWorker({ type: 'SET_COLLISION_GROUPS', id, groups }),
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      registerAi: (id, slot, behaviour) => this.aiController.register(id, slot, behaviour),
      // `peacefulDrones` swaps the hostile-pursuit behaviour for the
      // zero-impulse passive one. Used by engineering rooms (shield-test)
      // where the player needs a stationary drone gallery for collision
      // testing without combat noise. Drones still die normally — only
      // the COMBAT pursue+fire path is suppressed.
      droneBehaviour: roomOpts.peacefulDrones
        ? () => new PassiveDroneBehaviour()
        : (kind) => new HostileDroneBehaviour(kind),
      interestGrid: this.interestGrid,
      registerLagComp: (id) => this.snapshotRing.registerEntity(id),
      ...(pickDroneKind ? { pickDroneKind } : {}),
    });
    const seeded = this.swarmSpawner.seedAsteroids(asteroidRoster);
    if (seeded < asteroidRoster.length) {
      logger.error({ requested: asteroidRoster.length, seeded }, 'swarm spawner: not all asteroids seeded (slot pool exhausted)');
    }

    // ── Scrap-on-death (Phase 2b-ii) ────────────────────────────────────
    // Breaks a dying COMPOSITE ship (player or drone) into floating scrap
    // pieces — one per `shipScrapGroups(kind)` component. Decision logic over
    // injected hooks (spawn / health-seed / FIFO-evict), like TransitOrchestrator.
    // `seedHealth` uses the SAME swarmHealth map the drone seed uses, so scrap is
    // damageable through the existing swarm damage path. `evictScrap` quietly
    // despawns the oldest scrap when the global cap (MAX_LIVE_SCRAP) is hit.
    this.scrapSpawner = new ScrapSpawner({
      // IDEMPOTENT spawn (2026-06-19 playtest crash fix): a hull can emit
      // `SHIP_DESTROYED` TWICE in one tick — two lethal hits land in the same
      // damage batch (common under a wave), the handler runs twice with no
      // dedup, and re-spawns the SAME scrap ids → `SwarmEntityRegistry.register`
      // threw "id already registered" and took the whole server down mid-play.
      // Skipping a duplicate id is the correct no-op (the scrap already exists)
      // and bounds itself via the live registry — no set to clear.
      spawnScrap: (spec) => (this.swarmRegistry.has(spec.id) ? false : this.swarmSpawner.spawnScrap(spec)),
      // Seed health AND a zero shield so scrap is damageable through the swarm
      // layered-damage path (the drone leaf reads swarmShield; scrap has none,
      // so a hit lands on hull and a destroyed piece is evicted). Mirrors the
      // structure seed (swarmShield 0).
      seedHealth: (id, hp) => {
        this.swarmHealth.set(id, hp);
        this.swarmShield.set(id, 0);
      },
      evictScrap: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (rec) this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
      },
    });

    // ── Living World P1a — loot pods (features/lootPods.ts) ──
    this.loot = buildLootPods({
      sectorKey: () => this.sectorKey, keepAllOnDeath: roomOpts.testMode === true && roomOpts.keepAllOnDeath === true,
      now: () => this.gameClock.now(), swarmRegistry: this.swarmRegistry, swarmSpawner: () => this.swarmSpawner,
      evictSwarmEntity: (rec, opts) => this.evictSwarmEntity(rec, opts), sabF32: () => this.sabF32,
      lootCollectors: this.lootCollectors, forceFields: this.forceFields, capitalWrecks: () => this.capitalWrecks, oreDraw: this.oreDraw,
    });

    // ── Structure placement (structures plan, Phase 2) ──────────────────
    // Decision logic over injected concretions (spawn / health-seed / despawn /
    // clamp / id). A placed structure rides the existing kind=2 swarm path, so
    // it broadcasts + takes damage for free; the only structure-specific seam
    // is `swarmHealth` (presence = damageable) + the StructureRegistry record.
    const packedGateHost: PackedGateHost = {
      storage: () => this.storage, holdStore: () => getHoldStore(), sectorKey: () => this.sectorKey,
      findPacked: (owner, product) => this.findPacked(owner, product),
    };
    this.structurePlacement = new StructurePlacementSubsystem({
      spawnStructure: (s) => this.swarmSpawner.spawnStructure(s),
      seedHealth: (id, hp) => {
        this.swarmHealth.set(id, hp);
        this.swarmShield.set(id, 0); // no shield layer — hits land on the hull
      },
      despawn: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (rec) this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
        this.swarmHealth.delete(id);
        this.swarmShield.delete(id);
      },
      clamp: (x, y) => {
        // Solar-system rules are per room (tests set them without the env).
        if (this.solar) {
          const lim = SOLAR_HALF_EXTENT;
          return { x: Math.max(-lim, Math.min(lim, x)), y: Math.max(-lim, Math.min(lim, y)) };
        }
        const c = clampToSectorBounds(x, y);
        return { x: c.x, y: c.y };
      },
      nextId: () => `pstruct-${this.placedStructureCounter++}`,
      // Living World P1a-2 — stable uid (keys the structure's holds row).
      structureUid: (owner, kind, x, y) => structureUid(this.sectorKey, owner, kind, x, y),
      registry: this.structureRegistry,
      // Asteroids (swarm kind=0) block placement and a connector's line of sight
      // (Item D); shared with the grid-pulse reconnect sweep. Placement also
      // passes `near` for unloaded cut-field rocks (C5, links C5g), and `wrecks`
      // for wreck pieces, loaded and not (wreck fields 7). Off the hot loop.
      getObstacles: (near, wrecks) => this.obstacles.rocks(near, wrecks),
      // Economy v2 W4b — a player's non-starter structure is placed from a
      // PACKED item (now buyable from traders, and lootable). Consumed only
      // after the structure registers; its build then costs only time.
      sectorKey: () => this.sectorKey,
      packedGateForBuild: (owner, kindId) => packedGateForBuild(packedGateHost, owner, kindId),
      placementRefusal: (owner, kindId) => territoryLockRefusal(owner, kindId, this.sectorKey ?? '', liveSectorHolder(this.sectorKey ?? ''), this.structureRegistry.all()),
      shipHulls: () => this.obstacles.hullCircles(''), // round a ship: a hologram, parked hulls ordered clear (blueprintBody.ts)
      parkedHulls: { lingeringPoses: this.lingeringPoseCache, ship: (id) => this.state.ships.get(id), extentOf: (k) => (isShipKindId(k) ? hullExtent(k) : undefined), landingPoint: (p, x, y, k, s) => this.landingPoint(p, x, y, k, s), applyOrder: (o, ids, ord) => this.fleet.applyOrder(o, ids, ord) },
    });

    // ── Structure grid pulse (structures plan, Phase 3) ─────────────────
    // The 1 Hz logistics heartbeat: construction flow, repair, deconstruction,
    // power aggregation. Runs OFF the 60 Hz physics tick (unref'd timer).
    this.structureGrid = new StructureGridSubsystem({
      registry: this.structureRegistry,
      // The pulse period the timer below runs at (the build ETA reads it too).
      pulseMs: this.testMode && roomOpts.structureGridPulseMs ? Math.max(20, roomOpts.structureGridPulseMs) : TRANSFER_PULSE_MS,
      shipHulls: () => this.obstacles.hullCircles(''), solidify: (id) => this.swarmSpawner.solidifyStructure(id), // hologram pass-through
      getHealth: (id) => this.swarmHealth.get(id) ?? 0,
      setHealth: (id, hp) => { this.swarmHealth.set(id, hp); },
      despawn: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (rec) this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
        this.swarmHealth.delete(id);
        this.swarmShield.delete(id);
      },
      findNearestAsteroid: (x, y, range) => this.findNearestAsteroid(x, y, range),
      // v4 T1 — spare power after the batteries charges teleporter capacitors.
      chargeCapacitors: (members, spare) => this.teleporters.chargeCapacitors(members, spare),
      drawAsteroidResources: (entityId, amount) => this.oreDraw.draw(entityId, amount),
      // P2c — asteroid kinds, extractor goods into network storage, nebulae.
      asteroidYieldOf: (entityId) => { const r = this.swarmRegistry.getByEntityId(entityId); return r ? this.oreDraw.rowOf(r) : ASTEROID_YIELD.rock; },
      depositGoods: (rec, good, n) => this.production.deposit(rec, good, n),
      canDepositGoods: (rec, goods) => this.production.canDeposit(rec, goods),
      sectorHasNebula: () => this.sectorFeatures.includes('nebula'),
      // P2d — missile and autocannon turrets load munitions from base storage.
      takeMunition: (rec) => this.production.takeGoods(rec, ONE_MUNITION),
      // P2e — the level 3+ upgrade goods bill.
      takeGoods: (rec, goods) => this.production.takeGoods(rec, goods),
      // Allegiances P0: base turrets defend against combat allegiances (drones,
      // robots) but never open fire on NEUTRAL traders (their haulers).
      findNearestDrone: (x, y, range, owner) => this.turretTargeting.findNearestTurretTarget(x, y, range, owner),
      // Coastal defences — every hostile in reach, for per-mount fire control.
      turretTargets: (x, y, range, owner, out) => this.turretTargeting.collectTurretTargets(x, y, range, owner, out),
      rigTick: () => this.serverTick, // restyle 2h: a stowed pop-up turret holds fire
      applyDamage: (targetId, shooterId, damage) => this.applyDamage(targetId, shooterId, damage),
      blockBeamAtWall: (fx, fy, dx, dy, maxDist, damage) => this.blockShotAtWall(fx, fy, dx, dy, maxDist, damage),
      // Friendly fire: a turret beam lands on the first thing in its path.
      beamFirstHit: (fx, fy, dx, dy, maxDist, skipId) => this.rayHits.turretBeamFirstHit(fx, fy, dx, dy, maxDist, skipId),
      // Friendly fire slice 2: a turret holds over its own base / its owner.
      lineOfFireBlocked: (rec, targetId, fx, fy, dx, dy, max, w, k) => this.lineOfFire.structureLineBlocked(rec, targetId, fx, fy, dx, dy, max, w, k),
      broadcastBeam: (shooterId, fromX, fromY, toX, toY, targetId, mountId) => {
        this.broadcast('laser_fired', {
          type: 'laser_fired',
          shooterId,
          fromX, fromY, toX, toY,
          hit: true,
          targetId,
          // WS-4: the Miner's mining beam passes mountId 'drill' so the client
          // routes/tints it distinctly; the turret omits it (undefined → dropped
          // on the wire). undefined is JSON-omitted, so byte-identical for turrets.
          mountId,
        });
      },
      damagePlayersInBeam: (minerId, fromX, fromY, toX, toY, perHit) =>
        this.damagePlayersInMiningBeam(minerId, fromX, fromY, toX, toY, perHit),
      // WS-8 (R2.15) — a Bolt Turret spawns a server projectile toward its drone
      // target (ownerId = the turret's pstruct- id; the pipeline skips the owner).
      spawnProjectile: (shooterId, x, y, vx, vy, dmg, r, mt, wId) =>
        this.spawnServerProjectile(shooterId, x, y, vx, vy, dmg, r, mt, wId),
      // WS-8 (R2.15) — a Missile Turret launches a homing missile (ownerId = the
      // turret's pstruct- id, which turretTargeting.isMissileTargetHostile restricts to drones).
      spawnMissile: (shooterId, x, y, dx, dy, def) =>
        this.spawnServerMissile(shooterId, x, y, dx, dy, def),
      // Reconnect sweep honours current asteroid LOS (Issue 2), unloaded rocks in `near` too (C5g).
      getObstacles: (near) => this.obstacles.rocks(near),
      // Gameplay audit — a blueprint finished construction (1 Hz pulse, off-tick).
      // Campaign 6.3 — completion is durable state (isConstructed + full HP);
      // persist event-driven so a crash keeps the built structure built.
      // Economy v2 — taking down a structure placed from a packed item gives
      // the packed item back (EVE-style repackaging).
      onRepack: (rec) => this.repackStructure(rec),
      onCaptured: () => this.sectorPersistence.persistSoon(), // capture 4E S4: owners are durable
      onConstructed: (owner, kind) => {
        auditEvent({ event: 'structure_built', sector: this.sectorKey ?? undefined, owner, kind });
        this.sectorPersistence.persistSoon();
      },
    });
    // ── Living World P1a-2 — base storage network (deposit / refine / spill) ──
    this.storage = new StorageService({
      holdStore: getHoldStore(),
      registry: this.structureRegistry,
      sectorKey: () => this.sectorKey,
      componentOf: (id) => this.structureGrid.componentMembersOf(id),
    });
    this.researchLabs = new ResearchLabSubsystem({
      board: getLabBoard,
      wallet: getWallet,
      storage: this.storage,
      registry: this.structureRegistry,
      powered: (id) => this.structureGrid.powerSummaryFor(id).powered,
      setActive: (lab, active) => this.structureGrid.setActive(lab, active),
      sectorKey: () => this.sectorKey,
      now: () => this.gameClock.now(),
    });
    // Mine Layers (`features/mineHooks.ts`).
    this.mineField = buildMineField({
      structureRegistry: this.structureRegistry, mineHooks: this.mineHooks, turretTargeting: this.turretTargeting,
      powered: (id) => this.structureGrid.powerSummaryFor(id).powered,
      takeMunition: (rec) => this.production.takeGoods(rec, ONE_MUNITION),
      setActive: (rec, active) => this.structureGrid.setActive(rec, active),
      mines: () => (this.state as SectorState).mines, structures: () => (this.state as SectorState).structures, internStructureOwner: (o) => this.internStructureOwner(o),
    });
    // ── Shield-wall lifecycle (shield-fence plan) ──────────────────────────
    // Forms the blocking span between paired pylons + drives its physics
    // collider; updated on the grid pulse + the faster turret tick.
    this.production = new ProductionSubsystem({
      registry: this.structureRegistry,
      powered: (id) => this.structureGrid.powerSummaryFor(id).powered, canDrawFull: (rec) => { const g = this.structureGrid, s = g.powerSummaryFor(rec.id); return canTakeFullDraw(rec, s.powered, s.netPower, g.componentBatteryCharge(rec.id)); },
      componentOf: (id) => this.structureGrid.componentMembersOf(id),
      onBlueprintSpent: (rec) => this.storage.persistSlot(rec), swapBlueprint: (rec, recipe) => swapBlueprintFor(this.storage, rec, recipe),
      // Active power: processors draw full only while running.
      setActive: (rec, active) => this.structureGrid.setActive(rec, active),
      // D3 — station taxes: a player's habitat modules and spires pay their wallet; an NPC or ownerless base has none (`walletOwnerOf`).
      payCredits: (rec, n) => { const w = walletOwnerOf(rec.owner); if (w !== null) getWallet().credit(w, n, 'station_taxes'); },
      // A finished hull goes live: out of a Shipyard's slipway on a Move order to its park spot (`HullHandOff.launchNewHull`).
      launchHull: (rec, kind, q) => walletOwnerOf(rec.owner) !== null && this.hullHandOff.launchNewHull(rec.owner, kind, q, newHullOrigin(rec.kind, rec.x, rec.y, rec.rot ?? 0, kind, rec.prodCycles, rec.mirror), true).ok,
    });
    // v4 T1-T4 — the teleporters + the broker room (`features/teleportMessages.ts`).
    ({ teleporters: this.teleporters, teleportRoom: this.teleportRoom } = buildTeleporters({
      structureRegistry: this.structureRegistry, storage: () => this.storage, sectorKey: () => this.sectorKey,
      testCycleScale: this.testMode ? roomOpts.teleportCycleScale : undefined, powered: (id) => this.structureGrid.powerSummaryFor(id).powered,
      padRiders: this.padRiders, tolls: this.tolls, forceFields: this.forceFields, rebuildStructuresSlice: () => this.rebuildStructuresSlice(),
      postToWorker: (cmd) => this.postToWorker(cmd), sendToPlayer: (pid, type, msg) => this.sendToPlayerHere(pid, type, msg),
      canReceiveHull: (shipInstanceId) => this.freeSlots.length > 0 && !this.state.ships.has(shipInstanceId),
      receiveLingeringHull: (row) => this.hullHandOff.receiveHandedOffHull(row), receiveFleetSquads: (rows) => { this.fleet.restoreSquads(rows); },
    }));
    this.gates = buildGateController({
      registry: this.structureRegistry, pilots: this.playerToSlot, activeShip: (pid) => this.getActiveShip(pid), pose: (pid) => this.shipPoseCache.get(pid),
      relationOf: (playerId, owner) => relationOf(playerId, owner, this.relationCtx), serverTick: () => this.serverTick,
      supplyFrac: (id) => this.structureGrid.powerSummaryFor(id).supplyFrac, setActive: (rec, on) => this.structureGrid.setActive(rec, on), post: (cmd) => this.postToWorker(cmd),
      hitBoxes: (id) => this.swarmRegistry.get(id)?.boxes,
    });
    this.shieldWalls = new ShieldWallManager({
      registry: this.structureRegistry,
      powerSummaryFor: (id) => this.structureGrid.powerSummaryFor(id),
      componentBatteryCharge: (id) => this.structureGrid.componentBatteryCharge(id),
      drainComponentBatteries: (id, amount) => this.structureGrid.drainComponentBatteries(id, amount),
      spawnWall: (id, ax, ay, bx, by, thickness) =>
        this.postToWorker({ type: 'SPAWN_WALL', id, ax, ay, bx, by, thickness }),
      setWallActive: (id, active) => this.postToWorker({ type: 'SET_WALL_ACTIVE', id, active }),
      removeWall: (id) => this.postToWorker({ type: 'REMOVE_WALL', id }),
    });
    this.structureGridTimer = this.gameClock.every(this.structureGrid.pulseMs, guarded('structure-grid-tick', () => this.structureGridTick()));
    // Phase 5 — turret aim/fire on a faster cadence than the grid pulse.
    this.structureTurretTimer = this.gameClock.every(TURRET_TICK_MS, guarded('structure-turret-tick', () => this.structureTurretTick()));

    // Click-to-inspect live-stats channel (structures follow-up Item B5). Its
    // own ~5 Hz timer (200 ms), unref'd + OFF the snapshot/physics tick — the
    // emitter only does work while a client has an entity selected.
    const statsHost: SelectionStatsResolveHost = {
      ships: () => this.state.ships, swarmRegistry: this.swarmRegistry, structureRegistry: this.structureRegistry,
      swarmHealth: () => this.swarmHealth, sessionToPlayer: () => this.sessionToPlayer, relationCtx: this.relationCtx,
    };
    this.selectionStats = new SelectionStatsSubsystem({
      resolveStats: (sel) => resolveSelectionStats(statsHost, sel),
      sendTo: (sessionId, msg) => {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        client?.send('entity_stats', ownerGateStats(statsHost, sessionId, msg));
      },
    });
    this.fleetHooks.createFleetStatus();
    // eslint-disable-next-line no-restricted-globals -- real time: a UI refresh rate for the inspector and fleet panel, not game time
    this.selectionStatsTimer = setInterval(guarded('selection-stats-tick', () => {
      this.selectionStats.tick();
      this.fleetHooks.fleetStatus.tick();
    }), SELECTION_STATS_INTERVAL_MS);
    this.selectionStatsTimer.unref?.();

    if (this.testMode) this.persistSector = roomOpts.persistSector !== false; // cut field before any seeding: placement sees its rocks (C5)
    // The chunk-streaming host exists when the sector has ANY chunk source: the field's rocks today; wreck-field sources join `chunkSources` (wreck fields R7).
    // Break-up is ON by default in every room (owner decision 2026-11-14:
    // "land it switched on"). A room opts out with `capitalWrecks: false` /
    // `subcapWrecks: false`; the env switch wins over the room either way:
    // `=0` forces it off (tests, the off arm of the debris soak), `=1` on.
    // Read before the streaming host: a wreck field follows the switches.
    this.capitalWrecksOn = wreckSwitchOn(process.env['EQX_CAPITAL_WRECKS'], roomOpts.capitalWrecks);
    this.subcapWrecksOn = wreckSwitchOn(process.env['EQX_SUBCAP_WRECKS'], roomOpts.subcapWrecks); this.wreckSpawns.readStructureSwitch(roomOpts.structureWrecks); // structure break-up (on by default since 2026-11-22)
    const fieldSeed = roomOpts.cutField?.seed ?? null, chunkSources: ChunkSource[] = [];
    if (roomOpts.wreckField !== undefined && (this.capitalWrecksOn || this.subcapWrecksOn)) chunkSources.push(this.wreckFieldSource = this.wreckSpawns.buildWreckFieldSource(roomOpts.wreckField, roomOpts.cutField));
    if ((this.capitalWrecksOn || this.subcapWrecksOn) && this.persistSector && this.sectorKey !== null) chunkSources.push(this.wreckSaves = new BattleWreckSaves(() => this.capitalWrecks?.lineageState() ?? null, battleWreckStore(this.sectorKey), { piecePoseInto: (id, out) => this.wreckSpawns.wreckPose(id, out) !== null, tractored: (id) => this.forceFields.isTractored(id), streaming: !this.testMode || roomOpts.battleWreckStreaming === true })); // wreck fields 0b: battle lineages stream on the one streamer
    if (fieldSeed !== null || chunkSources.length > 0) this.cutField = new CutFieldSubsystem(fieldSeed, this.gameClock, this.swarmRegistry, this.swarmSpawner, { shipSlots: () => this.playerToSlot.values(), forEachLingeringSlot: (visit) => { for (const [sid, slot] of this.lingeringSlots) { const sh = this.state.ships.get(sid); if (sh !== undefined && isLingeringHull(sh)) visit(slot); } }, sab: () => this.sabF32, post: (cmd) => this.postToWorker(cmd), evict: (rec, broadcast) => this.evictSwarmEntity(rec, { broadcast, emitDestroyed: false }), broadcast: (type, msg) => this.broadcast(type, msg), shipMass: (id) => { const s = this.getActiveShip(id); return s ? shipBodyMass(getShipKind(s.kind)) : undefined; }, records: this.persistSector && this.sectorKey !== null && fieldSeed !== null ? terrainRecordStoreFor(`${this.sectorKey}|${fieldSeed}`) : undefined }, roomOpts.cutField?.clearings, chunkSources);
    if (this.cutField?.navOpts) this.aiController.nav = this.nav.host(this.cutField, this.cutField.navOpts);
    // Structures plan (Phase 3-5) — testMode scenario seeding: a pre-built,
    // powered grid + drones/asteroids, for deterministic E2E (no place-ahead
    // overlap, no construction wait).
    if (this.testMode) seedStructureScenario(this.structureScenarioHost, roomOpts);
    this.testTeleportFullCharge = this.testMode && roomOpts.teleportFullCharge === true;
    if (this.testMode && roomOpts.scaleGrid) seedScaleGrid(this.structureScenarioHost, roomOpts.scaleGrid);
    // D2 (plan soft-leaping-truffle v3) — NPC bases grown from the generator.
    if (roomOpts.npcBases && roomOpts.npcBases.length > 0) seedNpcBases(this.npcSeedHost, roomOpts.npcBases);
    if (this.testMode && roomOpts.tradeEnabled === true && this.sectorKey !== null) {
      // Per-room key: testId-filtered rooms share a sectorKey, so the director
      // must not confuse two parallel tests' rooms.
      this.tradeRegisteredKey = `${this.sectorKey}#${this.roomId}`;
      this.ensureTradeRegistered();
    }
    if (this.testMode) {
      if (roomOpts.seedStorageHold) {
        const g = roomOpts.seedStorageHold;
        this.testSeedStorageHold = { goods: { ...g.goods } };
        // Economy v2 W1 — credits aren't stored: they seed each joiner's WALLET.
        this.testWalletSeed = Math.max(0, Math.floor(g.credits ?? 0));
      }
      this.testHaulerRaiders = Math.max(0, Math.min(6, Math.floor(roomOpts.haulerRaiders ?? 0)));
      if (roomOpts.sceneScript !== undefined) ({ runner: this.sceneRunner, tickRing: this.sceneTickRing, workerRing: this.sceneWorkerRing } = initSceneScript({ perfSource: this, serverTick: () => this.serverTick, sectorKey: () => this.sectorKey, playerToSlot: () => this.playerToSlot, swarmSpawner: () => this.swarmSpawner, swarmRegistry: this.swarmRegistry, swarmHealth: () => this.swarmHealth, swarmShield: () => this.swarmShield, swarmShieldLastDmg: () => this.swarmShieldLastDmg, aiController: () => this.aiController, broadcast: (t, m) => this.broadcast(t, m), spawnLivingWorldBot: (spec) => this.spawnLivingWorldBot(spec), snapshotRestore: this.snapshotRestore, lingeringSlots: this.lingeringSlots, fleet: this.fleet, capitalWrecks: () => this.capitalWrecks, rigSceneHooks: () => this.rigs.rigScene.sceneHooks() }, roomOpts.sceneScript));
      this.perfFixedLoad = roomOpts.perfFixedLoad === true;
      const twa = roomOpts.testWaveArrival;
      if (twa && Number.isFinite(twa.x) && Number.isFinite(twa.y)) this.testWaveArrivalPose = { x: twa.x, y: twa.y };
      this.waveNeedsOwner = roomOpts.waveNeedsOwner === true;
    }
    // Phase-1 issue 5 — scrap-stress seed: a dense corridor of free-floating
    // scrap ahead of spawn for the fly-through reconciliation E2E.
    if (this.testMode && (roomOpts.scenarioScrapCount ?? 0) > 0) {
      seedScenarioScrap({ logger, restoreScrap: (rows) => this.snapshotRestore.restoreScrap(rows) }, roomOpts.scenarioScrapCount!);
    }
    // Living World bot lifecycle hooks (spawn/despawn/markHostile).
    // These satisfy the LivingWorldRoom contract; bots are server-
    // internal swarm entities, NOT Colyseus clients.
    this.livingWorldBotHooks = new LivingWorldBotHooks({
      serverTick: () => this.serverTick,
      sectorKey: () => this.sectorKey,
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      solar: () => this.solar,
      landingPoint: (id, x, y, kind) => this.landingPoint(id, x, y, kind), warpTargetFor: (k, fx, fy, tx, ty, out) => this.warpRoute.targetFor(k, fx, fy, tx, ty, out),
      postToWorker: (cmd) => this.postToWorker(cmd),
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      swarmHealth: this.shieldHullRouter.swarmHealth,
      swarmRegistry: this.swarmRegistry,
      swarmSpawner: this.swarmSpawner,
      aiController: this.aiController,
      evictSwarmEntity: (rec, opts) => this.evictSwarmEntity(rec, opts),
      extendBroadcastGrace: (untilTick) => { this.forceBroadcastUntilTick = untilTick; },
      joinBroadcastGraceTicks: JOIN_BROADCAST_GRACE_TICKS,
      broadcastWarpIn: (msg) => this.broadcast('warp_in', msg),
      broadcastWarpOut: (msg) => this.broadcast('warp_out', msg),
      broadcastBotAggro: (msg) => this.broadcast('bot_aggro', msg),
      bus: this.bus,
      clients: this.clients,
      patrols: this.patrols,
      testHaulerRaiders: () => this.testHaulerRaiders,
    });

    seedRoomStartup({
      logger, swarmRegistry: this.swarmRegistry, sandboxHostileDroneIds: this.sandboxHostileDroneIds,
      swarmSpawner: () => this.swarmSpawner, aiController: () => this.aiController, swarmHealth: () => this.swarmHealth,
      swarmShield: () => this.swarmShield, swarmShieldLastDmg: () => this.swarmShieldLastDmg, serverTick: () => this.serverTick,
      postToWorker: (cmd) => this.postToWorker(cmd), markElite: (id, name, mul, bounty) => this.markElite(id, name, mul, bounty),
    }, roomOpts, { testMode: this.testMode, useSingleAsteroid, useDronePoses, useStructurePoses, useBulkSeed });

    // Phase 8 — hydrate from the most recent on-disk snapshot for this sector.
    // No-op for engineering rooms (sectorKey === null). Restores swarm health
    // only; positions are deterministic from the seed and are not persisted.
    if (this.sectorKey !== null) {
      this.hydrateFromSnapshot();
    }
    if (this.testMode && roomOpts.breakInMs !== undefined) this.testBreakInMs = Math.max(1, roomOpts.breakInMs);
    if (this.testMode && roomOpts.lockTimeCapS !== undefined) {
      const cap = LockTimeCapSchema.safeParse(roomOpts.lockTimeCapS);
      if (cap.success) this.setLockTimeCap(cap.data);
      else logger.warn({ value: roomOpts.lockTimeCapS }, 'lockTimeCapS: invalid room option, ignored');
    }
    if (this.testMode && roomOpts.chargeTicksCap !== undefined) {
      const cap = ChargeTicksCapSchema.safeParse(roomOpts.chargeTicksCap);
      if (cap.success) this.testChargeTicksCap = cap.data;
      else logger.warn({ value: roomOpts.chargeTicksCap }, 'chargeTicksCap: invalid room option, ignored');
    }
    if (this.testMode && roomOpts.traverseTicksCap !== undefined) {
      const cap = TraverseTicksCapSchema.safeParse(roomOpts.traverseTicksCap);
      if (cap.success) this.testTraverseTicksCap = cap.data;
      else logger.warn({ value: roomOpts.traverseTicksCap }, 'traverseTicksCap: invalid room option, ignored');
    }
    this.timeScale.autoSlowdown = !this.testMode || roomOpts.autoTimeScale === true;
    if (this.testMode && roomOpts.timeScale !== undefined) {
      const ts = TimeScaleSchema.safeParse(roomOpts.timeScale);
      if (ts.success) this.setTimeScale(ts.data);
      else logger.warn({ value: roomOpts.timeScale }, 'timeScale: invalid room option, ignored');
    } else if (ENV_TIME_SCALE !== null) {
      this.setTimeScale(ENV_TIME_SCALE);
    }
    // (Wreck switches: read before the streaming host, above.)
    if (this.capitalWrecksOn || this.subcapWrecksOn) this.capitalWrecks = buildCapitalWrecks({ serverTick: () => this.serverTick, swarmRegistry: this.swarmRegistry, wreckKindAllowed: (k) => this.wreckSpawns.wreckKindAllowed(k), getActiveShip: (pid) => this.getActiveShip(pid), state: () => this.state, patrols: this.patrols, shipPoseCache: this.shipPoseCache, lingeringPoseCache: this.lingeringPoseCache, sabF32: () => this.sabF32, sabU32: () => this.sabU32, swarmSpawner: () => this.swarmSpawner, physicsWorkerProxy: () => this.physicsWorkerProxy, evictSwarmEntity: (rec, o) => this.evictSwarmEntity(rec, o), wreckPose: (id, out) => this.wreckSpawns.wreckPose(id, out), wreckPoseScratch: this._wreckPose, postToWorker: (c) => this.postToWorker(c), wreckImpulseCmd: this._wreckImpulseCmd, wreckRigidImpulseCmd: this._wreckRigidImpulseCmd, playerToSlot: () => this.playerToSlot, lingeringSlots: this.lingeringSlots, loot: () => this.loot, locks: () => this.locks, wingmanLocks: () => this.wingmanLocks, wreckSaves: () => this.wreckSaves, wreckFieldSource: () => this.wreckFieldSource, cutField: () => this.cutField, structures: this.wreckSpawns });
    if (this.wreckSaves !== null && this.wreckSaves.loadRows() >= 0) this.gameClock.every(WRECK_LINEAGE_FLUSH_MS, guarded('wreck-lineage-flush', () => this.wreckSaves?.flush(false)));
    // T1 (plan soft-leaping-truffle v3) — the sector's NPC base, after restore.
    if (roomOpts.galaxyBases === true && this.sectorKey !== null && getSector(this.sectorKey) && !isNpcBasesDisabled()) {
      seedGalaxyBase(this.npcSeedHost, this.sectorKey);
    }
    // v4 A — the border gates, after the restore (saved player structures keep
    // their places) and the NPC bases (a gate takes the nearest free spot).
    if (roomOpts.solarSectors !== undefined) this.solar = roomOpts.solarSectors;
    if (roomOpts.alienGates === true && this.sectorKey !== null && getSector(this.sectorKey) && !isAlienGatesDisabled()) {
      seedAlienGates(this.npcSeedHost, this.sectorKey, alienGateSites(this.sectorKey));
    }
    if (this.testMode && roomOpts.testAlienGate !== undefined) {
      seedAlienGates(this.npcSeedHost, this.sectorKey ?? 'test', [roomOpts.testAlienGate]);
    }
    if ((roomOpts.pocketPads ?? roomOpts.alienGates) === true && this.solar && this.sectorKey !== null && getSector(this.sectorKey)) {
      seedPocketPads(this.npcSeedHost, this.sectorKey);
    }

    // Phase 8 sub-phase B — explicit 15s seat-reservation TTL for incoming
    // hyperspace travellers. Default is already 15 in Colyseus 0.16; making
    // it explicit guards against a future default change silently breaking
    // the contract.
    this.setSeatReservationTime(15);

    // Paradigm plan (quirky-rabbit) Phase 6 — fan server GC pauses out to
    // this room's clients. The subscriber is called synchronously inside
    // the GC observer; the broadcast just enqueues into each WS buffer,
    // which is the cheap operation that contract demands.
    this.gcPauseSubscriber = (event: GcPauseEvent): void => {
      const msg: GcPauseEventMessage = {
        type: 'gc_pause',
        durationMs: event.durationMs,
        kind: event.kind,
      };
      this.broadcast('gc_pause', msg);
    };
    subscribeGcPause(this.gcPauseSubscriber);

    // Phase 8 sub-phase B — per-room transit driver. Engineering rooms get
    // an orchestrator too, but it'll always reject `engage_transit` because
    // sectorKey is null (the orchestrator validates and sends back DOCKED).
    //
    // Phase 5 — the orchestrator gets `PlayerShipStore` so it can validate
    // ownership when `engage_transit` carries a `shipId`. Without the store
    // a shipId-carrying request rejects as unknown, which is safe-by-default.
    // Wave-system: testMode rooms may inject a fast player spool so E2E never
    // waits the 5-min production `SPOOL_DURATION_MS`. Galaxy gameplay always
    // gets the real spool (the override is testMode-gated, like testTimeScale).
    const transitSpoolMs =
      this.testMode && roomOpts.transitSpoolMsOverride != null
        ? Math.max(1, roomOpts.transitSpoolMsOverride)
        : undefined;
    this.transitOrchestrator = new TransitOrchestrator(
      transitHostRoom({
        sectorKey: this.sectorKey, bus: this.bus, sabF32: this.sabF32, playerToSlot: this.playerToSlot,
        playerToUser: this.playerToUser, playerToActiveShipInstance: this.playerToActiveShipInstance,
        lastFireClientTick: this.lastFireClientTick, playerToTransitInFlight: this.playerToTransitInFlight,
        playerToSession: this.playerToSession, lingeringSlots: this.lingeringSlots, fleet: this.fleet, fleetHooks: this.fleetHooks,
        getActiveShip: (pid) => this.getActiveShip(pid), clients: () => this.clients, ships: () => this.state.ships,
        broadcast: (type, message, options) => this.broadcast(type, message, options),
        handOffHullsTo: (toRoom, moves, arrival) => this.hullHandOff.handOffHullsTo(toRoom, moves, arrival),
      }),
      transitSpoolMs,
      getPlayerShipStore(),
      this.gameClock,
    );

    // Client-message features (features/index.ts): transit, flight control,
    // test-only cues, teleporters, trade, the research lab, blueprints, cargo,
    // structures, structure settings, bounties, ship upgrades, fleet commands,
    // fire-control locks, selection stats, WebRTC signalling and pilot seats.
    this.roomFeatures = registerRoomFeatures({
      devTest: {
        testMode: this.testMode,
        allowDevOverrides: ALLOW_DEV_OVERRIDES,
        sabF32: this.sabF32,
        sessionToPlayer: this.sessionToPlayer,
        swarmRegistry: this.swarmRegistry,
        malformed: this.malformed,
        markAllDronesHostileTo: (pid) => this.markAllDronesHostileTo(pid),
        reloadAllTurrets: () => this.structureGrid.reloadAllTurrets(),
        applyDamage: (id, shooter, dmg, x, y) => { this.applyDamage(id, shooter, dmg, x, y); },
        warpBot: (id, x, y) => { this.warpBot(id, x, y); },
        setBotMoveTarget: (id, x, y) => this.setBotMoveTarget(id, x, y),
        testTractor: (pid, entityId, ticks) => {
          const m = getShipKind(this.getActiveShip(pid)?.kind ?? null).mounts?.[0], t = this.swarmRegistry.getByEntityId(entityId);
          if (m && t) this.forceFields.renewTractor(pid, { ...m, weaponId: 'tractor' }, t.id, ticks);
        },
        dropTestPods: (pid) => { const p = this.shipPoseCache.get(pid); if (p) dropTestPodRow(this.loot, p.x, p.y); },
      },
      onMessage: (type, handler) => this.onMessage(type, handler),
      nav: this.nav,
      malformed: this.malformed,
      sessionToPlayer: () => this.sessionToPlayer,
      swarmRegistry: this.swarmRegistry,
      structureRegistry: this.structureRegistry,
      teleporters: () => this.teleporters,
      teleportRoom: () => this.teleportRoom,
      sectorKey: () => this.sectorKey,
      now: () => this.gameClock.now(),
      storage: () => this.storage,
      rebuildStructuresSlice: () => this.rebuildStructuresSlice(),
      answerToll: (pid, padId, answer) => this.tolls.answerToll(pid, padId, answer),
      resolveOwnerName: (owner) => this.rosterPersistence.resolveOwnerName(owner),
      relationCtx: this.relationCtx,
      tradeRegisteredKey: () => this.tradeRegisteredKey,
      ensureTradeRegistered: () => this.ensureTradeRegistered(),
      researchLabs: () => this.researchLabs,
      playerToUser: this.playerToUser,
      production: () => this.production, hullHandOff: () => this.hullHandOff,
      resolveActiveShipKey: (pid) => this.resolveActiveShipKey(pid),
      ownShipKey: (pid) => this.pilotSwap.ownShipKey(pid),
      ship: (id) => this.state.ships.get(id),
      shipPoseCache: this.shipPoseCache,
      fittedOf: (id) => this.fittedOf(id),
      fittedCache: this.fittedCache,
      shipHullMax: (kindMax, alloc, id) => this.shipHullMax(kindMax, alloc, id),
      breakIns: this.breakIns,
      manualCargo: this.lootCollectors.manualCargo,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipCargoCapacity: (kind, id) => this.shipCargoCapacity(kind, id),
      npcHold: (rec) => this.npcLoot.hold(rec),
      shipTarget: (ref) => this.breakInHooks.shipTarget(ref),
      breakInMsFor: (rec) => this.breakInHooks.breakInMsFor(rec),
      breakInMsForShip: (t) => this.breakInHooks.breakInMsForShip(t),
      pilotNear: (pid, rec) => this.breakInHooks.pilotNear(pid, rec),
      pilotNearPoint: (pid, x, y, r) => this.breakInHooks.pilotNearPoint(pid, x, y, r),
      loot: () => this.loot,
      lootSearch: this.lootSearch,
      pilotCollector: (pid) => this.lootCollectors.pilotCollector(pid),
      bountyRoom: { broadcastWorldNotice: (notice) => this.broadcastWorldNotice(notice) },
      sendNotice: (client, text) => this.sendNotice(client, text),
      applyShipUpgrade: (client, pid, shipId, alloc) => this.shipProgression.applyShipUpgrade(client, pid, shipId, alloc),
      structurePlacement: () => this.structurePlacement,
      structureGrid: () => this.structureGrid,
      sectorPersistence: () => this.sectorPersistence,
      testSeedStorageHold: () => this.testSeedStorageHold,
      deck: () => this.state.deck,
      findPacked: (owner, product) => this.findPacked(owner, product),
      logger,
      fleetMsgAllowed: (sid) => this.fleetHooks.fleetMsgAllowed(sid),
      fleet: this.fleet,
      fleetTransit: () => this.transitOrchestrator,
      transitOrchestrator: () => this.transitOrchestrator,
      inputCountThisTick: this.inputCountThisTick,
      playerToSlot: this.playerToSlot,
      boostingPlayers: this.boostingPlayers,
      thrustingPlayers: this.thrustingPlayers,
      postToWorker: (cmd) => this.postToWorker(cmd),
      isPilotDisabled: (playerId) => this.gateGuard.isDisabled(playerId, this.gameClock.now()),
      noteWarpRequest: (playerId, x, y) => this.warpTravel.noteRequest(playerId, x, y),
      validWarpPoint: (playerId, x, y) => this.warpRoute.valid(playerId, x, y),
      handleFire: (client, raw) => this.handleFire(client, raw),
      handleRespawn: (client) => this.handleRespawn(client),
      handleClientReady: (client) => this.joinHandler.clientReady(client),
      reclaimLingeringHull: (client, pid, shipId) => this.pilotSwap.reclaimLingeringHull(client, pid, shipId),
      enterSpectate: (pid) => this.fleetHooks.enterSpectate(pid),
      fleetStatusSoon: this.fleetHooks.fleetStatusSoon,
      serverTick: () => this.serverTick, noteInputMargin: (pid, m) => this.snapshotBroadcaster.inputMargins.set(pid, m),
      playerToActiveShipInstance: this.playerToActiveShipInstance,
      lockMsgAllowed: (sid) => this.lockMsgAllowed(sid),
      fireControlLocks: () => this.locks,
      selectionStats: () => this.selectionStats, shieldHull: () => this.shieldHullRouter,
      webrtcChannelManager: () => this.webrtcChannelManager,
    });

    this.bus.on('SHIP_DESTROYED', (evt) => onShipDestroyed(this.shipDestroyedHost, evt));

    // Hi-res tick loop. Colyseus's `setSimulationInterval` uses `setInterval`,
    // which on Windows quantises to the ~15.6 ms multimedia-clock granularity
    // and fires only ~32–46 times/sec instead of 60 (root cause of the May
    // 2026 mobile-corr capture's 46 Hz server rate). setImmediate has ~1 ms
    // granularity and lets us hit 60 Hz reliably across platforms.
    // Game speed (time scale stream): 60 updates per GAME second, so
    // 60 × scale per wall second. Every per-update system follows the speed
    // with no code of its own; the period is re-read each update.
    // This sector's physics world steps at the same game speed.
    const applyTimeScale = (scale: number): void => {
      this.postToWorker({ type: 'SET_TIME_SCALE', scale });
      this.timeScale.timeScaleKey.s = scale;
      this.timeScale.timeScaleKey.fromTick = this.serverTick;
    };
    this.gameClock.onScaleChange(applyTimeScale);
    // A speed set earlier in onCreate (room option, EQX_TIME_SCALE) applies now.
    if (this.gameClock.scale !== 1) applyTimeScale(this.gameClock.scale);
    // eslint-disable-next-line no-restricted-properties -- real time: this loop schedules the room ticks
    let nextTickAt = performance.now();
    const schedule: CatchUpResult = { nextTickAt, dropped: 0 };
    // Error boundary (campaign 1.1): a throw escaping update() used to kill
    // the whole single-process host AND end this loop (the tail setImmediate
    // never ran). One bad tick is skipped-and-logged; the loop continues.
    const guardedUpdate = guarded(`sim-update:${this.sectorKey ?? this.roomId}`, () => this.update());
    const loop = (): void => {
      if (this.simLoopStopped) return;
      // eslint-disable-next-line no-restricted-properties -- real time: the room tick scheduler
      const now = performance.now();
      if (now >= nextTickAt) {
        guardedUpdate();
        // Catch-up cap: if we're more than 5 ticks behind (e.g. GC pause),
        // jump forward so we don't spiral.
        advanceSchedule(now, nextTickAt, tickPeriodMs(this.gameClock.scale), schedule);
        nextTickAt = schedule.nextTickAt;
      }
      setImmediate(loop);
    };
    loop();
    logger.info('SectorRoom created');
  }

  /** Set in onDispose() so the setImmediate loop exits cleanly. */
  private simLoopStopped = false;

  // ── Phase 6a — playerId → shipInstanceId indirection ──────────────────────

  /**
   * Translate a player id to the shipInstanceId of the hull THAT PLAYER
   * is currently piloting in THIS room. Returns `undefined` when the
   * player isn't bound (engineering room with no roster, fresh spawn
   * mid-flight, post-leave). Callers that hit this should treat undefined
   * as "no active ship" and bail out cleanly.
   *
   * NO `?? playerId` fallback — engineering rooms now generate a synthetic
   * shipInstanceId at join time, so a non-empty entry exists for every
   * bound player. Falling back to playerId would mask a real wiring bug
   * elsewhere.
   */
  private resolveActiveShipKey(playerId: string): string | undefined {
    return this.playerToActiveShipInstance.get(playerId);
  }

  // ── Fire control (exp/fire-control): lock helpers, `features/fireControlLocks.ts` ──
  private readonly fireLocks: FireControlLocks = new FireControlLocks({
    state: () => this.state, locks: () => this.locks, wingmanLocks: () => this.wingmanLocks, fleet: this.fleet,
    swarmRegistry: this.swarmRegistry, structureRegistry: this.structureRegistry, relationCtx: this.relationCtx,
    hostileActs: this.hostileActs, gameClock: this.gameClock, lingeringSlots: this.lingeringSlots,
    lingeringPoseCache: this.lingeringPoseCache, shipPoseCache: this.shipPoseCache, capitalWrecks: () => this.capitalWrecks,
    serverTick: () => this.serverTick, aiController: () => this.aiController,
    testLockTimeCapS: () => this.testLockTimeCapS, broadcast: (type, message) => this.broadcast(type, message),
    getActiveShip: (pid) => this.getActiveShip(pid), engageablePilotHull: (pid) => this.pilotSwap.engageablePilotHull(pid),
    npcHostileTo: (id, pid) => this.npcHostileTo(id, pid), refreshNpcAttackHostility: (id, pid) => this.refreshNpcAttackHostility(id, pid),
    swarmEntityPoseInto: (id, out) => this.swarmEntityPoseInto(id, out), resolveInstanceMounts: (s) => this.resolveInstanceMounts(s),
    hasHold: (sid) => this.hasHold(sid), shipCargoCapacity: (k, sid) => this.shipCargoCapacity(k, sid), holdWeight: (uid) => this.holdWeight(uid),
    tractorLos: {
      target: (key, out) => { const r = this.swarmRegistry.getByEntityId(swarmLockId(key)); if (r == null) return false; const b = slotBase(r.slot); out.x = this.sabF32[b + SLOT_X_OFF]!; out.y = this.sabF32[b + SLOT_Y_OFF]!; out.id = r.id; return true; },
      activatedMounts: (id): ReadonlyArray<WeaponMount> | undefined => this.fireLocks._lockActivated.get(id)?.mounts,
      firstOnLine: (fx, fy, tx, ty, e, tg) => this.lineOfFire.gate().firstOnLine(fx, fy, tx, ty, e, tg, notTransparent),
    },
    lineHeld: (k, i, w, fx, fy, tx, ty, skip, tgt) => this.lineOfFire.lineHeld(k, i, w, fx, fy, tx, ty, skip, tgt),
  });

  /**
   * "An NPC that is attacking stays hostile" (owner 2026-11-12): its own lock
   * on a pilot and its own hits on them re-stamp its hostility, so it forgets
   * the pilot 30 s (`FORGET_TICKS`) after it last hit them or held a lock on
   * them. Refresh only: the NPC must already hold the pilot in its hostility
   * ledger (`truce` = ledger only), so on-sight stance (robots) never turns
   * into ledger hostility and a truce still ends it. No `bot_aggro` (the
   * snapshot `drones[].hostile` bit carries it, #16). Alloc-free (#14): a Map
   * lookup, and `markHostile` only overwrites an existing entry.
   */
  private refreshNpcAttackHostility(npcId: string, pid: string): void {
    if (this.aiController.isEntityHostileToPlayer(npcId, pid, true)) {
      this.aiController.markHostile(npcId, pid, this.serverTick);
    }
  }

  /**
   * Phase 6b — convenience reader. Look up the active ShipState for a
   * given playerId. Internally translates playerId → shipInstanceId
   * via the indirection map and reads the schema. Returns `undefined`
   * for unknown players or players whose only hulls are lingering
   * (isActive=false). Use this everywhere a Phase 6a callsite did
   * `state.ships.get(playerId)`.
   */
  private getActiveShip(playerId: string): ShipState | undefined {
    const shipKey = this.resolveActiveShipKey(playerId);
    if (shipKey === undefined) return undefined;
    return this.state.ships.get(shipKey);
  }

  // ── Combat ──────────────────────────────────────────────────────────────

  /**
   * Resolve the firing slot's mount list for a given ship-kind.
   *
   * Phase 2a (mount-iteration refactor): every catalogue ship-kind now carries
   * `mounts` + `slots`. The fire path resolves the named slot (or the first
   * slot when no name is given — today's only path, since FireMessage doesn't
   * yet carry `slotId`) and returns its mount records in the slot's declared
   * order. Returns an empty array when the ship-kind has no mounts/slots
   * (defensive — every shipped kind has them, but a malformed catalogue
   * shouldn't crash the room).
   */
  // Pure mount/slot geometry helpers moved to ./mountGeometry.ts. The
  // class still calls them via `this.resolveSlotMounts(...)` / `this.
  // mountWorldOrigin(...)` for minimal blast-radius — these thin
  // method-wrapper delegations preserve every existing call-site.
  private resolveSlotMounts(kind: ShipKind, slotId?: string): ReadonlyArray<WeaponMount> {
    return resolveSlotMounts(kind, slotId);
  }
  /** WS-B3 — a player ship's FULL per-instance mount list `[...kind.mounts,
   *  ...activated latent]` (the `mountAngles[]` index space). Reads
   *  `ship.mounts`; un-upgraded ⇒ exactly `kind.mounts`. */
  private resolveInstanceMounts(ship: ShipState): ReadonlyArray<WeaponMount> {
    return resolveInstanceMounts(getShipKind(ship.kind), ship.mounts);
  }
  /** WS-B3 — a player ship's FIRING mount set `[...active-slot, ...activated]`.
   *  The server's mount ticker uses the default (first) slot, matching the
   *  pre-WS-B3 behaviour; the active-slot selection rides the `fire` message. */
  private resolveInstanceFireMounts(ship: ShipState, slotId?: string): ReadonlyArray<WeaponMount> {
    return resolveInstanceFireMounts(getShipKind(ship.kind), ship.mounts, slotId);
  }
  private mountWorldOrigin(
    shipX: number,
    shipY: number,
    shipAngle: number,
    mount: WeaponMount,
  ): { x: number; y: number } {
    return mountWorldOrigin(shipX, shipY, shipAngle, mount);
  }

  /**
   * Phase 4b.3 — compute each alive player ship's per-mount rotation
   * angles for this tick and store them in `playerMountAngles`. Mirrors
   * the client's `ColyseusClient.tickLocalMountAim` so both sides
   * produce identical (lockstep) angles when given the same poses;
   * the server's output is authoritative, shipped through
   * `SnapshotMessage.states[id].mountAngles`, and used in
   * `handleFire` for ray geometry.
   *
   * Out-of-range drones (beyond `HITSCAN_RANGE`) are filtered by
   * `pickTarget`'s `maxDistance` option, so a ship with no target in
   * reach slews its mounts back to forward (the `target === null`
   * branch below).
   *
   * Drones don't run this path in 4b.3 — their mounts stay at
   * `baseAngle`. Phase 4c adds the same compute for drones with the
   * matching `SnapshotMessage.drones[].mountAngles` anchor.
   */
  private tickPlayerMounts(): void {
    this.mountTicker.tickPlayer();
  }

  /**
   * Phase 4c (2026-05-11) — drone turret rotation. Mirrors `tickPlayerMounts`
   * but iterates the swarm registry: each drone whose ship-kind has at
   * least one rotating mount runs `pickTarget` (with player ships as
   * candidates, filtered through the drone's `hostileTo` set), then slews
   * each mount toward the picked bearing via `rotateMountToward`. The
   * result is stored in `droneMountAngles` for `handleAiFire` to read and
   * for the snapshot serialisation to ship to clients.
   *
   * Drones whose kind has no rotating mounts (legacy fighter/scout/heavy
   * — single 'forward' mount with zero arc) are skipped entirely; their
   * `droneMountAngles` map entry is never allocated, saving both compute
   * and snapshot bytes (the wire field is omitted for empty arrays).
   *
   * Hostility model: same as the existing `HostileDroneBehaviour` — only
   * players the drone has been damaged by are in view. A drone with no
   * hostile players slews its mounts back toward 0 (forward).
   */
  private tickDroneMounts(): void {
    this.mountTicker.tickDrone();
  }

  private handleFire(client: Client, raw: unknown): void {
    // v4 A — a disabled pilot's weapons are offline; firing inside an alien
    // gate's zone disables them.
    if (this.gateGuard.gateCount > 0) {
      const pid = this.sessionToPlayer.get(client.sessionId);
      if (pid !== undefined) {
        const now = this.gameClock.now();
        if (this.gateGuard.isDisabled(pid, now)) return;
        const slot = this.playerToSlot.get(pid);
        if (slot !== undefined) {
          const b = slotBase(slot);
          this.gateGuard.onFired(pid, this.sabF32[b + SLOT_X_OFF]!, this.sabF32[b + SLOT_Y_OFF]!, now);
          if (this.gateGuard.isDisabled(pid, now)) return;
        }
      }
    }
    this.playerFireResolver.resolve(client, raw);
  }


  /**
   * Build a read-only AiEntity snapshot for the given swarm id by reading SAB.
   * Used by AiController to feed live poses to behaviours each tick.
   *
   * 2026-05-31: pooled scratch (Invariant #14). Pre-fix this allocated a
   * fresh literal per drone per server tick (~15 × 60 = 900 allocs/sec).
   * Combined with HostileDroneBehaviour's per-tick AiIntent literals,
   * the V8 GC was firing major collections every ~1 s → 100-334 ms
   * stop-the-world pauses → `aiTick` phase blocking the snapshot
   * dispatch loop → user-reported chronic `recv_gap_long` 227-461 ms.
   * Capture `hlqxy6` + dispatch probe `tests/diag/server-dispatch-gap-probe.ts`.
   *
   * The caller (`AiController.runEntity` → `behaviour.tick(self, view)`)
   * reads the fields immediately and does not retain the reference, so
   * mutating a single shared object across calls is safe.
   */
  // `AiEntity` fields are typed `readonly` in the IAiBehaviour contract
  // — that's a contract-level read-only (callers must not mutate),
  // not a structural-level immutability. The pool writes through a
  // `Mutable<AiEntity>` view; consumers (`AiController.runEntity` →
  // `behaviour.tick(self, view)`) still see the original `readonly`
  // surface and treat fields as immutable.
  private readonly _aiEntityScratch: { -readonly [K in keyof AiEntity]: AiEntity[K] } = {
    id: '', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
  };
  private swarmEntitySnapshot(id: string): AiEntity | null {
    const rec = this.swarmRegistry.get(id);
    if (!rec) return this.lingeringHullSnapshot(id);
    const b = slotBase(rec.slot);
    const s = this._aiEntityScratch;
    s.id = id;
    s.x = this.sabF32[b + SLOT_X_OFF]!;
    s.y = this.sabF32[b + SLOT_Y_OFF]!;
    s.vx = this.sabF32[b + SLOT_VX_OFF]!;
    s.vy = this.sabF32[b + SLOT_VY_OFF]!;
    s.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
    s.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
    s.health = this.swarmHealth.get(id);
    return s;
  }

  /** The `swarmEntitySnapshot` fallback for an AI-flown parked hull (RTS
   *  Part B): its pose from `lingeringPoseCache` (mirrored from the SAB this
   *  tick), into the same shared scratch. Null for anything else. */
  private lingeringHullSnapshot(id: string): AiEntity | null {
    const p = this.lingeringPoseCache.get(id);
    if (p === undefined) return null;
    const s = this._aiEntityScratch;
    s.id = id;
    s.x = p.x;
    s.y = p.y;
    s.vx = p.vx;
    s.vy = p.vy;
    s.angle = p.angle;
    s.angvel = p.angvel ?? 0;
    s.health = this.state.ships.get(id)?.health;
    return s;
  }

  /** Living World P1a-2 — liveness for AI targeting (#17): a player with a
   *  live session. Bound once (no per-tick closure, #14). */
  private readonly _isPlayerConnected = (pid: string): boolean => this.playerToSession.has(pid);

  /** Living World P1a-2 (decision 7) — append every alive, displaced LINGERING
   *  hull (id = shipInstanceId, ownerId = its player) to the AI player view.
   *  Bound once. Views come from `_lingerViewPool` (grown once per new
   *  high-water mark, then reused every tick, #14): with an AI-flown fleet of
   *  parked hulls (RTS, up to the 200-ship roster) a literal per hull per tick
   *  was the biggest allocation on this path. Safe to reuse: the AI copies
   *  each view into its own candidate buffer and keeps no reference. */
  private readonly _lingerViewPool: Array<{
    id: string; ownerId: string; x: number; y: number; vx: number; vy: number; angle: number;
    health: number; maxHealth: number; kindId: string | null; shieldUp: boolean;
  }> = [];
  private readonly _visitLingeringTargets = (out: AiPlayerView[]): void => {
    if (this.lingeringSlots.size === 0) return;
    const pool = this._lingerViewPool;
    let n = 0;
    for (const shipInstanceId of this.lingeringSlots.keys()) {
      const ship = this.state.ships.get(shipInstanceId);
      if (!ship?.alive) continue;
      const pose = this.lingeringPoseCache.get(shipInstanceId);
      if (!pose) continue;
      let v = pool[n];
      if (v === undefined) {
        v = { id: '', ownerId: '', x: 0, y: 0, vx: 0, vy: 0, angle: 0, health: 0, maxHealth: 0, kindId: null, shieldUp: false }; // high-water growth only
        pool[n] = v;
      }
      n++;
      v.id = shipInstanceId; v.ownerId = ship.playerId;
      v.x = pose.x; v.y = pose.y; v.vx = pose.vx; v.vy = pose.vy; v.angle = pose.angle;
      v.health = ship.health; v.maxHealth = ship.maxHealth; v.kindId = ship.kind ?? null; v.shieldUp = ship.shield > 0;
      out.push(v);
    }
  };

  private readonly aiSwarmScratch: AiSwarmView[] = [];

  /** The AI tick's neighbour + debris grids, one registry walk per tick (`AiNeighbourFill`). */
  private readonly aiGrids = new AiNeighbourFill(this.swarmRegistry, () => this.sabF32, { fleetSize: () => this.fleet.size, swarmHealth: () => this.swarmHealth });

  /**
   * AI fire path. Mirrors the player hitscan logic but skips the message
   * parser, the per-session hit_ack, and the temporal-plausibility window
   * (AI fires at the current tick by definition). Cooldown is enforced via
   * the same `lastFireClientTick` map keyed by AI shooter id.
   *
   * Phase 5e will refactor handleFire to share the hit-resolution + damage +
   * broadcast tail with this method, eliminating the duplication. For 5c+
   * preview the duplication is contained to this single method.
   */
  private handleAiFire(shooterId: string, dirX: number, dirY: number, tick: number, targetId: string, cone?: number): void {
    if (this.gateGuard.gateCount > 0) {
      const now = this.gameClock.now();
      if (this.gateGuard.isDisabled(shooterId, now)) return;
      const rec = this.swarmRegistry.get(shooterId);
      if (rec) {
        const b = slotBase(rec.slot);
        this.gateGuard.onFired(shooterId, this.sabF32[b + SLOT_X_OFF]!, this.sabF32[b + SLOT_Y_OFF]!, now);
        if (this.gateGuard.isDisabled(shooterId, now)) return;
      }
    }
    this.aiFireResolver.resolve(shooterId, dirX, dirY, tick, targetId, cone);
  }

  private spawnServerProjectile(ownerId: string, x: number, y: number, vx: number, vy: number, damage: number, radius: number, maxTicks: number, weaponId: WeaponId): void {
    this.projectiles.spawn(ownerId, x, y, vx, vy, damage, radius, maxTicks, weaponId);
  }

  private spawnServerMissile(
    ownerId: string,
    spawnX: number,
    spawnY: number,
    dirX: number,
    dirY: number,
    def: MissileWeaponDef,
  ): number | null {
    return this.missileSim.spawn(
      ownerId, spawnX, spawnY, dirX, dirY, def,
      this.turretTargeting.isMissileTargetHostile(ownerId),
    );
  }

  /**
   * Shield->hull layered damage for a schema ShipState (active or
   * lingering). Mutates ship.health (hull) + ship.shield +
   * ship.shieldLastDamageTick. On the shield 0-cross emits SHIELD_BROKEN
   * and, when a worker body id is given, posts SET_HULL_EXPOSED so Rapier
   * swaps the body to its hull polygon. workerBodyId is null where the
   * collider swap is deferred (lingering hulls: dual body-id cases).
   */
  private damageShipLayered(
    ship: ShipState,
    damage: number,
    workerBodyId: string | null,
  ): { newShield: number; shieldMax: number; hullMax: number; hitLayer: 'shield' | 'hull' } {
    return this.shieldHullRouter.damageShipLayered(ship, damage, workerBodyId);
  }

  private damageSwarmLayered(
    rec: { id: string; entityId: number; kind?: number; shipKind?: ShipKindId | null; shieldDown?: boolean },
    damage: number,
  ): { newShield: number; shieldMax: number; hullMax: number; hitLayer: 'shield' | 'hull' } | null {
    return this.shieldHullRouter.damageSwarmLayered(rec, damage);
  }

  private tickShieldRegen(): void {
    this.shieldHullRouter.tickShieldRegen();
  }

  /** The one damage choke point. (hitX, hitY) is where the shot landed,
   *  (dirX, dirY) its direction of travel, `weaponId` what fired it; each is
   *  absent when the path doesn't know it. Returns true iff THIS call
   *  destroyed the target (the router's own `destroyed` result). */
  private applyDamage(
    targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number, dirX?: number, dirY?: number,
    weaponId?: WeaponId,
  ): boolean {
    // A hit on a wreck piece knocks and wears it, one on a rock wears it (rock cut). Only hits
    // that know their point AND direction; missiles push by splash, rams by contact.
    if (this.capitalWrecks !== null && damage > 0 && hitX !== undefined && hitY !== undefined
      && dirX !== undefined && dirY !== undefined) {
      this.capitalWrecks.onWreckHit(targetId, hitX, hitY, dirX, dirY, damage, weaponId, shooterId);
    }
    // Phase 4 warp travel: a ship on its run is out of the world (an NPC's too, W2a).
    if (this.warpTravel.isTravelling(targetId)) return false;
    if (this.livingWorldBotHooks.npcWarps.size > 0 && this.livingWorldBotHooks.botWarpPhase(targetId) === 2) return false;
    // v4 A — alien gates can't be damaged; whoever hits one is disabled.
    if (this.gateGuard.gateCount > 0 && this.gateGuard.isGate(targetId)) {
      if (damage > 0) this.gateGuard.onGateAttacked(targetId, shooterId, this.gameClock.now());
      return false;
    }
    // The weapon's per-target factors (weapon-mounts.md "Per-target damage factors"), and the
    // EFFECTIVE damage they leave: the side effects below see that, so a 0-damage hit is no attack.
    const layerMul = weaponId === undefined ? undefined
      : weaponLayerMul(getWeapon(weaponId), this.structureRegistry.get(targetId) !== undefined, this._layerMul);
    const eff = this.damageRouter.effectiveDamage(targetId, damage, layerMul);
    // RTS slice 5: a wingman's hit is its OWNER's act for standing / economy.
    const hitActor = eff > 0 && this.fleet.size > 0 ? this.wingmen.hostileActorOf(shooterId) : shooterId;
    if (eff > 0) { this.hitStanding.noteEconomicHit(targetId, hitActor); this.hitStanding.noteStandingHit(targetId, hitActor); }
    // An NPC's own hit on a pilot keeps it hostile (owner 2026-11-12).
    if (eff > 0 && this.playerToSlot.has(targetId)) this.refreshNpcAttackHostility(shooterId, targetId);
    // C2 — a hit ends the target's break-in (one Map lookup when none).
    if (eff > 0 && this.breakIns.activeCount() > 0) this.breakIns.onActorDamaged(targetId);
    // R2.18 — a Shield Pylon is undamageable while its wall is up: route the hit
    // into an active wall (drains the grid/batteries, can stun it) and skip the
    // pylon damage entirely (no damage event for the pylon). This single choke
    // point funnels EVERY damage source — player/AI beams, turrets, projectiles,
    // AND ramming (SectorRoom.ts ram-contact path) — so the pylon is protected
    // against all of them while any of its walls is up. Wall stun timing is
    // wall-clock (Date.now), matching every other shieldWalls call site.
    if (eff > 0) {
      const s = this.structureRegistry.get(targetId);
      if (s !== undefined && isNpcOwner(s.owner)) {
        // B2 — a player (or a player's turret) hitting an NPC base makes that
        // player hostile to the base: its turrets engage, its gates close.
        const actor = hitActor !== shooterId || this.playerToSlot.has(shooterId)
          ? hitActor
          : this.structureRegistry.get(shooterId)?.owner;
        if (actor !== undefined && !isNpcOwner(actor)) this.hostileActs.record(actor, s.owner, this.gameClock.now());
      }
      if (s !== undefined) {
        // Audit "your base is under attack" — throttled to one record per
        // structure per window (a sustained beam mustn't firehose the log).
        // Steady-state: Map.get + compare, no allocation (invariant #14); only
        // a fresh first-hit allocates. Fires for ANY structure hit, including a
        // pylon whose wall absorbs it just below.
        const now = this.gameClock.now();
        const last = this.structureAttackAuditAtMs.get(targetId) ?? -Infinity;
        if (now - last >= STRUCTURE_ATTACK_AUDIT_WINDOW_MS) {
          this.structureAttackAuditAtMs.set(targetId, now);
          auditEvent({
            event: 'structure_attacked',
            sector: this.sectorKey ?? undefined,
            owner: s.owner,
            kind: s.kind,
            attackerId: shooterId,
            attackerKind: classifyAttacker(shooterId, this.swarmRegistry),
          });
        }
        // PWA push — alert the OFFLINE owner's device(s) that their base is
        // under attack. Separate, much longer throttle than the audit above;
        // scalars only — the notifier does the offline gate + DB read + send
        // asynchronously, off the tick (invariant #14). No-op when push is
        // disabled (no VAPID keys) or the owner is currently connected.
        const lastPush = this.structureAttackPushAtMs.get(targetId) ?? -Infinity;
        if (now - lastPush >= STRUCTURE_ATTACK_PUSH_WINDOW_MS) {
          this.structureAttackPushAtMs.set(targetId, now);
          pushNotifier.onStructureAttacked(s.owner, s.kind, classifyAttacker(shooterId, this.swarmRegistry), this.sectorKey ?? undefined);
        }
        // R2.18 — a Shield Pylon is undamageable while its wall is up: route the
        // hit into an active wall and skip the pylon damage entirely.
        if (s.kind === 'shield_pylon'
          && this.shieldWalls.absorbForPylon(targetId, eff, this.gameClock.now())) {
          return false;
        }
      }
    }
    // S2a — remember the last hit on a capital (point, damage, recent rate)
    // before it lands, so its death knows where and how hard it was hit.
    if (this.capitalWrecks !== null && eff > 0) {
      this.capitalWrecks.noteHit(targetId, shooterId, eff, hitX, hitY, dirX, dirY, weaponId);
    }
    // RTS Part B slice 4: a hit on an owned hull goes through the shared AI's
    // ledgers: retaliation (`markHostile`, before the hit: a killing blow still
    // turns its squad) and morale data (after: the HULL the hit took, never
    // what the shield soaked; RTS take 2026-11-14).
    const ownedHullBefore = damage > 0 && this.fleet.size > 0 && this.fleet.isAttached(targetId)
      ? this.state.ships.get(targetId)?.health ?? -1
      : -1;
    if (ownedHullBefore >= 0) this.fleetHooks.ownedHullRetaliates(targetId, shooterId);
    // Slice 10: a hit on the ship a pilot flies turns its squad and escorts.
    else if (damage > 0 && this.fleet.size > 0 && this.playerToSlot.has(targetId)) this.fleetHooks.ownedHullRetaliates(targetId, shooterId);
    const destroyed = this.damageRouter.apply(targetId, shooterId, damage, hitX, hitY, layerMul);
    if (ownedHullBefore >= 0) this.fleetHooks.noteOwnedHullDamage(targetId, ownedHullBefore);
    return destroyed;
  }

  /** Wreck spawns: which kinds break here, a dying hull's break-up and the
   *  wreck-field chunk source (`features/wreckSpawns.ts`). */
  private readonly wreckSpawns = new RoomWreckSpawns({
    logger, swarmRegistry: this.swarmRegistry, forceFields: this.forceFields, shipPoseCache: this.shipPoseCache,
    capitalWrecks: () => this.capitalWrecks, capitalWrecksOn: () => this.capitalWrecksOn, subcapWrecksOn: () => this.subcapWrecksOn,
    persistSector: () => this.persistSector, sectorKey: () => this.sectorKey, sabF32: () => this.sabF32, sabU32: () => this.sabU32,
    playerToSlot: () => this.playerToSlot, getActiveShip: (pid) => this.getActiveShip(pid), postToWorker: (cmd) => this.postToWorker(cmd), structureRegistry: this.structureRegistry,
  });

  /** LoadShedder: can ANY connected player see this drone? The same view the
   *  swarm broadcast uses: each client's interest window (`interestScratch`,
   *  built by `SwarmBroadcaster` this tick or the last). A client with no
   *  slot (spectating after parking a hull, between hulls, still joining) is
   *  sent the whole swarm at full fidelity, so it sees everything; so does a
   *  client whose window isn't built yet. Shedding only what nobody sees keeps
   *  it invisible (soak 2026-11-14). Alloc-free (#14). */
  private droneInAnyView(rec: SwarmEntityRecord): boolean {
    const clients = this.clients;
    for (let i = 0; i < clients.length; i++) {
      const sid = clients[i]!.sessionId;
      const pid = this.sessionToPlayer.get(sid);
      if (pid === undefined || !this.playerToSlot.has(pid)) return true;
      const view = this.interestScratch.get(sid);
      if (view === undefined || view.has(rec.entityId)) return true;
    }
    return false;
  }

  /** Iterates positions of currently-alive players, for the LoadShedder.
   *  Skips dead ships so a corpse doesn't anchor far drones in place. Pose
   *  comes from `shipPoseCache` (the SAB mirror) — the schema no longer
   *  carries spatial fields. */
  private *alivePlayerPositions(): IterableIterator<{ x: number; y: number }> {
    // Phase 6b — schema key is shipInstanceId, but shipPoseCache is still
    // playerId-keyed (Option A residual), so we read pose via ship.playerId.
    for (const [, ship] of this.state.ships) {
      if (!ship.alive) continue;
      if (!ship.isActive) continue;
      const pose = this.shipPoseCache.get(ship.playerId);
      if (!pose) continue;
      yield { x: pose.x, y: pose.y };
    }
  }

  /**
   * Spawn scrap from a HULL that is leaving the world (Equinox P6.3) — a
   * composite-kind hull (e.g. havok) yields one scrap body per component;
   * polygon kinds (fighter/scout/…) yield nothing. The single guard+spawn used
   * by EVERY hull-removal path that has a pose in hand: the lingering-hull death
   * policy (`spawnScrapFromLingeringHull` LeafDeps seam), and the abandon paths
   * (`abandonShipToScrap` / `abandonLingeringHullToScrap`). Mirrors the drone
   * (`ScrapSpawner.spawnScrapFromDrone`) + active-hull (`SHIP_DESTROYED`) scrap paths.
   */
  private spawnHullScrap(
    kind: ShipKindId,
    pose: { x: number; y: number; vx: number; vy: number; angle: number },
    shipInstanceId: string,
  ): void {
    if (shipScrapGroups(kind).length === 0) return; // polygon kind ⇒ no scrap
    this.scrapSpawner.spawnFromDeath(
      kind,
      { x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy, angle: pose.angle },
      `scrap-${shipInstanceId}`,
    );
  }

  /**
   * Tear down a swarm entity. Combat kills pass `broadcast: true` so the client
   * flashes destruction and the kill-feed/SFX path runs. Phase 6 LoadShedder
   * passes `broadcast: false` so eviction for budget is invisible to players —
   * an explosion on a 5000-unit-distant drone would be confusing diegetically.
   * The `ENTITY_SHED` bus channel (separate from `ENTITY_DESTROYED`) lets
   * persistence/telemetry distinguish the two.
   */
  private evictSwarmEntity(
    rec: SwarmEntityRecord,
    opts: { broadcast: boolean; emitDestroyed: boolean; shooterId?: string; vaporised?: boolean },
  ): void {
    // A turret's kill mid-tick must not leave the evicted drone selectable by
    // the next turret in the same tick (the linear scan never saw it).
    this.turretTargeting.turretTargetGridFresh = false;
    this.turretTargeting.npcTargetGridFresh = false;
    // P3c — a removed shooter's pending charge never fires.
    this.aiFireResolver.forget(rec.id);
    this.capitalWrecks?.forget(rec.id);
    // S2b: a wreck piece leaving the world may retire its wreck's descriptor.
    if (isWreckPiece(rec)) this.capitalWrecks?.pieceGone(rec.id);
    this.npcLocks.forgetNpc(rec.id);
    // v4 A — its slot may be reused; a new ship must not inherit a disable.
    if (this.gateGuard.gateCount > 0) this.gateGuard.forget(rec.id);
    // Gameplay audit log — record a REAL combat death (the `emitDestroyed`
    // signal that fires the kill-feed + bus ENTITY_DESTROYED; load-shedder /
    // quiet bot despawn / abandon use emitDestroyed:false and are excluded).
    // Done HERE, before the structureRegistry.remove below, so the structure's
    // owner/kind/pose are still resolvable. Discrete boundary, off the per-tick
    // path (invariant #14). See src/server/audit/GameplayAuditLog.ts.
    if (opts.emitDestroyed) {
      auditCombatDestruction(this.combatAuditHost, rec, opts.shooterId);
    }
    // Structures plan, Phase 3 — a destroyed structure must sever its grid
    // connections (StructureRegistry.remove disconnects) so the web doesn't
    // keep a dangling edge. Idempotent: harmless if `rec` isn't a structure or
    // was already removed (e.g. by placement.remove / deconstruction).
    if (this.structureRegistry.has(rec.id)) {
      // Living World P1a-2 — a storage structure leaving the world (razed OR
      // deconstructed) spills its whole payload where it stood, or just clear
      // of its wreck pieces when it broke up (structureSpill.ts).
      const srec = this.structureRegistry.get(rec.id);
      if (srec) {
        const at = structureSpillPoint(srec, opts.emitDestroyed && opts.vaporised !== true && this.wreckSpawns.structureWreckSourceOf(rec.id) !== null);
        const payload = this.storage.takeForSpill(srec);
        if (payload !== null) this.loot.drop(payload, at.x, at.y, 0, 0, { cause: opts.emitDestroyed ? 'razed' : 'removed' });
        // P2b — a processor's (unbound) blueprint spills too.
        const slot = this.storage.takeSlotForSpill(srec);
        if (slot !== null) this.loot.drop(slot, at.x, at.y, 0, 0, { cause: opts.emitDestroyed ? 'razed' : 'removed' });
        // v4 T1 — a teleporter's pad hold spills, and its partner is unpaired.
        const pad = this.storage.takePadForSpill(srec);
        if (pad !== null) this.loot.drop(pad, at.x, at.y, 0, 0, { cause: opts.emitDestroyed ? 'razed' : 'removed' });
        this.teleporters.onRemoved(srec);
        // Economy v2 W3 — a lab's running job spills its blueprints too.
        const labSpill = this.researchLabs.onRemoved(srec);
        if (labSpill !== null) this.loot.drop(labSpill, at.x, at.y, 0, 0, { cause: opts.emitDestroyed ? 'razed' : 'removed' });
      }
      this.structureRegistry.remove(rec.id);
      if (opts.emitDestroyed && srec) leavePlateBlueprint(this.state.deck, srec, this.structurePlacement); // a destroyed plate anchor leaves a blueprint (base platforms 9)
      this.structureAttackAuditAtMs.delete(rec.id);
      this.structureAttackPushAtMs.delete(rec.id);
      this.rebuildStructuresSlice();
    }
    // Scrap-on-death (Phase 2b-ii) — a SCRAP entity (kind 3) leaving the world
    // (combat death OR FIFO cap) must drop out of the ScrapSpawner's live list
    // so the global cap accounting stays correct. Harmless no-op when this
    // eviction IS the FIFO path (the id was already shifted off the list).
    // Living World P1a — a combat-killed NPC drops its loot where it died (the
    // SAB pose is still live here; the evictor below frees the slot). A cargo
    // pod has no health, so combat never evicts one: only the LootSubsystem
    // despawns pods (emptied / TTL).
    if (opts.emitDestroyed && rec.kind === SWARM_KIND_DRONE) {
      this.npcLoot.dropKillLoot(rec, opts.shooterId, opts.vaporised === true);
    }
    // C3 — an NPC loot hold (memory only) goes with its ship. Trade and convoy
    // haulers keep theirs: their cargo travels with them between sectors.
    if (rec.kind === SWARM_KIND_DRONE && !isHaulerId(rec.id) && getHoldStore().get(rec.id)?.holderType === 'hauler') {
      getHoldStore().delete(rec.id, false);
    }
    if (rec.kind === SWARM_KIND_DRONE) this.npcLoot.forget(rec);
    if (rec.kind === SWARM_KIND_SCRAP) {
      this.scrapSpawner.notifyRemoved(rec.id);
    }
    this.swarmEvictor.evict(rec, opts);
  }


  /** The 1 Hz grid pulse (body: `StructuresSliceSync.gridTick`, `structuresSlice.ts`). */
  private structureGridTick(): void { this.structuresSliceSync.gridTick(); }

  /** Structures plan (Phase 3-5) — seed a testMode scenario: PRE-BUILT,
   *  auto-connected structures (owner `scenario`) + parked drones + asteroids.
   *  Gives E2E a fully-functional powered grid without the place-ahead UI
   *  (which overlaps stacked placements) or the construction wait.
   *  testMode structure scenario seeding (`scenarioLayouts.seedStructureScenario`). */
  private readonly structureScenarioHost: StructureScenarioHost = {
    structureRegistry: this.structureRegistry, logger, structurePlacement: () => this.structurePlacement,
    teleporters: () => this.teleporters, swarmSpawner: () => this.swarmSpawner, swarmHealth: () => this.swarmHealth,
    swarmShield: () => this.swarmShield, structureGridTick: () => this.structureGridTick(),
  };

  /** Boot seeding of NPC structures: galaxy / test bases (`bases/NpcBaseSubsystem.ts`),
   *  alien gates and pocket pads (`structures/TeleporterSubsystem.ts`). */
  private readonly npcSeedHost: NpcBaseSeedHost & NpcGateSeedHost = {
    structureRegistry: this.structureRegistry, swarmRegistry: this.swarmRegistry, lingeringPoseCache: this.lingeringPoseCache,
    patrols: this.patrols, obstacles: this.obstacles, gateGuard: this.gateGuard, logger,
    sabF32: () => this.sabF32, structurePlacement: () => this.structurePlacement, teleporters: () => this.teleporters,
    swarmHealth: () => this.swarmHealth, sectorKey: () => this.sectorKey,
    evictSwarmEntity: (rec, opts) => this.evictSwarmEntity(rec, opts),
    structureGridTick: () => this.structureGridTick(), rebuildStructuresSlice: () => this.rebuildStructuresSlice(),
  };

  /** The sector snapshot's room side: its scrap / lingering-hull rows and the
   *  structure / scrap / lingering-hull restores (`SectorSnapshotRestore.ts`). */
  private readonly snapshotRestore = new SectorSnapshotRestore({
    state: () => this.state, structurePlacement: () => this.structurePlacement, storage: () => this.storage,
    swarmHealth: () => this.swarmHealth, loot: () => this.loot, sabF32: () => this.sabF32, swarmSpawner: () => this.swarmSpawner,
    freeSlots: () => this.freeSlots, sectorKey: () => this.sectorKey, serverTick: () => this.serverTick, wingmen: () => this.wingmen,
    structureRegistry: this.structureRegistry, swarmRegistry: this.swarmRegistry, lingeringSlots: this.lingeringSlots,
    lingeringPoseCache: this.lingeringPoseCache, ownerlessShips: this.ownerlessShips, snapshotRing: this.snapshotRing,
    fleet: this.fleet, logger, structureGridTick: () => this.structureGridTick(),
    shipHullMax: (kindMax, alloc, id) => this.shipHullMax(kindMax, alloc, id), postToWorker: (cmd) => this.postToWorker(cmd),
    applyStatMulToWorker: (bodyKey, alloc) => this.shipProgression.applyStatMulToWorker(bodyKey, alloc),
  });

  /** Phase 5 — the turret aim/fire tick (body: `StructuresSliceSync.turretTick`, `structuresSlice.ts`). */
  private structureTurretTick(): void { this.structuresSliceSync.turretTick(); }

  /** Gates: every ACTIVE player ship (#17 — lingering hulls are parked and
   *  never open gates), into the controller's reused buffer. */
  /** Shield-fence plan — beam-vs-wall absorption seam shared by the player + AI
   *  hitscan resolvers. If an ACTIVE shield wall lies along the shot ray within
   *  `maxDist`, the wall takes the hit (grid-power model) and the shot stops
   *  there; returns the crossing distance, else null. (Ship blocking is the
   *  worker's static wall body — this is only the main-thread weapon path.) */
  private blockShotAtWall(
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, damage: number,
  ): number | null {
    return this.shieldWalls.blockShot(fromX, fromY, dirX, dirY, maxDist, damage, this.gameClock.now());
  }

  /** Phase 4 — nearest mineable asteroid (swarm kind 0) within `range` of
   *  (x, y). Reads authoritative poses from the SAB via each record's slot
   *  (asteroids are static, so this is their spawn pose). Low-frequency (1 Hz
   *  pulse), so the linear scan is fine. */
  private findNearestAsteroid(
    x: number,
    y: number,
    range: number,
  ): { id: string; entityId: number; x: number; y: number; radius: number } | null {
    // WS-4 / R2.27 — skip EXHAUSTED asteroids (resources<=0) so a Miner
    // auto-retargets to a rock that still has ore (and its mining beam stops on
    // the dead rock). `resources===undefined` ⇒ available (un-seeded / legacy).
    return this.findNearestSwarmOfKind(x, y, range, 0, this._asteroidNotExhausted);
  }

  /** Stable (alloc-once) predicate: an asteroid is mineable while its finite
   *  resource pool is non-empty. Class field so `findNearestAsteroid` doesn't
   *  allocate a closure per call (it runs per-miner per grid-pulse). */
  private readonly _asteroidNotExhausted = (rec: SwarmEntityRecord): boolean =>
    rec.resources === undefined || rec.resources > 0;

  /** WS-4 Phase 3 / R2.27 — apply the mining beam's light player-damage RAY:
   *  any ACTIVE player ship whose pose intersects the miner→asteroid segment
   *  (widened by `MINING_BEAM_HALF_WIDTH`) takes `perHit` via the standard
   *  applyDamage path, attributed to the Miner. A thin damage ray, NOT a
   *  physics collider — movement is unblocked. Low-frequency (mining-beam
   *  cadence, off the 60 Hz tick); the scalar point-to-segment test allocates
   *  nothing. */
  private damagePlayersInMiningBeam(
    minerId: string,
    fromX: number, fromY: number, toX: number, toY: number,
    perHit: number,
  ): void {
    const shipR = SHIP_COLLISION_RADIUS; // shared broad-phase radius (campaign 5.3)
    for (const [playerId] of this.playerToSlot) {
      const ship = this.getActiveShip(playerId);
      if (!ship || !ship.alive || !ship.isActive) continue;
      const pose = this.shipPoseCache.get(playerId);
      if (!pose) continue;
      if (playerInMiningBeam(fromX, fromY, toX, toY, pose.x, pose.y, shipR, MINING_BEAM_HALF_WIDTH)) {
        this.applyDamage(playerId, minerId, perHit);
      }
    }
  }

  /** Nearest swarm entity of `swarmKind` (0=asteroid, 1=drone) within `range`
   *  of (x, y). Reads authoritative poses from the SAB via each record's slot.
   *  Low-frequency (1 Hz pulse / 100 ms turret tick), so the linear scan is
   *  fine. Returns the registry id (for damage) + entityId + pose. */
  /** Allegiances P0 — a player structure turret engages any swarm combatant
   *  that is not NEUTRAL to players by stance... except it also engages drones,
   *  which are stance-neutral but wave-hostile (pre-P0 behaviour: turrets shoot
   *  every drone). So: everything except traders. Built once (no per-call alloc). */
  private readonly _isTurretTargetable = (rec: SwarmEntityRecord): boolean =>
    allegianceOfKind(rec.shipKind) !== 'traders';

  /** A1/B2/C2 — structure-turret targeting (`features/turretTargeting.ts`). */
  private readonly turretTargeting = new TurretTargeting({
    swarmRegistry: this.swarmRegistry, sabF32: () => this.sabF32, playerToSlot: () => this.playerToSlot,
    getActiveShip: (pid) => this.getActiveShip(pid), shipPoseCache: this.shipPoseCache, spectateParkedHull: this.spectateParkedHull,
    engageablePilotHull: (pid) => this.pilotSwap.engageablePilotHull(pid), visitParkedPilotHulls: (visit) => this.pilotSwap.visitParkedPilotHulls(visit),
    relationCtx: this.relationCtx, hostileActs: this.hostileActs, isTurretTargetable: this._isTurretTargetable,
    structureRegistry: this.structureRegistry, npcHostileTo: (e, p) => this.npcHostileTo(e, p),
    writeSwarmRangeShape: (v, rec) => this.writeSwarmRangeShape(v, rec), npcSideParty: NPC_SIDE_PARTY,
    policyOf: ROOM_POLICY, gridBounds: DRONE_MAX_BOUNDS,
  });
  /** Mine Layers — spot check and blast (`features/mineHooks.ts`). */
  private readonly mineHooks = new MineHooks({
    structureRegistry: this.structureRegistry, swarmRegistry: this.swarmRegistry, sabF32: () => this.sabF32,
    mineField: () => this.mineField, applyDamage: (t, s, d, x, y) => this.applyDamage(t, s, d, x, y),
    broadcast: (type, msg) => { this.broadcast(type, msg); },
  });
  /** P3c — robot harvesters raid a player's storage (`features/tradeMessages.ts`). */
  private readonly storageRaid = new StorageRaid({
    storage: () => this.storage, sectorKey: () => this.sectorKey, now: () => this.gameClock.now(),
    tradeTransfer: (o, u, s) => this.tradeTransfer(o, u, s), tradeNotify: (p, n) => { this.tradeNotify(p, n); },
  });

  /** A swarm entity's hit shape for the turrets' hull range gate
   *  (`mountInReach`): a ship by kind, heading and shield, else its radius. */
  private writeSwarmRangeShape(
    v: { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] }, rec: SwarmEntityRecord,
  ): void {
    const ship = rec.kind === 1;
    const angle = ship ? this.sabF32[slotBase(rec.slot) + SLOT_ANGLE_OFF]! : 0;
    fillRangeShape(v, angle, ship, rec.shipKind ?? null, ship && !rec.shieldDown, rec.radius);
  }


  private sendToPlayerHere(pid: string, type: string, msg: unknown): boolean {
    const sid = this.playerToSession.get(pid);
    if (!sid) return false;
    const c = this.clients.find((x) => x.sessionId === sid);
    if (!c) return false;
    c.send(type, msg);
    return true;
  }

  /**
   * testMode `lockTimeCapS`: from now on no NON-player lock in this room takes
   * longer than `capS` seconds (NPC drones and capitals on pilots, capital
   * turrets on structures, structure and coastal turrets). Locks are still
   * acquired (#19); only their time is capped. Player locks keep their own
   * trigger (`instantLock`).
   */
  private setLockTimeCap(capS: number): void {
    this.testLockTimeCapS = capS;
    this.structureGrid.setTurretLockTimeCap(capS);
    logger.info({ roomId: this.roomId, lockTimeCapS: capS }, 'lockTimeCapS on (test trigger)');
  }

  /** Game time scale — chosen speed, load slowdown, glide, keyframe (`features/sectorTimeScale.ts`). */
  private readonly timeScale = new SectorTimeScale({
    gameClock: this.gameClock, tickBudget: this.tickBudget, perfFixedLoad: () => this.perfFixedLoad,
    roomId: () => this.roomId, sectorKey: () => this.sectorKey, logger,
  });
  /** Set this sector's game speed (`SectorTimeScale.setTimeScale`); returns the speed now in force. */
  setTimeScale(scale: number, smooth = false): number { return this.timeScale.setTimeScale(scale, smooth); }

  /** `/dev/time-scale`: this room's sector key (null for engineering rooms). */
  timeScaleSectorKey(): string | null { return this.sectorKey; }

  private findNearestSwarmOfKind(
    x: number,
    y: number,
    range: number,
    swarmKind: number,
    filter?: (rec: SwarmEntityRecord) => boolean,
  ): { id: string; entityId: number; x: number; y: number; radius: number } | null {
    let best: { id: string; entityId: number; x: number; y: number; radius: number } | null = null;
    let bestD2 = range * range;
    for (const rec of this.swarmRegistry.all()) {
      if (rec.kind !== swarmKind) continue;
      if (filter && !filter(rec)) continue;
      const base = slotBase(rec.slot);
      const sx = this.sabF32[base + SLOT_X_OFF]!;
      const sy = this.sabF32[base + SLOT_Y_OFF]!;
      const dx = sx - x;
      const dy = sy - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { id: rec.id, entityId: rec.entityId, x: sx, y: sy, radius: rec.radius };
      }
    }
    return best;
  }

  /** Rebuild the cached structures snapshot slice from the registry + grid.
   *  Called at the 1 Hz pulse and after each placement/removal — never on the
   *  60 Hz tick, so the array allocation here is off the hot loop. */
  /** A2 — sync `state.structures` + the slim targets slice (body: `structuresSlice.ts`). */
  private rebuildStructuresSlice(): void { this.structuresSlice = this.structuresSliceSync.rebuild(); }

  /** Intern a structure owner into the sector's owner tables (owners are few;
   *  the table only grows). Refreshes the display name when it resolves. */
  private internStructureOwner(owner: string): number {
    const st = this.state as SectorState;
    let idx = this.structureOwnerIdx.get(owner);
    if (idx === undefined) {
      idx = this.structureOwnerIdx.size;
      this.structureOwnerIdx.set(owner, idx);
      this.structureOwnerKeys[idx] = String(idx);
      st.structureOwners.set(this.structureOwnerKeys[idx]!, owner);
    }
    const key = this.structureOwnerKeys[idx]!;
    const name = this.rosterPersistence.resolveOwnerName(owner) ?? '';
    if (st.structureOwnerNames.get(key) !== name) st.structureOwnerNames.set(key, name);
    return idx;
  }

  // ── Living World Director hooks ─────────────────────────────────────────
  // Thin, data-level surface the process-global LivingWorldDirector drives.
  // Everything here REUSES existing swarm machinery (swarmSpawner /
  // evictSwarmEntity / aiController). Bots are server-internal swarm
  // entities, NOT Colyseus clients — they never touch onJoin / Limbo /
  // reserveSeatFor; the director performs the cross-room hop directly.

  /** Live player count + per-sector counts for the director (bodies in `sectorLiveCounts.ts`). */
  playerCount(): number { return sectorPlayerCount(this.liveCountsHost); }
  liveCounts(): SectorLiveCounts { return sectorLiveCounts(this.liveCountsHost); }

  /** Equinox Phase 9 (item 5) — recent-combat tally for `/galaxy/snapshot` (the
   *  galaxy-map "fighting happened here" icon + drawer breakdown), or null when
   *  quiet. Read by the LivingWorldDirector on its ~1.5 s control tick. */
  recentCombat(): RecentCombat | null {
    return this.recentCombatLog.summary(this.gameClock.now());
  }

  /** Equinox Phase 7 — count of structures in THIS room owned by `playerId`
   *  (the galaxy-map per-player "my structures" overlay; `GET /galaxy/presence`).
   *  Off the 60 Hz tick — called at the ~4 s presence poll. */
  ownedStructureCount(playerId: string): number {
    let n = 0;
    for (const rec of this.structureRegistry.all()) {
      if (rec.owner === playerId) n++;
    }
    return n;
  }

  /** Whether a SAB slot is free for one more swarm entity. The director
   *  pre-checks this on the DESTINATION before despawning a bot from the
   *  source room, so a transit can't lose a bot to slot exhaustion. */
  hasFreeSlot(): boolean {
    return this.freeSlots.length > 0;
  }

  /** Narrow read accessor onto this room's per-process event bus, so the
   *  process-global LivingWorldDirector can subscribe to `ENTITY_DESTROYED`
   *  (combat kill → respawn) / `ENTITY_SHED` (load-shed → pause) for its
   *  bots without the room exposing its whole surface. */
  eventBus(): Bus {
    return this.bus;
  }

  /** Living World bot spawn (LivingWorldRoom contract): see LivingWorldBotHooks. */
  spawnLivingWorldBot(spec: Parameters<LivingWorldBotHooks['spawnLivingWorldBot']>[0]): boolean { return this.livingWorldBotHooks.spawnLivingWorldBot(spec); }

  /** WS-E #15 — resolve a faction's hostility members here (owning player +
   *  owned structure ids). The director uses this to pre-populate
   *  `spawnLivingWorldBot`'s `hostileToFaction` so an arriving member of an
   *  attacking squad is marked hostile INLINE at spawn (no control-tick gap). */
  factionHostility(factionId: string): { playerId: string; structureIds: readonly string[] } {
    return this.factionLedger.membersOf(factionId);
  }

  despawnLivingWorldBot(botId: string): BotCarry | null {
    return this.livingWorldBotHooks.despawnBot(botId);
  }

  markBotHostile(botId: string): void {
    this.livingWorldBotHooks.markBotHostile(botId);
  }

  /** W2a NPC warp-to (LivingWorldRoom contract): see LivingWorldBotHooks. */
  warpBot(botId: string, x: number, y: number): boolean {
    return this.livingWorldBotHooks.warpBot(botId, x, y);
  }

  /** Morale flee (AI slice 6b): `AiIntent.warpOut`, drained by `runAiTick`
   *  (LivingWorldBotHooks.warpOut). A bound field so the per-tick ctx
   *  carries no new closure. */
  private readonly _handleAiWarpOut = (botId: string, x: number, y: number): void => {
    this.livingWorldBotHooks.warpOut(botId, x, y);
  };

  /** A bot's NPC warp phase: 1 spool, 2 run, 3 just arrived, 0 none. */
  botWarpPhase(botId: string): 0 | 1 | 2 | 3 {
    return this.livingWorldBotHooks.botWarpPhase(botId);
  }

  /** Roaming-formation (Phase 5) — live SAB pose of a living-world bot here. */
  getBotPose(botId: string): { x: number; y: number; angle: number } | null {
    const rec = this.swarmRegistry.get(botId);
    if (!rec) return null;
    const b = slotBase(rec.slot);
    return {
      x: this.sabF32[b + SLOT_X_OFF]!,
      y: this.sabF32[b + SLOT_Y_OFF]!,
      angle: this.sabF32[b + SLOT_ANGLE_OFF]!,
    };
  }

  /** Living World P4a — promote a just-spawned bot to a NAMED ELITE: its hull
   *  max becomes ELITE_HEALTH_MUL × its kind's and it is healed to full. */
  /**
   * Living World P4c — pay a named target's bounty into the killer's WALLET
   * (economy v2: credits are virtual — every player, guests included).
   * Announced to the sector as a `world_notice`.
   */
  private payEliteBounty(killerId: string, targetName: string, credits: number): void {
    if (credits <= 0 || classifyAttacker(killerId, this.swarmRegistry) !== 'player') return;
    getWallet().credit(killerId, credits, 'elite_bounty');
    auditEvent({ event: 'bounty_claimed', sector: this.sectorKey ?? undefined, playerId: killerId, target: targetName, credits });
    const who = this.rosterPersistence.resolveOwnerName(killerId) ?? 'A pilot';
    this.broadcastWorldNotice({
      type: 'world_notice', kind: 'bounty',
      message: `${who} claimed the ${credits}¢ bounty on ${targetName}!`,
    });
  }

  /** P5 — the blueprints fitted to a ship (cached; the hold row is the truth). */
  private fittedOf(shipInstanceId: string): readonly string[] {
    if (shipInstanceId === '') return EMPTY_FITTED;
    let f = this.fittedCache.get(shipInstanceId);
    if (f === undefined) {
      const fh = getHoldStore().get(fittedUid(shipInstanceId))?.hold;
      f = fh ? fittedModuleIds(fh) : EMPTY_FITTED;
      this.fittedCache.set(shipInstanceId, f);
    }
    return f;
  }

  /** P5 — the ship's max hull: kind base × stat upgrades × fitted blueprints. */
  private shipHullMax(kindMax: number, alloc: CoreStatAlloc | undefined, shipInstanceId: string): number {
    // Economy v2 — an unpacked hull's quality adds up to +10 % (roster `hullQuality`).
    const quality = shipInstanceId !== '' ? getPlayerShipStore().get(shipInstanceId)?.hullQuality : undefined;
    return Math.round(effectiveShipMaxHealth(kindMax, alloc) * fittedHullMul(this.fittedOf(shipInstanceId)) * qualityHullFactor(quality));
  }

  /** P5 — destroy a ship's fitted blueprints (it died / was abandoned). */
  private dropFitted(shipInstanceId: string): void {
    if (shipInstanceId === '') return;
    this.fittedCache.delete(shipInstanceId);
    getHoldStore().delete(fittedUid(shipInstanceId), this.sectorKey !== null);
  }

  /** P4b — a world-event reward (cache / salvage pod), as an ordinary loot pod. */
  dropEventLoot(hold: Hold, x: number, y: number): void {
    this.loot.drop(hold, x, y, 0, 0, { cause: 'event' });
  }

  broadcastWorldNotice(notice: WorldNotice): void {
    this.broadcast('world_notice', notice);
  }

  broadcastFactionLook(msg: FactionLookClaimed): void {
    this.broadcast('faction_look_claimed', msg);
  }

  markElite(botId: string, name: string, healthMul = ELITE_HEALTH_MUL, bounty = ELITE_BOUNTY_CREDITS): boolean {
    const rec = this.swarmRegistry.get(botId);
    if (rec == null || rec.kind !== SWARM_KIND_DRONE) return false;
    const maxHealth = (getDroneMaxHealth(rec.shipKind) ?? 40) * healthMul;
    rec.elite = { name, maxHealth, bounty };
    this.swarmHealth.set(botId, maxHealth);
    return true;
  }

  /** Roaming-formation (Phase 5) — assign a bot's in-sector move target. The
   *  drone's IDLE `HostileDroneBehaviour` flies to it (arrive ramp). No-op for a
   *  bot with no behaviour registered here (e.g. mid-transit). */
  setBotMoveTarget(botId: string, x: number, y: number): void {
    this.aiController.getBehaviour(botId)?.setMoveTarget?.(x, y);
  }

  /** Give a bot a guard post (the area it defends): a capital fights from it
   *  instead of holding its gun stand-off. `anchorId`: the post follows that
   *  ship (an escort's zone round its flagship). No-op for a bot with no
   *  behaviour registered here (e.g. mid-transit). */
  setBotGuardPost(botId: string, x: number, y: number, radius: number, anchorId?: string): void {
    this.aiController.getBehaviour(botId)?.setGuardPost?.(x, y, radius, anchorId ?? null);
  }

  /** Leader-led flocking (non-combat herding) — mark a bot a FOLLOWER of
   *  `leaderId` (the squad's member ids drive the separation rule). No-op for a
   *  bot with no behaviour registered here (e.g. mid-transit). */
  setBotFlockFollow(botId: string, leaderId: string, memberIds: readonly string[]): void {
    this.aiController.getBehaviour(botId)?.setFlockFollow?.(leaderId, memberIds);
  }

  /** Leader-led flocking — assign a bot the squad LEADER's throttled course. The
   *  drone's IDLE `HostileDroneBehaviour` cruises to it slower than its followers
   *  (so the herd tightens). No-op for a bot with no behaviour registered here. */
  setBotFlockLeaderCourse(botId: string, x: number, y: number): void {
    this.aiController.getBehaviour(botId)?.setFlockLeaderCourse?.(x, y);
  }

  /** Leader-led flocking — write a swarm entity's LIVE SAB pose into a CALLER-
   *  owned buffer (false if it's gone). The drone AI's `resolveEntityInto` seam:
   *  a follower reads its leader's + neighbours' live poses each tick. Distinct
   *  from `swarmEntitySnapshot` (which returns a SHARED scratch the brain's
   *  `self` aliases — writing here must not clobber that). */
  swarmEntityPoseInto(id: string, out: AiEntityPoseOut): boolean {
    const rec = this.swarmRegistry.get(id);
    if (!rec) return false;
    const b = slotBase(rec.slot);
    out.x = this.sabF32[b + SLOT_X_OFF]!;
    out.y = this.sabF32[b + SLOT_Y_OFF]!;
    out.vx = this.sabF32[b + SLOT_VX_OFF]!;
    out.vy = this.sabF32[b + SLOT_VY_OFF]!;
    out.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
    out.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
    return true;
  }

  /** Wave-system Phase 4 — the WaveDirector's base-readiness poll (`FactionLedger.baseReadiness`). */
  factionBaseReadiness(): FactionBaseReadiness[] { return this.factionLedger.baseReadiness(this.baseReadinessHost); }
  private readonly baseReadinessHost: BaseReadinessHost = {
    sectorKey: () => this.sectorKey, serverTick: () => this.serverTick, waveNeedsOwner: () => this.waveNeedsOwner,
    ownerPresent: (id) => this.getActiveShip(id)?.isActive === true,
    broadcastBaseReady: (factionId, sectorKey) => this.broadcast('base_ready', { type: 'base_ready', factionId, sectorKey }),
  };

  /** Wave-system Phase 4 — set/clear a faction's active-wave flag (gates the
   *  drone-AI structure-target visibility built in `fillStructureTargets`). */
  setFactionUnderWave(factionId: string, underWave: boolean): void {
    this.factionLedger.setUnderWave(factionId, underWave);
  }

  /** Wave-system Phase 4 — mark a squad's bots hostile to a whole faction
   *  (player + owned structures). Re-pulsed each control tick while attacking. */
  markSquadHostileToFaction(botIds: readonly string[], factionId: string): void {
    const members = this.factionLedger.membersOf(factionId);
    for (const botId of botIds) {
      this.livingWorldBotHooks.markBotHostileToFaction(botId, members.playerId, members.structureIds);
    }
  }

  /**
   * Wave-system reactive escalation (req #5). A drone was just damaged by
   * `sourceId`. If the source belongs to a faction (a player who owns a base
   * here, or one of their structures — e.g. a turret), the WHOLE faction
   * becomes hostile to drones: flip the ledger (+ reset the peaceful timer) so
   * the faction's structures enter the drone-AI target view, and mark THIS drone
   * hostile to the entire faction (player + owned structures) so it engages the
   * base it was provoked by — not just the single shooter. A drone-on-drone hit
   * (`factionOf` → null) escalates nothing (the C3 self-aggro gate). Bounded:
   * one `factionOf` scan + one faction-mark per applied drone hit.
   */
  /**
   * Friendly fire (owner decision 2026-11-10) — is this hit on NPC `victimId`
   * an accident from its own side? True when the source is an NPC ship of a
   * FRIENDLY allegiance (same side) or an NPC base's structure that is not
   * hostile to the victim's side. Such a hit still lands, but marks nothing
   * hostile and escalates no faction (`swarmDamageStrategy`), so a pack never
   * civil-wars after a stray shot. Players and player structures are never
   * "friendly fire": their hits mark as before. Two Map lookups per hit.
   */
  private isFriendlyFire(victimId: string, sourceId: string): boolean {
    const victim = this.swarmRegistry.get(victimId);
    if (victim == null || victim.kind !== SWARM_KIND_DRONE) return false;
    const side = allegianceOfKind(victim.shipKind);
    const src = this.swarmRegistry.get(sourceId);
    if (src == null) return false;
    if (src.kind === SWARM_KIND_DRONE) return isFriendly(side, allegianceOfKind(src.shipKind));
    if (src.kind === 2) {
      const owner = this.structureRegistry.get(sourceId)?.owner;
      return owner !== undefined && isNpcOwner(owner)
        && relationOf(NPC_SIDE_PARTY[side], owner, this.relationCtx) !== 'hostile';
    }
    return false;
  }

  private escalateFactionOnDroneHit(droneId: string, sourceId: string, atTick: number): void {
    // Allegiances P0 (hostile-review B1): the FactionLedger tracks war with the
    // DRONES. Shooting a robot or a trader hauler must not declare war on the
    // drones (the victim itself still retaliates via its own `markHostile`).
    const victim = this.swarmRegistry.get(droneId);
    if (victim != null && allegianceOfKind(victim.shipKind) !== 'drones') return;
    const factionId = this.factionLedger.factionOf(sourceId);
    if (factionId === null) return;
    this.factionLedger.recordFactionDealtDamage(factionId, atTick);
    const members = this.factionLedger.membersOf(factionId);
    this.livingWorldBotHooks.markBotHostileToFaction(droneId, members.playerId, members.structureIds);
  }

  /** Wave-system Phase 6 — drones stand down from a faction: purge its player +
   *  owned structure ids from every drone's hostility set (de-escalation). */
  purgeFactionHostility(factionId: string): void {
    const members = this.factionLedger.membersOf(factionId);
    this.aiController.purgeHostility(members.playerId);
    for (const sid of members.structureIds) this.aiController.purgeHostility(sid);
  }

  /** Wave-system Phase 5 — broadcast a sector-wide warp-in warning to this
   *  room's occupants (one per incoming squad; the client renders the HUD
   *  countdown banner). */
  broadcastWarpWarning(msg: WarpWarningEvent): void {
    this.broadcast('warp_warning', msg);
  }

  /** Phase-4 P0 — clear a pending warp-in warning (the inbound arrived / retreated
   *  / cancelled). Companion to `broadcastWarpWarning`. */
  broadcastWarpWarningClear(msg: WarpWarningClearEvent): void {
    this.broadcast('warp_warning_clear', msg);
  }

  /** Join flow — this room's launches go through the hull gate and pay. */
  private launchCharged(): boolean {
    return this.sectorKey !== null && this.enforceHullGate;
  }

  private handleRespawn(client: Client): void {
    this.respawnHandler.handle(client);
  }

  /** testMode: every drone in the room turns hostile to `playerId` (ledger +
   *  `bot_aggro`). Shared by the `startHostile` join option and `test_aggro`. */
  private markAllDronesHostileTo(playerId: string): void {
    const tick = this.serverTick;
    for (const rec of this.swarmRegistry.all()) {
      if (rec.kind !== 1) continue; // drones only — asteroids stay inert
      this.aiController.markHostile(rec.id, playerId, tick);
      this.broadcast('bot_aggro', {
        type: 'bot_aggro',
        botEntityId: `swarm-${rec.entityId}`,
        targetPlayerId: playerId,
        tick,
      });
    }
  }

  /** NPC / turret ray hits and the drone target shape (`features/rayHits.ts`). */
  private readonly rayHits = new RoomRayHits({
    swarmRegistry: this.swarmRegistry, lingeringSlots: this.lingeringSlots, lingeringPoseCache: this.lingeringPoseCache, shipPoseCache: this.shipPoseCache,
    sabF32: () => this.sabF32, playerToSlot: () => this.playerToSlot, ships: () => this.state.ships, getActiveShip: (pid) => this.getActiveShip(pid),
    pilotSwap: () => this.pilotSwap, writeSwarmRangeShape: (out, rec) => this.writeSwarmRangeShape(out, rec),
  });

  /** NPC line of fire, friendly fire slice 2 (`features/npcLineOfFire.ts`). */
  private readonly lineOfFire = new NpcLineOfFire({
    swarmRegistry: this.swarmRegistry, structureRegistry: this.structureRegistry, relationCtx: this.relationCtx, npcSideParty: NPC_SIDE_PARTY,
    sabF32: () => this.sabF32, serverTick: () => this.serverTick, now: () => this.gameClock.now(),
    playerToSlot: () => this.playerToSlot, lingeringSlots: this.lingeringSlots, shipPoseCache: this.shipPoseCache, ships: () => this.state.ships,
    getActiveShip: (pid) => this.getActiveShip(pid),
    playerHitscanDist, swarmRayHit,
    noteBlocked: (id, tick, x, y) => this.aiController.noteBlocked(id, tick, x, y),
    lineHold: () => this.mountTicker.lineHold, wingmen: () => this.wingmen,
  });

  /** Projectile sweep counterpart of playerHitscanDist — same per-kind
   *  bounding-circle (kind.radius + SHIELD_RADIUS_PAD), same shield-up /
   *  shield-down split. Projectiles now impact at the visible shield
   *  boundary on every ship kind, not just fighter. */
  /** The welcome's shell-event fields for a joining client (§5, #16). */
  /** Capital destruction: tell the client this room breaks dying capitals
   *  into wrecks, so it explodes them at the kill point (money-shot review). */
  private wreckWelcomeFields(): WreckWelcomeFields {
    // Each flag on its own: the client holds a dying hull for its pieces only
    // for the profiles this room breaks (sub-cap break-up slices 2 and 4).
    const flags = this.capitalWrecksOn
      ? (this.subcapWrecksOn ? BOTH_WRECK_WELCOME : WRECK_WELCOME)
      : (this.subcapWrecksOn ? SUBCAP_WRECK_WELCOME : NO_WELCOME_FIELDS);
    if (this.capitalWrecks === null) return flags;
    // Sub-capital break-up slice 3: the FULL live wreck set rides the join
    // payload (#16); snapshots carry only adds, removes and a slow resync.
    // `client.send` encodes at once, so the shared slice is safe to attach.
    const live = this.capitalWrecks.descriptors();
    if (live.length === 0) return flags;
    return { ...flags, wrecks: live as import('../../shared-types/messages.js').WreckDescriptor[] };
  }

  private shellWelcomeFields(client: Client, playerId: string): { shellEvents?: true; shellsInFlight?: ShellSalvo[] } {
    if (!this.shellHub) return {};
    const pose = this.shipPoseCache.get(playerId);
    if (!pose) return { shellEvents: true };
    const v = this.shellViewer;
    v.sessionId = client.sessionId;
    v.playerId = playerId;
    v.x = pose.x;
    v.y = pose.y;
    v.half = shellViewHalfExtent(getShipKind(this.getActiveShip(playerId)?.kind ?? null));
    const inFlight = this.shellHub.joinPayload(v);
    return inFlight ? { shellEvents: true, shellsInFlight: inFlight } : { shellEvents: true };
  }

  private playerProjectileSweep(
    ship: ShipState,
    fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
    cx: number, cy: number, angle: number,
  ): { entry: number; hitX: number; hitY: number } | null {
    // Same shape as `playerHitscanDist` (`shipHitShape.ts`). Capitals: the
    // hull, shield up or down (a broadside shell once burst ~2,000 u off a
    // pilot's heavy cruiser, 2026-11-12).
    return shipSweepHit(ship.kind, ship.shield > 0, fromX, fromY, stepX, stepY, projRadius, cx, cy, angle);
  }

  private advanceProjectiles(): void {
    this.projectiles.advance();
  }

  // ── Worker lifecycle ────────────────────────────────────────────────────

  private postToWorker(cmd: WorkerCmd): void {
    this.physicsWorkerProxy.postCommand(cmd);
  }

  // ── Colyseus room hooks ─────────────────────────────────────────────────

  override async onJoin(client: Client, options: unknown): Promise<void> {
    await this.joinHandler.handle(client, options);
  }

  override onLeave(client: Client, consented: boolean): void {
    // Plan: crispy-kazoo, Commit 2 — drop any in-flight handshake
    // entry. A disconnected client can't complete the handshake;
    // its ship stays `isActive=false` for the standard leave flow
    // (linger / despawn) to handle, but we don't want a watchdog
    // to fire warp_in on a ghost session.
    const leavingPlayerId = this.sessionToPlayer.get(client.sessionId);
    if (leavingPlayerId) {
      this.pendingJoin.delete(leavingPlayerId);
      this.pendingCommandStart.delete(leavingPlayerId);
      // Presence — drop this session's connected refcount (push offline gate).
      unregisterConnectedPlayer(leavingPlayerId);
      this.nav.forget(leavingPlayerId);
    }

    // Click-to-inspect (Item B5) — drop this connection's selection so the
    // ~5 Hz stats emitter doesn't keep resolving for a gone session (covers
    // disconnect AND inter-sector transit, both of which fire onLeave).
    this.selectionStats?.clearSession(client.sessionId);
    this.fleetHooks.fleetStatus?.clearSession(client.sessionId);
    this.fleetHooks.fleetStatusSoon.clear(client.sessionId);
    this.fleetHooks.fleetMsgCountThisTick.delete(client.sessionId);
    // Interest window + scratch set of a gone connection.
    this.snapshotBroadcaster.forgetInterestWindow(client.sessionId);

    // Campaign 1.3 — forget this connection's malformed-packet counter.
    this.malformed.clear(client.sessionId);

    // Phase 1 swift-otter — tear down the WebRTC peer connection BEFORE
    // running the existing leave handler. The leaveHandler does the
    // player-state cleanup (lingering / transit / despawn); the DC
    // teardown is independent and must happen even on lingering paths
    // (no point holding a PeerConnection alive against a disconnected
    // session). Idempotent: cleanup() is a no-op when no entry exists.
    this.webrtcChannelManager?.cleanup(client.sessionId);
    this.leaveHandler.handle(client, consented);

    // PR 3a — drop this session's pilot registration (only if a takeover
    // hasn't already replaced it), then release any takeover waiting on us.
    const registeredPlayer = this.sessionRegisteredPlayer.get(client.sessionId);
    if (registeredPlayer !== undefined) {
      unregisterPlayerSession(registeredPlayer, client.sessionId);
      this.sessionRegisteredPlayer.delete(client.sessionId);
    }
    const releaseTakeover = this.pendingTakeoverLeaves.get(client.sessionId);
    if (releaseTakeover !== undefined) {
      this.pendingTakeoverLeaves.delete(client.sessionId);
      releaseTakeover();
    }
  }

  /** PR 3a — sessionId → the playerId it registered as pilot of. */
  private readonly sessionRegisteredPlayer = new Map<string, string>();
  /** PR 3a — sessionId → resolver for a takeover awaiting this session's onLeave. */
  private readonly pendingTakeoverLeaves = new Map<string, () => void>();

  /**
   * PR 3a — another device logged into the same account is joining: tell
   * this session it has been replaced and disconnect it. Resolves once this
   * room's `onLeave` for the session has run (the hull lingers exactly like
   * a normal disconnect, so the new session rebinds to it).
   */
  private evictSessionForTakeover(sessionId: string): Promise<void> {
    const target = this.clients.find((c) => c.sessionId === sessionId);
    if (target === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingTakeoverLeaves.set(sessionId, resolve);
      const msg: SessionReplacedMessage = { type: 'session_replaced' };
      target.send('session_replaced', msg);
      serverLogEvent('session_replaced', { sessionId, roomId: this.roomId });
      target.leave(SESSION_REPLACED_CLOSE_CODE);
    });
  }

  /**
   * Phase 8 sub-phase B (lingering ships) — full despawn for an ownerless
   * ship. Called when (a) the eviction timer fires after the disconnect
   * TTL elapses without reconnect, (b) the ship is destroyed mid-offline,
   * or (c) the room is disposed. Same teardown as the despawn branch of
   * `onLeave`, plus clears the Limbo entry so the active-Limbo UI doesn't
   * keep showing a sector the player can no longer enter.
   */
  private evictOwnerlessShip(shipInstanceId: string): void {
    this.wingmen.detachWingman(shipInstanceId); // RTS slice 4 (no-op unless a lingering hull)
    this.ownerlessShipEvictor.evict(shipInstanceId);
  }

  // ── RTS — AI pilots on lingering hulls (`features/wingmanPilots.ts`) ────────
  private readonly wingmen: WingmanPilots = new WingmanPilots({
    state: () => this.state, fleet: this.fleet, lingeringSlots: this.lingeringSlots, lingeringPoseCache: this.lingeringPoseCache,
    playerToActiveShipInstance: this.playerToActiveShipInstance, playerToSlot: () => this.playerToSlot,
    boostingPlayers: this.boostingPlayers, lastFireClientTick: this.lastFireClientTick, lockActivated: () => this.fireLocks._lockActivated,
    swarmRegistry: this.swarmRegistry, sabF32: () => this.sabF32, serverTick: () => this.serverTick,
    aiController: () => this.aiController, wingmanLocks: () => this.wingmanLocks, locks: () => this.locks,
    mountTicker: () => this.mountTicker, playerFireResolver: () => this.playerFireResolver,
    transitOrchestrator: () => this.transitOrchestrator, postToWorker: (cmd) => this.postToWorker(cmd),
    getActiveShip: (pid) => this.getActiveShip(pid), swarmEntityPoseInto: (id, out) => this.swarmEntityPoseInto(id, out),
    resolveActiveShipKey: (pid) => this.resolveActiveShipKey(pid), fleetStatusSoonFor: (pid) => this.fleetHooks.fleetStatusSoonFor(pid),
  });
  private readonly fleetHooks: FleetRoomHooks = new FleetRoomHooks({
    state: () => this.state, fleet: this.fleet, clients: () => this.clients, sessionToPlayer: () => this.sessionToPlayer,
    playerToSession: () => this.playerToSession, playerToActiveShipInstance: this.playerToActiveShipInstance,
    lingeringSlots: this.lingeringSlots, spectateParkedHull: this.spectateParkedHull, sabF32: () => this.sabF32,
    serverTick: () => this.serverTick, sectorKey: () => this.sectorKey, aiController: () => this.aiController,
    wingmen: () => this.wingmen, getActiveShip: (pid) => this.getActiveShip(pid),
    displaceActiveHullToLingering: (pid) => this.pilotSwap.displaceActiveHullToLingering(pid),
  });
  // ── Phase 4 WS-A2 — same-sector instant pilot swap (`features/pilotSwap.ts`) ──
  private readonly pilotSwap: PilotSwap = new PilotSwap({
    state: () => this.state, sectorKey: () => this.sectorKey, sabF32: () => this.sabF32, sabU32: () => this.sabU32,
    playerToSlot: () => this.playerToSlot, slotToPlayer: () => this.slotToPlayer, pendingJoin: () => this.pendingJoin,
    setForceBroadcastUntilTick: (tick) => { this.forceBroadcastUntilTick = tick; },
    playerToActiveShipInstance: this.playerToActiveShipInstance, lingeringSlots: this.lingeringSlots,
    lingeringPoseCache: this.lingeringPoseCache, ownerlessShips: this.ownerlessShips, spectateParkedHull: this.spectateParkedHull,
    pendingCommandStart: this.pendingCommandStart, shipPoseCache: this.shipPoseCache, lastFireClientTick: this.lastFireClientTick,
    playerToUser: this.playerToUser, fleet: this.fleet, locks: () => this.locks, wingmanLocks: () => this.wingmanLocks,
    npcLocks: () => this.npcLocks, wingmen: () => this.wingmen, mountTicker: () => this.mountTicker,
    transitOrchestrator: () => this.transitOrchestrator, rosterPersistence: () => this.rosterPersistence,
    cutField: () => this.cutField, bus: () => this.bus, logger,
    getActiveShip: (pid) => this.getActiveShip(pid), postToWorker: (cmd) => this.postToWorker(cmd),
    applyStatMulToWorker: (key, alloc) => this.shipProgression.applyStatMulToWorker(key, alloc),
    shipHullMax: (kindMax, alloc, sid) => this.shipHullMax(kindMax, alloc, sid),
    shellWelcomeFields: (client, pid) => this.shellWelcomeFields(client, pid), wreckWelcomeFields: () => this.wreckWelcomeFields(),
  });
  // ── Phase 4 — ship progression: kill XP, upgrades (`features/shipProgression.ts`) ──
  private readonly shipProgression: ShipProgression = new ShipProgression({
    state: () => this.state, lingeringSlots: this.lingeringSlots, fleet: this.fleet, wingmen: () => this.wingmen,
    bus: () => this.bus, broadcast: (type, msg) => this.broadcast(type, msg), logger,
    resolveActiveShipKey: (pid) => this.resolveActiveShipKey(pid), postToWorker: (cmd) => this.postToWorker(cmd),
    shipHullMax: (kindMax, alloc, sid) => this.shipHullMax(kindMax, alloc, sid),
  });
  /** v4 T3 / fleet warp — the cross-sector parked-hull hand-off (`features/hullHandOff.ts`). */
  private readonly hullHandOff = new HullHandOff({
    sectorKey: () => this.sectorKey, serverTick: () => this.serverTick, ships: () => this.state.ships,
    lingeringSlots: this.lingeringSlots, lingeringPoseCache: this.lingeringPoseCache, freeSlots: () => this.freeSlots,
    ownerlessShips: this.ownerlessShips, fleet: this.fleet, wingmen: () => this.wingmen, snapshotRestore: () => this.snapshotRestore,
    warpTravel: () => this.warpTravel, logger, postToWorker: (cmd) => this.postToWorker(cmd),
    landingPoint: (pid, x, y, kind, skip) => this.landingPoint(pid, x, y, kind, skip), playerToUser: this.playerToUser,
  });

  /**
   * Mirror an eviction into the roster — the ship transitions from
   * `is_active=true` to `is_active=false` with frozen pose. The row
   * stays in the table (forever, modulo abandon) so the player can
   * pick it on a future visit.
   */
  private markRosterStored(
    shipInstanceId: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
  ): void {
    this.rosterPersistence.markStored(shipInstanceId, pose);
  }

  private deleteRosterRow(shipInstanceId: string): void {
    this.rosterPersistence.delete(shipInstanceId);
  }

  // ── Living World P1a — loot hooks ────────────────────────────────────────

  /** Spill a ship's carried hold at `pose` (one atomic group). Without a pose
   *  the hold is deleted and audited as lost — never left orphaned. `death`
   *  (not an abandon): its kind's hull loot joins the pod beside the kill, as
   *  an AI pilot's ship drops it (owner 2026-11-15; `deathHullLoot`). */
  private spillOrLoseShipHold(
    shipInstanceId: string,
    playerId: string,
    pose: { x: number; y: number; vx: number; vy: number } | undefined,
    cause: string,
    death?: { kind: string; vaporised: boolean; shooterId: string },
  ): void {
    // P5 — installed blueprints are lost with the ship (death or abandon).
    this.dropFitted(shipInstanceId);
    if (shipInstanceId === '') return;
    const carried = this.loot.shipHold(shipInstanceId) !== undefined;
    if (!carried && (death === undefined || pose === undefined)) return;
    if (pose !== undefined) {
      if (death !== undefined) {
        const hull = deathHullLoot(shipInstanceId, death.kind, death.vaporised);
        const spot = this.npcLoot.podSpot(hashString(shipInstanceId), pose.x, pose.y, getShipKind(death.kind).radius, death.shooterId);
        this.loot.spillShipHold(shipInstanceId, spot.x, spot.y, pose.vx + spot.ux * DEATH_POD_PUSH, pose.vy + spot.uy * DEATH_POD_PUSH, cause, {
          player: true, extra: hull, deathLoss: `${shipInstanceId}:${this.gameClock.now()}`,
          size: podSizeClass(getShipKind(death.kind).radius),
        });
      } else {
        // Living World P1a-2 — an ABANDONED hull becomes a salvageable derelict
        // (fly alongside to salvage over time).
        this.loot.spillShipHold(shipInstanceId, pose.x, pose.y, pose.vx, pose.vy, cause, {
          player: true, derelict: cause === 'abandoned',
        });
      }
    } else {
      getHoldStore().delete(shipInstanceId, this.sectorKey !== null);
    }
    if (carried) auditEvent({ event: 'cargo_lost', sector: this.sectorKey ?? undefined, playerId, shipInstanceId, cause });
  }

  /** A ship's cargo capacity: its hull class, raised by a fitted Cargo
   *  Expander (shared helper, #15). Used by loot pickup and cargo access. */
  private shipCargoCapacity(kind: string, shipInstanceId: string): number {
    return Math.floor(cargoCapacityForMaxHealth(getShipKind(kind as ShipKindId)) * fittedCargoMul(this.fittedOf(shipInstanceId)));
  }

  /** Does pilot ship `shipInstanceId` have a hold: a roster row in a roster-backed room (the loot pickup's gate; the lock's free hold). */
  private hasHold(shipInstanceId: string): boolean {
    return this.sectorKey !== null && shipInstanceId !== '' && getPlayerShipStore().get(shipInstanceId) !== null;
  }

  /**
   * Economy v2 W4b — where `owner` keeps a packed `product` in this sector:
   * one of their operational storage structures, else their active ship's
   * hold. Null when they have none here. Control cadence (placement only).
   */
  private findPacked(owner: string, product: string): { rec: StructureRecord } | { shipId: string } | null {
    for (const rec of this.structureRegistry.all()) {
      if (rec.owner === owner && rec.hold !== undefined && isOperationalStorage(rec) && packedCount(rec.hold, product) > 0) return { rec };
    }
    const shipId = this.pilotSwap.ownShipKey(owner); // flown or parked (Command / Build)
    const row = shipId ? getHoldStore().get(shipId) : undefined;
    if (shipId && row !== undefined && packedCount(row.hold, product) > 0) return { shipId };
    return null;
  }

  /**
   * Economy v2 — repack a PREPAID structure that finished deconstructing: the
   * packed item (same kind, same quality) goes into the owner's storage in its
   * grid component, else it drops as a pod where the structure stood. Called
   * by the grid pulse BEFORE the structure is despawned (a Capital: `repackItem`).
   */
  private repackStructure(rec: StructureRecord): void {
    const item = repackItem(rec, REPACK_DEFAULT_QUALITY);
    const target = this.storage.networkFor(rec).find((r) => r.id !== rec.id);
    if (target !== undefined) {
      ((target.hold ??= { goods: {}, blueprints: [] }).packed ??= []).push(item);
      this.storage.commitChanged([target], []);
    } else {
      this.loot.drop({ goods: {}, blueprints: [], packed: [item] }, rec.x, rec.y, 0, 0, { cause: 'removed' });
    }
    auditEvent({ event: 'structure_repacked', sector: this.sectorKey ?? undefined, owner: rec.owner, kind: rec.kind, quality: item.quality, toStorage: target !== undefined });
  }

  /** Living World P1a-2 — a short player-facing notice (HUD popup line). */
  private sendNotice(client: Client, text: string): void {
    try { client.send('notice', { type: 'notice', text }); } catch { /* socket closing */ }
  }

  // ── Living World P3b — harvester hooks (driven by RobotTerritory) ───────

  /** Robot harvesters hunt haulers — the nearest live hauler (trade or convoy)
   *  within `range` of (x, y). Control cadence (allocates the result). */
  nearestHauler(x: number, y: number, range: number): { id: string; x: number; y: number } | null {
    let best: { id: string; x: number; y: number } | null = null;
    let bestD2 = range * range;
    for (const rec of this.swarmRegistry.all()) {
      if (!isHaulerId(rec.id)) continue;
      const b = slotBase(rec.slot);
      const px = this.sabF32[b + SLOT_X_OFF]!;
      const py = this.sabF32[b + SLOT_Y_OFF]!;
      const d2 = (px - x) ** 2 + (py - y) ** 2;
      if (d2 <= bestD2) { bestD2 = d2; best = { id: rec.id, x: px, y: py }; }
    }
    return best;
  }

  nearestLootPod(x: number, y: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD2 = Infinity;
    for (const id of this.loot.podIds()) {
      if (this.loot.isDerelict(id)) continue;
      const rec = this.swarmRegistry.get(id);
      if (rec == null) continue;
      const b = slotBase(rec.slot);
      const px = this.sabF32[b + SLOT_X_OFF]!;
      const py = this.sabF32[b + SLOT_Y_OFF]!;
      const d2 = (px - x) ** 2 + (py - y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = { x: px, y: py }; }
    }
    return best;
  }

  holdWeight(uid: string): number {
    const rec = getHoldStore().get(uid);
    return rec ? holdWeight(rec.hold) : 0;
  }

  bankHold(fromUid: string, toUid: string): number {
    const store = getHoldStore();
    const from = store.get(fromUid);
    if (from === undefined || isHoldEmpty(from.hold)) return 0;
    const to = store.get(toUid);
    const merged = to ? cloneHold(to.hold) : emptyHold();
    const moved = holdWeight(from.hold);
    mergeInto(merged, cloneHold(from.hold));
    store.commit(
      [{ holderUid: toUid, holderType: 'hauler', ownerId: null, sectorKey: this.sectorKey, x: null, y: null, hold: merged, expiresAt: null }],
      [fromUid],
      this.sectorKey !== null,
    );
    return moved;
  }

  /** P3c — nearest operational player storage near (x, y) whose network holds
   *  something worth stealing. Control cadence (allocates). */
  nearestPlayerStorage(x: number, y: number, range: number): { uid: string; owner: string; x: number; y: number } | null {
    const rec = this.storage.nearestAnyStorage(x, y, range);
    if (rec === null || rec.uid === undefined) return null;
    const snap = this.storage.tradeSnapshot(rec.owner, rec.uid);
    if (snap === null) return null;
    let worth = 0;
    for (const g of GOOD_IDS) worth += snap.goods[g] ?? 0;
    return worth > 0 ? { uid: rec.uid, owner: rec.owner, x: rec.x, y: rec.y } : null;
  }

  /** W6 — LivingWorldRoom hook: nearest asteroid with ore left. Control cadence. */
  nearestOreAsteroid(x: number, y: number, range: number): { entityId: number; x: number; y: number; radius: number } | null {
    const a = this.findNearestAsteroid(x, y, range);
    return a === null ? null : { entityId: a.entityId, x: a.x, y: a.y, radius: a.radius };
  }

  /** W6 — LivingWorldRoom hook: a robot harvester mines a rock into its
   *  ownerless hold (`OreDraw.mine`, the Miner's pool and yield), so a killed
   *  harvester spills what it mined. Control cadence. */
  mineAsteroid(harvesterId: string, entityId: number, maxUnits: number, capacity: number): number {
    return this.oreDraw.mine(harvesterId, null, entityId, maxUnits, capacity);
  }

  /** P3c — LivingWorldRoom hook: a harvester raids a storage network (`features/tradeMessages.ts`). */
  raidStorage(harvesterId: string, owner: string, uid: string, stepWeight: number): number { return this.storageRaid.raid(harvesterId, owner, uid, stepWeight); }

  // ── Living World P2 — TradeRoom hooks (driven by the TradeDirector) ──────

  tradeSnapshot(ownerId: string, networkUid: string): TradeNetworkSnapshot | null {
    return this.storage.tradeSnapshot(ownerId, networkUid);
  }

  /** T2 — this room's NPC bases for convoy planning (`npcBaseTrade.ts`). */
  npcBaseTrade(): NpcBaseTrade[] { return npcBaseTrade(this.structureRegistry, this.storage); }

  /**
   * Phase 4 warp travel — where a warping ship lands: the nearest spot to its
   * drop point clear of structures, other ships and swarm entities (asteroids,
   * drones, scrap), with the ship's spawn clearance. Runs once per warp, when
   * the run starts (a discrete event, not the per-tick loop).
   */
  private warpLandingPoint(playerId: string, x: number, y: number): { x: number; y: number } {
    return this.landingPoint(playerId, x, y, this.getActiveShip(playerId)?.kind);
  }

  /** The nearest spot to (x, y) clear of structures, swarm entities, field
   *  rocks with no body, blocking walls, and other players' ships and parked
   *  hulls (the pilot's own are not obstacles; `SectorObstacles.landing`).
   *  With `onlySkipShipId` (a fleet warp placing one of its hulls) the
   *  owner's own ships and hulls ARE obstacles; only that ship is skipped. */
  private landingPoint(
    playerId: string, x: number, y: number, kind: string | undefined, onlySkipShipId?: string,
  ): { x: number; y: number } {
    const ownClear = kind ? tuningFor(kind).spawnClearance : 60;
    const { near, maxDistance } = landingReach(ownClear);
    const o = this.obstacles;
    o.landing(playerId, x, y, near, onlySkipShipId);
    return nearestClearPoint(x, y, o.boxes, ownClear, maxDistance, o.circles, ownClear, o.walls);
  }

  /** T2 — the nearest point clear of every structure (convoy hauler spawns:
   *  150 u). With `clearance` (a flagship fleet's station), searched as far
   *  as a landing of that clearance (`landingReach`). */
  clearPointNear(x: number, y: number, clearance?: number): { x: number; y: number } {
    if (this.structureRegistry.size === 0) return { x, y };
    if (clearance === undefined) return nearestClearPoint(x, y, this.obstacles.structureBoxes(), 150);
    return nearestClearPoint(x, y, this.obstacles.structureBoxes(), clearance, landingReach(clearance).maxDistance);
  }

  /** 3h — ConvoyRoom: a dock's crane serves a hauler (`CraneBays.craneServe`). */
  craneServe(botId: string, job: CraneHaulJob): 'serving' | 'none' { return this.rigs.craneBays.craneServe(botId, job); }
  /** 3h — ConvoyRoom: drop a hauler's crane job (`CraneBays.craneCancel`). */
  craneCancel(botId: string): void { this.rigs.craneBays.craneCancel(botId); }

  tradeTransfer(ownerId: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null {
    const res = this.storage.tradeTransfer(ownerId, networkUid, spec);
    if (res !== null) this.rebuildStructuresSlice(); // the bank rides the slice
    return res;
  }

  /** A base is "under attack" when its owner's faction has an active wave here,
   *  or one of its structures was hit in the last 60 s. */
  tradeBaseUnderAttack(ownerId: string): boolean {
    if (this.factionLedger.get(ownerId)?.underWave === true) return true;
    return this.structureHitWithin(60_000, ownerId, false);
  }

  /** Galaxy feed — a structure of control side `side` was hit within `windowMs` (game time). */
  sideStructuresHitWithin(side: string, windowMs: number): boolean {
    return this.structureHitWithin(windowMs, side, true);
  }

  /** A structure owned by `who` (an owner id, or a control side when `bySide`) was hit within `windowMs`. */
  private structureHitWithin(windowMs: number, who: string, bySide: boolean): boolean {
    const now = this.gameClock.now();
    for (const [sid, at] of this.structureAttackAuditAtMs) {
      if (now - at > windowMs) continue;
      const owner = this.structureRegistry.get(sid)?.owner;
      if (owner !== undefined && (bySide ? parseOwner(owner).faction : owner) === who) return true;
    }
    return false;
  }

  tradeDropAt(hold: Hold, x: number, y: number): void {
    this.loot.drop(hold, x, y, 0, 0, { cause: 'trade' });
  }

  tradeNotify(playerId: string, notice: TradeNotice): void {
    const sessionId = this.playerToSession.get(playerId);
    if (sessionId === undefined) return;
    const client = this.clients.find((c) => c.sessionId === sessionId);
    try { client?.send('trade_notice', notice); } catch { /* socket closing */ }
  }

  /** testMode trade opt-in key: the key this room is known by to the
   *  TradeDirector (null ⇒ not a testMode trade room). */
  private tradeRegisteredKey: string | null = null;

  /** Join the TradeDirector if this room opted in. Idempotent; called at
   *  onCreate AND on every trade request, because a room can be created before
   *  boot installs the director (the trade-tab E2E race). */
  private ensureTradeRegistered(): void {
    if (this.tradeRegisteredKey !== null) getTradeSink()?.registerRoom(this.tradeRegisteredKey, this);
  }
  /** P2 bespoke triggers (testMode only). */
  private testSeedStorageHold: { goods: Partial<Record<'minerals' | 'salvage' | 'alloy' | 'core', number>> } | null = null;
  /** Economy v2 W1 (testMode) — top each joiner's wallet up to this. */
  private testWalletSeed = 0;
  private testHaulerRaiders = 0;
  /** Perf scenes — null unless the room was created with `sceneScript`. */
  private sceneRunner: SceneScriptRunner | null = null;
  /** Perf scenes: TiDi + load shedding off (fixed work). testMode-only. */
  private perfFixedLoad = false;
  /** testMode: false ⇒ SectorPersistence sees no sector (no save/restore). */
  private persistSector = true;
  /** testMode: where a wave squad lands here (null ⇒ its carry pose). */
  private testWaveArrivalPose: { x: number; y: number } | null = null;
  /** testMode `waveNeedsOwner` (see the room option). */
  private waveNeedsOwner = false;
  /** LivingWorldRoom hook — see `testWaveArrival` in LivingWorldRoom.ts. */
  testWaveArrival(): { x: number; y: number } | null { return this.testWaveArrivalPose; }

  /** Scene status for `/dev/perf` and tests (null: no scene). */
  sceneStatus(): Readonly<SceneStatus> | null { return this.sceneRunner?.getStatus() ?? null; }

  /** Server tick cost while the scene runs (start → end), for `/dev/perf`. */
  private sceneTickRing: FrameTimeRing | null = null;
  private sceneWorkerRing: FrameTimeRing | null = null;
  /** Perf scenes (WS3): per-tick work counters, counted while the scene runs. */
  private readonly sceneWork = new SceneWorkCounters();
  private sceneEluStart: EventLoopUtilization | null = null;
  /** Game time vs wall time over the scene (worker tick, dropped ticks, wall ms). */
  private readonly sceneSimStart = { ms: 0, tick: 0, dropped: 0 };
  private readonly sceneSimEnd = { ms: 0, tick: 0, dropped: 0 };
  private markSceneSim(m: { ms: number; tick: number; dropped: number }): void {
    // eslint-disable-next-line no-restricted-properties -- real time: perf-scene wall-time mark (game time vs wall time)
    m.ms = performance.now();
    m.tick = this.sabU32[TICK_IDX] ?? 0;
    m.dropped = this.sabU32[WORKER_DROPPED_TICKS_IDX] ?? 0;
  }

  private readonly sceneCensusHost: SceneBodyCensusHost = { swarmRegistry: this.swarmRegistry, sabU32: () => this.sabU32, sabF32: () => this.sabF32, capitalWrecks: () => this.capitalWrecks };
  scenePerf(): ScenePerfView | null {
    if (!this.sceneRunner || !this.sceneTickRing || !this.sceneWorkerRing) return null;
    return {
      roomId: this.roomId,
      scene: { ...this.sceneRunner.getStatus() },
      tick: this.sceneTickRing.summary(),
      workerTick: this.sceneWorkerRing.summary(),
      tickRecent: this.sceneTickRing.summary(SCENE_RECENT_TICKS),
      workerTickRecent: this.sceneWorkerRing.summary(SCENE_RECENT_TICKS),
      bodies: sceneBodyCensus(this.sceneCensusHost),
      swarm: this.swarmRegistry.size(),
      players: this.playerToSlot.size,
      structures: this.structureRegistry.size,
      work: this.sceneWork.view(this.sceneEluStart ? (this.physicsWorkerProxy?.elu(this.sceneEluStart)?.utilization ?? null) : null),
      simTime: sceneSimTime(this.sceneSimStart, this.sceneSimEnd, this.gameClock.scale),
      timeScale: { scale: this.gameClock.scale, loadFactor: this.timeScale.loadFactor, auto: this.timeScale.autoSlowdown },
      wakeCensus: this.physicsWorkerProxy?.lastWakeCensus ?? null,
    };
  }

  /** Living World P2 — robot reputation truce (no on-sight engagement). One Map
   *  lookup; safe on the snapshot / AI hot paths. */
  private playerTruce(playerId: string): boolean {
    return getTradeSink()?.robotTruce(playerId) === true;
  }

  /** The ONE NPC→player hostility query (snapshot `drones[].hostile`, live
   *  counts, missile homing): stance + retaliation ledger, minus on-sight
   *  engagement for a player holding a truce (#15/#16 — every surface agrees). */
  private npcHostileTo(entityId: string, playerId: string): boolean {
    return this.aiController.isEntityHostileToPlayer(entityId, playerId, this.playerTruce(playerId));
  }

  /** C3 — NPC loot holds and kill pods (`cargo/NpcLootHolds.ts`). */
  private readonly npcLoot = new NpcLootHolds({ sectorKey: () => this.sectorKey, sabF32: () => this.sabF32, loot: () => this.loot, swarmRegistry: this.swarmRegistry, shipPoseCache: this.shipPoseCache, lingeringPoseCache: this.lingeringPoseCache });

  override onDispose(): void {
    this.roomFeatures?.dispose();
    if (this.sceneRunner) unregisterScenePerfRoom(this);
    this.simLoopStopped = true;
    this.gameClock.cancelAll();
    if (this.tradeRegisteredKey !== null) getTradeSink()?.unregisterRoom(this.tradeRegisteredKey, this);
    if (this.teleportRoom) getTeleportBroker().unregister(this.teleportRoom);
    this.cutField?.dispose();
    this.nav.detach();
    if (this.aiController) this.aiController.nav = undefined;
    // Structures plan, Phase 3 — stop the grid pulse heartbeat.
    if (this.structureGridTimer !== undefined) {
      this.structureGridTimer.cancel();
      this.structureGridTimer = undefined;
    }
    // Phase 5 — stop the turret tick.
    if (this.structureTurretTimer !== undefined) {
      this.structureTurretTimer.cancel();
      this.structureTurretTimer = undefined;
    }
    // Shield-fence plan — tear down any wall spans (free their worker bodies).
    this.shieldWalls?.removeAll();
    // Item B5 — stop the click-to-inspect stats emitter.
    if (this.selectionStatsTimer !== undefined) {
      clearInterval(this.selectionStatsTimer);
      this.selectionStatsTimer = undefined;
    }
    // Paradigm plan (quirky-rabbit) Phase 6 — unsubscribe from the GC
    // observer so the disposed room isn't kept alive by the subscriber
    // closure (and so the observer doesn't try to broadcast through a
    // torn-down WebSocket transport).
    if (this.gcPauseSubscriber) {
      unsubscribeGcPause(this.gcPauseSubscriber);
      this.gcPauseSubscriber = null;
    }
    // Phase 8 sub-phase B — abort any in-flight transits so no orphan timers
    // or seat reservations linger past room teardown.
    this.transitOrchestrator?.cancelAll('manual');
    // Clear any lingering-ship eviction timers — the room is being torn down,
    // so a timer would fire against a dead `this`. R2.26: persist-forever
    // lingering hulls hold a `null` marker (no timer) — only legacy/real
    // Timeouts need clearing. The ships' Limbo entries stay on disk so a
    // server-restart restore can find them.
    for (const timer of this.ownerlessShips.values()) if (timer) clearTimeout(timer);
    this.ownerlessShips.clear();
    // Phase 8 — final snapshot before tear-down so swarm health survives
    // a graceful shutdown. `persistence.shutdown` (called from index.ts on
    // SIGINT/SIGTERM) drains the CRITICAL queue afterwards. Campaign 6.3:
    // cancel any pending event-driven persist first — this final write
    // supersedes it, and a fire-after-teardown would read torn-down state.
    this.sectorPersistence.dispose();
    if (this.sectorKey !== null) {
      try { this.wreckSaves?.flush(true); this.wreckFieldSource?.flushAll(); } catch { /* non-critical */ }
      try { this.persistSectorSnapshot(); } catch { /* non-critical */ }
    }
    // Phase 1 swift-otter — close every PeerConnection so the libdatachannel
    // worker threads exit cleanly before the process / room teardown.
    this.webrtcChannelManager?.cleanupAll();
    this.webrtcChannelManager = null;
    this.physicsWorkerProxy?.terminate();
    logger.info({ sectorKey: this.sectorKey }, 'SectorRoom disposed');
  }

  // ── Phase 4 iteration 3 swift-otter — WebRTC diagnostic surface ─────────

  /**
   * Invoked via `matchMaker.remoteRoomCall(roomId, 'getWebRtcCounters')`
   * from the `/dev/webrtc-counters` dev endpoint. Returns a JSON-safe
   * snapshot of per-session counters so the Phase 4 E2E can compare
   * server-side `sentViaDc` against client-side `snapshot_received`
   * via='dc' counts to localise where DC throughput variance lives.
   * Null when the room has no manager (defensive — every room currently
   * constructs one).
   */
  getWebRtcCounters(): {
    roomId: string;
    sectorKey: string | null;
    sessions: WebRtcEntryCounters[];
  } | null {
    if (!this.webrtcChannelManager) return null;
    return {
      roomId: this.roomId,
      sectorKey: this.sectorKey,
      sessions: this.webrtcChannelManager.getCounters(),
    };
  }

  // ── Phase 8 — sector snapshot persistence ───────────────────────────────

  /**
   * Build a `SectorSnapshotPayload` from the live registry + health map and
   * enqueue it through the persistence sink. CRITICAL lane — survives drain.
   */
  private persistSectorSnapshot(): void {
    this.sectorPersistence.persist();
  }

  private hydrateFromSnapshot(): void {
    this.sectorPersistence.hydrate();
    // Living World P1a — respawn this sector's persisted loot pods (holds table).
    this.loot.restore();
  }

  // ── Simulation loop (main thread — reads SAB, updates Colyseus schema) ──

  /** Test counter (`_internals.roomUpdates`). */
  private roomUpdateCount = 0;

  private update(): void {
    this.roomUpdateCount++;
    this.inputCountThisTick.clear();
    this.lockMsgCountThisTick.clear();
    this.fleetHooks.fleetMsgCountThisTick.clear();
    // Phase 8 — galaxy sectors always run the simulation step regardless of
    // player count, so the world feels alive (drones patrol, asteroids drift,
    // sleep transitions fire) even when nobody's logged in. Engineering rooms
    // keep the dual-zero short-circuit because their state is ephemeral and
    // there's no reason to burn CPU on them when idle.
    if (
      this.sectorKey === null
      && this.playerToSlot.size === 0
      && this.swarmRegistry.size() === 0
    ) return;

    // eslint-disable-next-line no-restricted-properties -- real time: measures the tick's real cost
    const tStart = performance.now();
    this.sceneWork.beginUpdate();

    // Phase 6 synthetic load: busy-wait `tickBurnMs` so the budget tracker
    // measures it as real work and TiDi engages. Only enabled when the
    // `tickBurnMs` room option is set (default 0). Always before the phase
    // timer starts so it counts in the unattributed remainder of `total`,
    // not against any specific phase.
    if (this.tickBurnMs > 0) {
      const burnDeadline = tStart + this.tickBurnMs;
      // eslint-disable-next-line no-restricted-properties -- real time: the perf burn test spends real CPU
      while (performance.now() < burnDeadline) { /* intentional busy-wait */ }
    }

    this.tickBudget.beginTick(tStart);
    const phaseTime = (key: string): void => this.tickBudget.phaseTime(key);

    // Seqlock SAB → pose-cache mirror — see SabPoseMirror.ts. Swarm
    // poses are read directly from SAB by the binary encoder later in
    // this tick (see swarmEncoder.encode).
    mirrorSabPoses({
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      playerToSlot: this.playerToSlot,
      lingeringSlots: this.lingeringSlots,
      shipPoseCache: this.shipPoseCache,
      lingeringPoseCache: this.lingeringPoseCache,
      sabAppliedTicks: this.sabAppliedTicks,
    });

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;
    this.sceneRunner?.tick(this.serverTick);

    // Plan: crispy-kazoo, Commit 2 — drain handshake activations.
    // Flip pending-join ships' `isActive=true` at arrivalTick, and
    // fire the watchdog for any ship whose client_ready hasn't
    // arrived in CLIENT_READY_TIMEOUT_TICKS. Cheap when the map
    // is empty (most ticks); short-circuits at the top of the
    // method.
    this.joinHandler.drainPending();
    // Phase 4 warp travel: into / out of the world on a warp run (no-op when
    // nobody is warping).
    this.warpTravel.tick(this.serverTick);
    if (this.livingWorldBotHooks.npcWarps.size > 0) this.livingWorldBotHooks.tickNpcWarps();

    // Phase 4 abandon detection — galaxy-rooms only, every 30 ticks
    // (~500ms). See sectorIdleEvaluator.ts.
    if (this.sectorKey !== null && this.serverTick % 30 === 0 && this.state.ships.size > 0) {
      const abandoned = findAbandonedShips(this.state.ships, getPlayerShipStore());
      for (const a of abandoned) {
        // Equinox P6.3 — abandoned hulls shatter into SCRAP and leave the world.
        // (Wrecks are fully retired — the entity/schema/wire/render plumbing was
        // removed in C3; nothing creates a wreck.)
        if (a.lingering) this.ownerlessShipEvictor.abandonLingeringHullToScrap(a.shipInstanceId);
        else this.ownerlessShipEvictor.abandonShipToScrap(a.playerId);
      }
    }

    // Phase 5d spatial-grid update + Phase 1 AI runaway-bounds clamp.
    // See swarmInterestUpdater.ts.
    updateSwarmInterestGrid({
      swarmRegistry: this.swarmRegistry,
      interestGrid: this.interestGrid,
      sabF32: this.sabF32,
      postToWorker: (cmd) => this.postToWorker(cmd),
      droneMaxBounds: DRONE_MAX_BOUNDS,
    });
    phaseTime('sabRead');

    // Per-tick lag-comp recording — see lagCompRecorder.ts.
    recordLagCompPoses({
      snapshotRing: this.snapshotRing,
      serverTick: this.serverTick,
      playerToSlot: this.playerToSlot,
      shipPoseCache: this.shipPoseCache,
      swarmRegistry: this.swarmRegistry,
      sabF32: this.sabF32,
      getActiveShip: (id) => this.getActiveShip(id),
    });

    // Advance physical projectiles and check for collisions.
    this.advanceProjectiles();
    // Advance missiles (lock-verify, guidance, sweep, detonate-splash).
    // Detonations enqueue physics impulses which are drained below and
    // posted to the worker as MISSILE_IMPULSE commands.
    this.missileSim.advance();
    const impulses = this.missileSim.drainImpulses();
    for (const imp of impulses) {
      this.postToWorker({
        type: 'MISSILE_IMPULSE',
        entityId: imp.targetId,
        fx: imp.fx,
        fy: imp.fy,
      });
    }
    this.tickShieldRegen();
    tickShipEnergy(this.energyTickHost);
    phaseTime('projectiles');

    // Phase 8 — sector persistence. Galaxy rooms snapshot their volatile
    // state (swarm health) every 60 s. Engineering rooms (sectorKey null)
    // skip; their state is ephemeral by design.
    if (this.sectorKey !== null) {
      this.ticksSinceSnapshot += 1;
      if (this.ticksSinceSnapshot >= 3600 /* 60 s at 60 Hz */) {
        this.ticksSinceSnapshot = 0;
        this.persistSectorSnapshot();
      }
    }

    // Broadcast authoritative snapshot at 20 Hz using an independent counter
    // on the main thread, not a SAB tick divisibility check. Divisibility caused
    // ~25% missed broadcasts when the two 60 Hz loops (worker + Colyseus) were
    // slightly out of phase. The counter fires every 3 main-thread update() calls
    // (= every 50 ms) regardless of which SAB tick value is currently visible.
    // Phase 5c: encode the binary swarm packet every server tick (60 Hz). The
    // encoder returns null when no pose has changed past the quantisation
    // epsilon (or when not every-60th-tick full-snapshot), so the wire cost is
    // dominated by the full-snapshot keyframe and the rare-but-real motion
    // deltas. Phase 5d: encode per-client with the spatial grid's 9-cell
    // interest window. Out-of-interest entities still ship at decimated
    // cadence inside the encoder.
    // GEP B4 — both per-tick entity-sync sends route through the EntitySyncRouter:
    // pose-core binary FIRST (builds the per-(client,tick) interestScratch), then
    // the json-slice snapshot slices (reuse it — no second query9; HC#4). The
    // router evaluates sector-idle BETWEEN the two sends (swarm.broadcast may apply
    // backpressure before idle reads clients.length — order preserved verbatim) and
    // fires the phaseTime markers at the same boundaries. The single-20 Hz cadence,
    // phase staggering, and idle-suppression rationale live in SnapshotBroadcaster
    // + server CLAUDE.md (Phase 3 snapshot-broadcast-rate) + docs/LESSONS.md.
    this.entitySync.route(phaseTime);

    // Phase 1 swift-otter — once per second, expire any WebRTC sessions
    // whose ICE deadline has elapsed without `onConnected`. Gated to
    // 1 Hz because the call iterates a (small) Map and the deadline is
    // 5 s anyway. broadcastCounter is the 60 Hz main-thread monotonic.
    if (this.webrtcChannelManager !== null && this.broadcastCounter % 60 === 0) {
      this.webrtcChannelManager.expireStale();
    }

    // Living World P1a — fly-over loot pickup every 6 ticks (~10 Hz; pickup
    // needs no prediction), pod TTL + drift re-save at ~1 Hz. Both early-out
    // when there are no pods (zero cost in a loot-free sector).
    if (this.broadcastCounter % 6 === 0) {
      this.loot.collectTick();
      // Living World P1a-2 — auto-deposit: hold position near your own storage.
      this.rigs.craneBays.tick();
      // Fire control: advance every pilot's target locks (~10 Hz).
      this.locks.step();
      // RTS slice 5: wingmen pick their stance target, then their locks advance.
      if (this.fleet.size > 0) {
        this.wingmen.tickWingmanTargets();
        this.wingmanLocks.step();
      }
      this.npcLocks.step();
    }
    if (this.broadcastCounter % 60 === 0) this.loot.sweep();

    // Tick AI AT THE END of update() so posted impulses reach the
    // worker BEFORE the next SAB read. See aiTickRunner.ts.
    runAiTick({
      aiController: this.aiController,
      serverTick: this.serverTick,
      playerToSlot: this.playerToSlot,
      getActiveShip: (id) => this.getActiveShip(id),
      shipPoseCache: this.shipPoseCache,
      aiPlayerScratch: this.aiPlayerScratch,
      aiStructureScratch: this.aiStructureScratch,
      fillStructureTargets: (out) => this.aiStructures.fill(out),
      aiSwarmScratch: this.aiSwarmScratch,
      fillSwarmTargets: this.aiGrids.fillSwarmTargets,
      aiNeighbourGrid: this.aiGrids.neighbours(),
      visitAiNeighbourDrones: this.aiGrids.visit,
      aiWreckGrid: this.aiGrids.wrecks(),
      hasTruce: (pid) => this.playerTruce(pid),
      // Living World P1a-2 (decision 7) — offline hulls are fair game.
      isPlayerConnected: this._isPlayerConnected,
      visitLingeringTargets: this._visitLingeringTargets,
      swarmEntitySnapshot: (id) => this.swarmEntitySnapshot(id),
      // Flock leaders and guard anchors: swarm ships, and (RTS Part B slice
      // 10) owned hulls and the ships pilots fly, so a squad packs on its
      // leader and an escort's zone follows the ship it guards.
      resolveEntityInto: this._resolveAiEntityInto,
      handleAiFire: (shooterId, dirX, dirY, tick, targetId, cone) => this.handleAiFire(shooterId, dirX, dirY, tick, targetId, cone),
      handleAiWarpOut: this._handleAiWarpOut,
      phaseTime,
    });
    // RTS Part B: squad bookkeeping only (the AI pilot brain flies the hulls).
    this.fleet.refreshSquads();
    this.fleetHooks.fleetStatusSoon.flush(this.serverTick, this.fleetHooks.sendFleetStatusNow);
    // Living World P3c — fire every NPC charge weapon whose wind-up elapsed.
    this.aiFireResolver.releaseCharges(this.serverTick);

    // Phase 4b.3 — server-authoritative turret rotation for player ships.
    // Mirrors the client's `tickLocalMountAim` so the server's hit-test
    // geometry uses the same rotated mount angles the client renders, and
    // so remote observers receive each ship's authoritative mount angles
    // through the snapshot extension below.
    this.tickPlayerMounts();
    // RTS slice 5: wingman turrets aim + fire through the player pipeline.
    if (this.fleet.size > 0) this.wingmen.tickWingmanFire();
    phaseTime('playerMounts');

    // Phase 4c (2026-05-11) — server-authoritative turret rotation for
    // drones with rotating mounts. Same lockstep model as players: server
    // computes the per-mount slewed angle each tick; the snapshot's
    // `drones[]` slice ships authoritative angles to in-interest clients;
    // `handleAiFire` uses the current mount angles for ray geometry, so a
    // drone's tracked beam actually lands where the visible barrel points.
    this.tickDroneMounts();
    phaseTime('droneMounts');
    // Shells as events: this tick's salvos (players, drones, turrets since the
    // last update) and hits, plus the 1 Hz re-test.
    this.shellHub?.flush();
    // Capital wrecks: pieces whose crack delay is over get their slow
    // separating kick (no-op with no wreck holding together).
    this.capitalWrecks?.tick();
    this.forceFields.tickTractors(); // tractor leases: re-pose, expire

    // Tick-budget telemetry. Cumulative phase totals across the last ~60 ticks
    // are emitted as one server event per second. The first capture told us
    // server tick rate was 46 Hz instead of 60 — this breakdown will tell us
    // which phase ate the budget so the fix is targeted, not speculative.
    const workerTickMs = (this.sabU32[WORKER_TICK_US_IDX] ?? 0) / 1000;
    const totalMs = this.tickBudget.endTick({
      serverTick: this.serverTick,
      workerTickMs,
      playerCount: this.playerToSlot.size,
      swarmCount: this.swarmRegistry.size(),
      aiSize: this.aiController.size(),
      liveProjectileCount: this.liveProjectiles.size,
      workerTick: this.sabU32[TICK_IDX] ?? 0,
      workerDroppedTicks: this.sabU32[WORKER_DROPPED_TICKS_IDX] ?? 0,
      timeScale: this.gameClock.scale,
    });
    if (this.sceneRunner) {
      const st = this.sceneRunner.getStatus();
      const running = st.started && !st.ended;
      if (running) {
        this.sceneTickRing!.push(totalMs); this.sceneWorkerRing!.push(workerTickMs);
        if (!this.sceneWork.active) { this.sceneEluStart = this.physicsWorkerProxy?.elu() ?? null; this.markSceneSim(this.sceneSimStart); }
        this.markSceneSim(this.sceneSimEnd);
        this.sceneWork.endTick(this.sabU32[COUNT_IDX] ?? 0, this.aiController.size());
        const lof = this.lineOfFire.built; if (lof) this.sceneWork.lineOfFire(lof.checks, lof.narrow);
        // Wreck-piece queries (hull avoidance) count as neighbour work too.
        this.sceneWork.aiNeighbours(this.aiGrids.queriesTotal);
        this.sceneWork.wingmen(this.fleet.size, this.wingmen.hullBrainTicksTotal, 0, 0);
        this.sceneWork.aiDecisions(this.aiController.stats.decisions);
        const ns = this.nav.stats; if (ns) this.sceneWork.nav(ns.routes, ns.expanded, ns.posts, ns.inFlight);
        this.sceneWork.wreckPiecesTick(this.capitalWrecks?.liveCount() ?? 0);
      }
      this.sceneWork.active = running;
    }

    // Phase 6 — drive the TiDi clock from whichever side is the bottleneck.
    // The server's `update()` time covers SAB-read / encode / broadcast; the
    // worker's most-recent step duration covers physics. The real budget
    // overrun is whichever is longer.
    const busiestMs = Math.max(totalMs, workerTickMs);
    // Perf scenes measure WORK: with the room's self-protection on, an overload
    // turns into a slower clock and shed drones instead of slower ticks.
    if (!this.perfFixedLoad) this.simClock.report(busiestMs);
    const newRate = this.simClock.rate;
    this.timeScale.applyLoadWindow(newRate);
    this.timeScale.slewTimeScale(tStart);
    // CLOCK_RATE now carries only `testTimeScale` (testMode physics-only
    // accelerator, default 1). `state.clockRate` mirrors the load factor for
    // the client's audio pitch + TiDi readout.
    const outboundRate = this.testTimeScale;
    if (Math.abs(outboundRate - this.lastSentClockRate) >= 1e-4) {
      this.lastSentClockRate = outboundRate;
      this.postToWorker({ type: 'CLOCK_RATE', rate: outboundRate });
    }
    if (this.state.clockRate !== this.timeScale.loadFactor) this.state.clockRate = this.timeScale.loadFactor;
    // Phase 6 second-lever: if rate is at floor and we're still over budget,
    // shed far drones in batches. No-op when rate > 0.71 or budget healthy.
    if (!this.perfFixedLoad) this.shedder.consider(newRate, busiestMs);
  }
}
