/**
 * The room's boot-time swarm seed (`seedRoomStartup`): the sleep-test rock,
 * deterministic drone / structure poses, the bulk seed or the default drone
 * ring. Moved out of `scenarioLayouts.ts` (which keeps the test layouts) to
 * keep that file under the 600-line ceiling; runs once at `onCreate`.
 */
import type { Logger } from 'pino';
import { DEFAULT_SHIP_KIND, getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import type { AiController } from '../../core/ai/AiController.js';
import { ScriptedPathBehaviour } from '../../core/ai/ScriptedPathBehaviour.js';
import { STRUCTURE_DEFAULT_HEALTH } from '../../core/swarm/structureConstants.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import { getDroneMaxHealth, getDroneShieldMax } from './droneKindHelpers.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { SectorRoomOptions } from './sectorRoomOptions.js';

/** Room opts read by `seedRoomStartup` (a slice of the `SectorRoom.onCreate` options). */
export type StartupSeedOpts = Pick<SectorRoomOptions,
  'droneCount' | 'droneRadius' | 'swarmCount' | 'swarmRatio' | 'swarmRadius' | 'swarmAtRest' | 'dronePoses' | 'structurePoses'>;

/** Which startup seed the room picked (computed early in `onCreate`, where it
 *  also gates the legacy asteroid roster). */
export interface StartupSeedFlags {
  testMode: boolean;
  useSingleAsteroid: boolean;
  useDronePoses: boolean;
  useStructurePoses: boolean;
  useBulkSeed: boolean;
}

/** What `seedRoomStartup` reads from the room; getters for the fields the
 *  room assigns in `onCreate`. */
export interface StartupSeedHost {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  swarmRegistry: SwarmEntityRegistry;
  sandboxHostileDroneIds: string[];
  swarmSpawner: () => Pick<SwarmSpawner, 'spawnAsteroid' | 'spawnDrone' | 'spawnStructure' | 'seed'>;
  aiController: () => Pick<AiController, 'register'>;
  swarmHealth: () => Map<string, number>;
  swarmShield: () => Map<string, number>;
  swarmShieldLastDmg: () => Map<string, number>;
  serverTick: () => number;
  postToWorker: (cmd: WorkerCmd) => void;
  markElite: (botId: string, name: string, healthMul?: number, bounty?: number) => boolean;
}

/**
 * The room's boot-time swarm seed, exactly one of: the single sleep-test
 * asteroid, deterministic drone poses, deterministic structure poses, the
 * Phase 5e bulk seed, or (default) the small drone ring around spawn. Runs
 * once at `onCreate`, after the scenario / scale-grid seeds.
 */
export function seedRoomStartup(h: StartupSeedHost, roomOpts: StartupSeedOpts, flags: StartupSeedFlags): void {
  const { useSingleAsteroid, useDronePoses, useStructurePoses, useBulkSeed } = flags;
  if (useSingleAsteroid) {
    // Stationary asteroid 600 u from spawn — far enough that the worker's
    // sleep hysteresis (12 ticks at v ≈ 0) trips quickly without the
    // player accidentally bumping it. No drone, no AI behaviour wired.
    h.swarmSpawner().spawnAsteroid({ id: 'sleep-rock', x: 600, y: 0, vx: 0, vy: 0, radius: 24, mass: 1 });
    h.logger.info('Phase 5e single-asteroid sleep test seed');
  } else if (useDronePoses) {
    // 2026-05-28 — deterministic-pose engineering seed. Each entry forces a
    // drone to a specific world `(x, y, angle)` (bypassing the uniform-disc
    // spawner), and optionally drops shields immediately so the
    // hull-polygon collider is exposed at spawn. Used by the
    // `hull-collision-test` room to verify that a concave T-ship's
    // polygon collider correctly leaves the gap regions empty.
    seedDronePoses(h, roomOpts);
  } else if (useStructurePoses) {
    // Generic Entity Pipeline P4 — deterministic STRUCTURE placement (the
    // "for free" proof). Each structure is a kind=2 swarm entity; seeding
    // `swarmHealth` is the ONLY thing that makes it damageable — the existing
    // DamageRouter 'swarm' strategy then handles it with ZERO new dispatch.
    // `swarmShield = 0` (no shield layer) so a hit lands straight on the hull.
    const poses = roomOpts.structurePoses!;
    let placed = 0;
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i]!;
      const id = p.id ?? `structure-${i}`;
      const ok = h.swarmSpawner().spawnStructure({ id, x: p.x, y: p.y, radius: p.radius ?? 50, mass: p.mass });
      if (!ok) {
        h.logger.error({ requested: poses.length, spawned: placed }, 'structurePoses spawn truncated (slot pool exhausted)');
        break;
      }
      h.swarmHealth().set(id, STRUCTURE_DEFAULT_HEALTH);
      h.swarmShield().set(id, 0);
      placed++;
    }
    h.logger.info({ requested: poses.length, spawned: placed }, 'structurePoses seeded');
  } else if (useBulkSeed) {
    // Phase 5e bulk seed. Replaces both the legacy ASTEROIDS list and the
    // small drone ring with a sunflower-spiral spread across a disc, sized
    // by `swarmCount`. Used by the bandwidth E2E and the dev-machine soak.
    const requested = roomOpts.swarmCount ?? 0;
    const bulk = h.swarmSpawner().seed(requested, roomOpts.swarmRatio, roomOpts.swarmRadius, roomOpts.swarmAtRest ?? false);
    if (bulk < requested) {
      h.logger.error({ requested, spawned: bulk }, 'bulk seed truncated (slot pool exhausted)');
    }
    // Per-drone health is sourced from the chosen ship-kind's `maxHealth`
    // — Heavy drones eat more hits than Scout drones, mirroring the player
    // matrix. Falls back to 40 for back-compat when the registry record
    // doesn't carry a kind (very old codepaths or test stubs).
    for (const rec of h.swarmRegistry.all()) {
      if (rec.kind === 1) {
        h.swarmHealth().set(rec.id, getDroneMaxHealth(rec.shipKind) ?? 40);
        h.swarmShield().set(rec.id, getDroneShieldMax(rec.shipKind));
        h.swarmShieldLastDmg().set(rec.id, h.serverTick());
      }
    }
    h.logger.info({ requested, spawned: bulk }, 'Phase 5e bulk seed');
  } else {
    // Seed a small drone wave for early manual testing. Drones ring the
    // spawn area at a configurable distance (default 150u) so the player
    // can engage them immediately for smoke testing without a long drive.
    // Bump `droneRadius` per-room for less-frantic scenarios.
    const droneCount = roomOpts.droneCount ?? (flags.testMode ? 0 : 30);
    const droneRadius = roomOpts.droneRadius ?? 150;
    for (let i = 0; i < droneCount; i++) {
      const angle = (i / droneCount) * Math.PI * 2;
      const r = droneRadius;
      const id = `drone-${i}`;
      const ok = h.swarmSpawner().spawnDrone({ id, x: Math.cos(angle) * r, y: Math.sin(angle) * r });
      if (!ok) { h.logger.warn({ requested: droneCount, spawned: i }, 'drone wave truncated (slot pool full)'); break; }
      // Read the kind back from the registry record after spawn — the
      // spawner picks it randomly and stamps it onto the record.
      const rec = h.swarmRegistry.get(id);
      h.swarmHealth().set(id, getDroneMaxHealth(rec?.shipKind) ?? 40);
      h.swarmShield().set(id, getDroneShieldMax(rec?.shipKind));
      h.swarmShieldLastDmg().set(id, h.serverTick());
    }
  }
}

/** The `dronePoses` branch of `seedRoomStartup`. */
function seedDronePoses(h: StartupSeedHost, roomOpts: StartupSeedOpts): void {
  const poses = roomOpts.dronePoses!;
  let placed = 0;
  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i]!;
    const droneId = `pose-drone-${i}`;
    const ok = h.swarmSpawner().spawnDrone({ id: droneId, x: pose.x, y: pose.y, kind: pose.kind });
    if (!ok) {
      h.logger.error({ requested: poses.length, spawned: placed }, 'dronePoses spawn truncated (slot pool exhausted)');
      break;
    }
    const rec = h.swarmRegistry.get(droneId);
    if (!rec) continue;
    if (pose.path) {
      // Radar sandbox — scripted fly-in / fly-out / tangential pass.
      const mass = shipBodyMass(getShipKind(pose.kind));
      h.aiController().register(droneId, rec.slot, new ScriptedPathBehaviour({
        from: { x: pose.x, y: pose.y },
        to: { x: pose.path.toX, y: pose.path.toY },
        speed: pose.path.speed,
        loop: pose.path.loop ?? true,
      }, mass));
    }
    if (pose.hostile) h.sandboxHostileDroneIds.push(droneId);
    h.swarmHealth().set(droneId, getDroneMaxHealth(rec.shipKind) ?? 40);
    h.swarmShield().set(droneId, getDroneShieldMax(rec.shipKind));
    h.swarmShieldLastDmg().set(droneId, h.serverTick());
    // Apply rotation via SET_POSITION (SPAWN_OBSTACLE sets pos+vel only,
    // angle defaults to 0). The worker processes this command AFTER the
    // SPAWN_OBSTACLE that spawnDrone just enqueued, so the body exists.
    // Also seed the registry's lastBroadcast.angle so the very first
    // delta-detector decision uses the correct reference.
    const angle = pose.angle ?? 0;
    const vx = pose.vx ?? 0;
    const vy = pose.vy ?? 0;
    if (angle !== 0 || vx !== 0 || vy !== 0) {
      h.postToWorker({
        type: 'SET_POSITION',
        entityId: droneId, x: pose.x, y: pose.y, angle, vx, vy, angvel: 0,
      });
      rec.lastBroadcast.angle = angle;
    }
    if (pose.hullExposed) {
      // Force shield-down at spawn: clear the shield slot, flip the
      // registry's wire flag, post SET_HULL_EXPOSED so Rapier swaps to
      // the polygon collider. Mirrors `ShieldHullRouter`'s 0-cross path
      // minus the discrete `shield_broken` broadcast (no client cares
      // at room-boot time; subsequent regen will fire the normal events).
      h.swarmShield().set(droneId, 0);
      rec.shieldDown = true;
      h.postToWorker({
        type: 'SET_HULL_EXPOSED',
        id: droneId,
        exposed: true,
        kindId: rec.shipKind ?? DEFAULT_SHIP_KIND,
        tick: h.serverTick(),
      });
    }
    if (pose.elite) h.markElite(droneId, pose.elite.name, pose.elite.healthMul, pose.elite.bounty);
    placed++;
  }
  h.logger.info({ requested: poses.length, spawned: placed }, 'dronePoses seeded');
}
