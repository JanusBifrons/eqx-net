import { Room, Client } from 'colyseus';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { SectorState, ShipState, ObstacleState, ProjectileState } from './schema/SectorState.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema, FireMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage } from '../../shared-types/messages.js';
import {
  SEQLOCK_IDX,
  TICK_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  SLOT_APPLIED_TICK_OFF,
  slotBase,
  SAB_TOTAL_BYTES,
  MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';
import { SnapshotRing } from '../lagcomp/SnapshotRing.js';
import { checkBackpressure } from '../net/Backpressure.js';
import { validateToken } from '../auth/AuthService.js';
import { recordGameJoin, recordGameLeave, recordKill, saveSnapshot } from '../stats/StatsService.js';
import {
  rayHitsSphere,
  HITSCAN_DAMAGE,
  PROJECTILE_DAMAGE,
  HITSCAN_RANGE,
  PROJECTILE_SPEED,
  WEAPON_COOLDOWN_TICKS,
  PROJECTILE_RADIUS,
  SHIP_COLLISION_RADIUS,
} from '../../core/combat/Weapons.js';

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

// Bundle worker.ts to a self-contained JS string at startup. tsx's ESM loader
// hook does not reliably rewrite .js/.extensionless imports inside
// worker_threads on Node.js v22+; esbuild bundling sidesteps this entirely.
async function bundleWorker(): Promise<string> {
  const result = await build({
    entryPoints: [WORKER_TS_PATH],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    // Rapier ships a pre-built WASM binary; keep it external so the worker
    // accesses the same copy as the main thread (avoids double-init).
    external: ['@dimforge/rapier2d-compat'],
    sourcemap: 'inline',
  });
  return result.outputFiles[0]!.text;
}

const JoinOptionsSchema = z
  .object({
    playerId: z.string().nullable().optional(),
    authToken: z.string().optional(),
    spawnX: z.number().optional(),
    spawnY: z.number().optional(),
  })
  .passthrough();

const MAX_INPUTS_PER_TICK = 3;
const LAG_COMP_WINDOW = 12;
const PROJECTILE_MAX_TICKS = 180; // 3 s at 60 Hz

type WorkerCmd =
  | { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number }
  | { type: 'DESPAWN';        slot: number; playerId: string }
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number };

/** Fixed asteroid roster for the multiplayer diagnostic. Deterministic so both
 *  server and client-side prediction worlds stay in agreement. */
const ASTEROIDS: ReadonlyArray<{ id: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number }> = [
  { id: 'asteroid-0', x:  200, y:    0, vx: 0,   vy: 0,    radius: 32, mass: 5 },
  { id: 'asteroid-1', x: -180, y:  120, vx: 0.3, vy: -0.2, radius: 24, mass: 3 },
  { id: 'asteroid-2', x:   80, y: -220, vx: 0,   vy: 0,    radius: 40, mass: 7 },
];

interface ProjectileRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  birthTick: number;
}

export class SectorRoom extends Room<SectorState> {
  private physicsWorker!: Worker;
  private sab!: SharedArrayBuffer;
  private sabU32!: Uint32Array;
  private sabF32!: Float32Array;

  // Slot management — maps playerId ↔ integer SAB slot index.
  private playerToSlot = new Map<string, number>();
  private slotToPlayer = new Map<number, string>();
  private freeSlots: number[] = [];
  private initialSpawnPositions = new Map<string, { x: number; y: number }>();

  // Obstacles live in the same SAB slot pool as ships so the worker's state-
  // readout loop treats them uniformly; these maps let update() know which
  // entries feed the ships schema vs. the obstacles schema.
  private obstacleIdToSlot = new Map<string, number>();
  private slotToObstacleId = new Map<number, string>();

  private bus!: Bus;
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  private inputCountThisTick = new Map<string, number>();
  /** Last client input tick the physics worker confirmed it applied, read from SAB. */
  private sabAppliedTicks = new Map<string, number>();
  private serverTick = 0;
  private broadcastCounter = 0;
  private testMode = false;

  // Auth — maps playerId → userId (null for anonymous)
  private readonly playerToUser = new Map<string, string | null>();
  private readonly gameSessionRowIds = new Map<string, number>();

  // Combat
  private readonly snapshotRing = new SnapshotRing();
  private readonly lastFireClientTick = new Map<string, number>();
  private readonly liveProjectiles = new Map<string, ProjectileRecord>();
  private projectileCounter = 0;

  override async onCreate(options: unknown): Promise<void> {
    this.setState(new SectorState());
    this.bus = new Bus();

    // Fill slot pool (push in reverse so slot 0 is popped first).
    for (let i = MAX_ENTITIES - 1; i >= 0; i--) this.freeSlots.push(i);

    // Shared memory buffer for zero-copy physics state transfer.
    this.sab    = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    this.sabU32 = new Uint32Array(this.sab);
    this.sabF32 = new Float32Array(this.sab);

    await this.spawnWorker();

    // gameServer.define()'s 3rd arg flows into onCreate(options). test-sector
    // passes { testMode: true, asteroidConfig: [] } to run with no obstacles.
    const roomOpts = (options ?? {}) as {
      testMode?: boolean;
      asteroidConfig?: typeof ASTEROIDS;
    };
    this.testMode = roomOpts.testMode ?? false;
    const asteroidRoster = roomOpts.asteroidConfig ?? ASTEROIDS;

    // Seed the room with the asteroid roster. These exist for
    // the lifetime of the room and are never respawned.
    for (const a of asteroidRoster) {
      const slot = this.freeSlots.pop();
      if (slot === undefined) {
        logger.error({ obstacleId: a.id }, 'no free SAB slots for asteroid');
        break;
      }
      this.obstacleIdToSlot.set(a.id, slot);
      this.slotToObstacleId.set(slot, a.id);

      const base = slotBase(slot);
      this.sabF32[base + SLOT_X_OFF]  = a.x;
      this.sabF32[base + SLOT_Y_OFF]  = a.y;
      this.sabF32[base + SLOT_VX_OFF] = a.vx;
      this.sabF32[base + SLOT_VY_OFF] = a.vy;

      const entry = new ObstacleState();
      entry.obstacleId = a.id;
      entry.x = a.x; entry.y = a.y;
      entry.vx = a.vx; entry.vy = a.vy;
      entry.radius = a.radius;
      this.state.obstacles.set(a.id, entry);

      this.postToWorker({
        type: 'SPAWN_OBSTACLE', slot,
        obstacleId: a.id,
        x: a.x, y: a.y, vx: a.vx, vy: a.vy,
        radius: a.radius, mass: a.mass,
      });
    }

    this.onMessage('input', (client: Client, raw: unknown) => {
      const playerId = this.sessionToPlayer.get(client.sessionId);
      if (!playerId) return;

      const count = this.inputCountThisTick.get(playerId) ?? 0;
      if (count >= MAX_INPUTS_PER_TICK) return;
      this.inputCountThisTick.set(playerId, count + 1);

      const result = InputMessageSchema.safeParse(raw);
      if (!result.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed input message');
        return;
      }
      const { tick, thrust, turnLeft, turnRight } = result.data;
      const slot = this.playerToSlot.get(playerId);
      if (slot !== undefined) {
        this.postToWorker({ type: 'INPUT', slot, inputTick: tick, thrust, turnLeft, turnRight });
      }
    });

    this.onMessage('fire', (client: Client, raw: unknown) => {
      this.handleFire(client, raw);
    });

    this.onMessage('respawn', (client: Client) => {
      this.handleRespawn(client);
    });

    this.bus.on('SHIP_DESTROYED', (evt) => {
      const killerUser = this.playerToUser.get(evt.shooterId) ?? null;
      const victimUser = this.playerToUser.get(evt.targetId) ?? null;
      recordKill(killerUser, victimUser, 'hitscan', this.roomId);
    });

    this.setSimulationInterval(() => this.update(), 1000 / 60);
    logger.info('SectorRoom created');
  }

  // ── Combat ──────────────────────────────────────────────────────────────

  private handleFire(client: Client, raw: unknown): void {
    const parsed = FireMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ sessionId: client.sessionId }, 'malformed fire message');
      return;
    }
    const { tick, clientShotId, weapon, rayFromX, rayFromY, rayDirX, rayDirY } = parsed.data;

    const shooterId = this.sessionToPlayer.get(client.sessionId);
    if (!shooterId) return;

    const ship = this.state.ships.get(shooterId);
    if (!ship || !ship.alive) return;

    // Temporal plausibility: reject claims older than LAG_COMP_WINDOW ticks (~200 ms).
    if (this.serverTick - tick > LAG_COMP_WINDOW) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }

    // Weapon cooldown rate limit. Compare client tick values (not serverTick) so
    // RTT jitter between consecutive messages doesn't cause false rejections.
    const lastFireCt = this.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < WEAPON_COOLDOWN_TICKS) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }
    this.lastFireClientTick.set(shooterId, tick);

    // Normalize ray direction defensively.
    const len = Math.hypot(rayDirX, rayDirY);
    if (len < 0.001) return;
    const ndx = rayDirX / len;
    const ndy = rayDirY / len;

    if (weapon === 'projectile') {
      this.spawnServerProjectile(shooterId, rayFromX, rayFromY, ndx * PROJECTILE_SPEED, ndy * PROJECTILE_SPEED);
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
      return;
    }

    // Hitscan: lag-comp check against rewound positions of all other ships.
    let hitId: string | null = null;
    let hitDist = Infinity;

    for (const [targetId] of this.playerToSlot) {
      if (targetId === shooterId) continue;
      const targetShip = this.state.ships.get(targetId);
      if (!targetShip || !targetShip.alive) continue;

      // Use rewound position if available; fall back to current position.
      const rewound = this.snapshotRing.getAt(targetId, tick);
      const cx = rewound?.x ?? targetShip.x;
      const cy = rewound?.y ?? targetShip.y;

      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, cx, cy, SHIP_COLLISION_RADIUS);
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = targetId;
      }
    }

    if (hitId) {
      // Sampled LASER_FIRED log at 1 %.
      if (Math.random() < 0.01) {
        logger.info({ shooterId, hitId }, 'LASER_FIRED (1% sample)');
      }
      this.applyDamage(hitId, shooterId, HITSCAN_DAMAGE);
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: true, targetId: hitId };
      client.send('hit_ack', ack);
    } else {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
    }

    // Broadcast authoritative beam endpoint to ALL clients so they can render it.
    const beamEndX = rayFromX + ndx * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
    const beamEndY = rayFromY + ndy * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
    this.broadcast('laser_fired', {
      type: 'laser_fired',
      shooterId,
      fromX: rayFromX,
      fromY: rayFromY,
      toX: beamEndX,
      toY: beamEndY,
      hit: !!hitId,
      targetId: hitId ?? undefined,
    } satisfies LaserFiredEvent);
  }

  private spawnServerProjectile(ownerId: string, x: number, y: number, vx: number, vy: number): void {
    const projId = `proj-${this.projectileCounter++}`;
    this.liveProjectiles.set(projId, { x, y, vx, vy, ownerId, birthTick: this.serverTick });
    const ps = new ProjectileState();
    ps.projectileId = projId;
    ps.ownerId = ownerId;
    ps.x = x; ps.y = y;
    ps.vx = vx; ps.vy = vy;
    this.state.projectiles.set(projId, ps);
  }

  private applyDamage(targetId: string, shooterId: string, damage: number): void {
    const ship = this.state.ships.get(targetId);
    if (!ship || !ship.alive) return;
    ship.health = Math.max(0, ship.health - damage);

    const dmgEvent: DamageEvent = {
      type: 'damage',
      targetId,
      damage,
      newHealth: ship.health,
      shooterId,
    };
    this.broadcast('damage', dmgEvent);
    this.bus.emit('PLAYER_DAMAGED', { type: 'PLAYER_DAMAGED', targetId, damage, newHealth: ship.health });

    if (ship.health <= 0) {
      ship.alive = false;
      const destroyEvent: DestroyEvent = { type: 'destroy', targetId, shooterId };
      this.broadcast('destroy', destroyEvent);
      this.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
      logger.info({ targetId, shooterId }, 'ship destroyed');
    }
  }

  private handleRespawn(client: Client): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    const ship = this.state.ships.get(playerId);
    if (!ship || ship.alive) return; // only dead ships may respawn

    const slot = this.playerToSlot.get(playerId);
    if (slot === undefined) return;

    const storedPos = this.initialSpawnPositions.get(playerId);
    const spawnX = (this.testMode && storedPos) ? storedPos.x : (Math.random() - 0.5) * 400;
    const spawnY = (this.testMode && storedPos) ? storedPos.y : (Math.random() - 0.5) * 400;

    // Reset physics body in worker to new spawn position.
    this.postToWorker({ type: 'DESPAWN', slot, playerId });
    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY });

    // Pre-populate SAB so update() reads a sane position before the worker responds.
    const base = slotBase(slot);
    this.sabF32[base + SLOT_X_OFF]  = spawnX;
    this.sabF32[base + SLOT_Y_OFF]  = spawnY;
    this.sabF32[base + SLOT_VX_OFF] = 0;
    this.sabF32[base + SLOT_VY_OFF] = 0;

    // Reset authoritative ship state.
    ship.health = 100;
    ship.alive  = true;
    ship.x      = spawnX;
    ship.y      = spawnY;
    ship.vx     = 0;
    ship.vy     = 0;

    // Clear fire cooldown so first shot after respawn isn't rejected.
    this.lastFireClientTick.delete(playerId);

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);
    const ack: RespawnAckMessage = { type: 'respawn_ack', x: spawnX, y: spawnY, serverTick: currentServerTick };
    client.send('respawn_ack', ack);

    logger.info({ playerId, spawnX, spawnY }, 'player respawned');
  }

  private advanceProjectiles(): void {
    const DT = 1 / 60;
    for (const [projId, proj] of this.liveProjectiles) {
      proj.x += proj.vx * DT;
      proj.y += proj.vy * DT;

      // Lifetime check.
      if (this.serverTick - proj.birthTick >= PROJECTILE_MAX_TICKS) {
        this.liveProjectiles.delete(projId);
        this.state.projectiles.delete(projId);
        continue;
      }

      // Collision check against live ships.
      let hit = false;
      for (const [targetId] of this.playerToSlot) {
        if (targetId === proj.ownerId) continue;
        const targetShip = this.state.ships.get(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const dx = proj.x - targetShip.x;
        const dy = proj.y - targetShip.y;
        const minDist = PROJECTILE_RADIUS + SHIP_COLLISION_RADIUS;
        if (dx * dx + dy * dy < minDist * minDist) {
          this.applyDamage(targetId, proj.ownerId, PROJECTILE_DAMAGE);
          hit = true;
          break;
        }
      }

      if (hit) {
        const ps = this.state.projectiles.get(projId);
        if (ps) ps.destroyed = true;
        this.liveProjectiles.delete(projId);
        // Leave destroyed state in schema briefly so client sees it, then clean up next tick.
        continue;
      }

      // Update schema position.
      const ps = this.state.projectiles.get(projId);
      if (ps) {
        ps.x = proj.x;
        ps.y = proj.y;
      }
    }

    // Clean up destroyed entries from schema.
    for (const [projId, ps] of this.state.projectiles) {
      if (ps.destroyed && !this.liveProjectiles.has(projId)) {
        this.state.projectiles.delete(projId);
      }
    }
  }

  // ── Worker lifecycle ────────────────────────────────────────────────────

  private async spawnWorker(): Promise<void> {
    const workerCode = await bundleWorker();
    return new Promise<void>((resolve, reject) => {
      this.physicsWorker = new Worker(workerCode, {
        eval: true,
        workerData: { sab: this.sab },
      });

      let ready = false;

      this.physicsWorker.on('message', (msg: { type: string }) => {
        if (!ready && msg.type === 'READY') {
          ready = true;
          resolve();
        }
      });

      this.physicsWorker.on('error', (err) => {
        logger.error({ err }, 'physics worker error');
        if (!ready) reject(err);
      });

      this.physicsWorker.on('exit', (code) => {
        if (code !== 0) {
          logger.error({ code }, 'physics worker exited unexpectedly');
          if (!ready) reject(new Error(`physics worker exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!ready) reject(new Error('physics worker did not become READY within 10 s'));
      }, 10_000);
    });
  }

  private postToWorker(cmd: WorkerCmd): void {
    this.physicsWorker.postMessage(cmd);
  }

  // ── Colyseus room hooks ─────────────────────────────────────────────────

  override async onJoin(client: Client, options: unknown): Promise<void> {
    logger.info({ sessionId: client.sessionId, options }, 'onJoin called');
    const parsed = JoinOptionsSchema.safeParse(options);
    const requestedId = parsed.success ? parsed.data.playerId : null;
    let playerId = assignPlayerId(requestedId);

    const authToken = parsed.success ? parsed.data.authToken : undefined;
    const userId = authToken ? await validateToken(authToken) : null;

    // If the requested ID is already held by an active session (e.g. two tabs
    // sharing the same localStorage), assign a fresh UUID.
    if (this.playerToSession.has(playerId)) {
      playerId = assignPlayerId(null);
    }

    this.sessionToPlayer.set(client.sessionId, playerId);
    this.playerToSession.set(playerId, client.sessionId);

    const slot = this.freeSlots.pop();
    if (slot === undefined) {
      logger.error({ playerId }, 'no free SAB slots — room is full');
      client.leave(1001);
      return;
    }
    this.playerToSlot.set(playerId, slot);
    this.slotToPlayer.set(slot, playerId);
    this.snapshotRing.registerEntity(playerId);

    const parsedSpawnX = parsed.success ? parsed.data.spawnX : undefined;
    const parsedSpawnY = parsed.success ? parsed.data.spawnY : undefined;
    const spawnX = parsedSpawnX ?? (Math.random() - 0.5) * 400;
    const spawnY = parsedSpawnY ?? (Math.random() - 0.5) * 400;
    this.initialSpawnPositions.set(playerId, { x: spawnX, y: spawnY });

    // Pre-populate the SAB slot so the update() loop sees a sane position
    // immediately, before the worker processes the SPAWN command.
    const base = slotBase(slot);
    this.sabF32[base + SLOT_X_OFF] = spawnX;
    this.sabF32[base + SLOT_Y_OFF] = spawnY;

    // Create Colyseus schema entry.
    const ship = new ShipState();
    ship.playerId = playerId;
    ship.x = spawnX;
    ship.y = spawnY;
    this.state.ships.set(playerId, ship);

    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY });

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);
    const welcome: WelcomeMessage = { type: 'welcome', playerId, serverTick: currentServerTick };
    client.send('welcome', welcome);

    this.playerToUser.set(playerId, userId);
    const rowId = recordGameJoin(userId, playerId, this.roomId);
    this.gameSessionRowIds.set(playerId, rowId);

    this.bus.emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: spawnX, y: spawnY });
    serverLogEvent('player_join', { playerId, sessionId: client.sessionId, spawnX, spawnY });
    logger.info({ playerId, sessionId: client.sessionId, userId }, 'player joined');
  }

  override onLeave(client: Client, _consented: boolean): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    this.sessionToPlayer.delete(client.sessionId);
    this.playerToSession.delete(playerId);
    this.sabAppliedTicks.delete(playerId);
    this.lastFireClientTick.delete(playerId);
    this.initialSpawnPositions.delete(playerId);
    this.snapshotRing.unregisterEntity(playerId);

    const slot = this.playerToSlot.get(playerId);
    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    this.state.ships.delete(playerId);
    const rowId = this.gameSessionRowIds.get(playerId);
    if (rowId !== undefined) {
      recordGameLeave(rowId);
      this.gameSessionRowIds.delete(playerId);
    }
    this.playerToUser.delete(playerId);
    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    serverLogEvent('player_leave', { playerId });
    logger.info({ playerId }, 'player left');
  }

  override onDispose(): void {
    this.physicsWorker?.terminate();
    logger.info('SectorRoom disposed');
  }

  // ── Simulation loop (main thread — reads SAB, updates Colyseus schema) ──

  private update(): void {
    this.inputCountThisTick.clear();
    if (this.playerToSlot.size === 0 && this.obstacleIdToSlot.size === 0) return;

    // Seqlock read: retry if a write is in progress or if data was torn
    // (seqlock changed between the two loads).
    for (;;) {
      const seq1 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 & 1) continue; // odd → write in progress, spin

      for (const [playerId, slot] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (!ship) continue;
        const b = slotBase(slot);
        ship.x     = this.sabF32[b + SLOT_X_OFF]!;
        ship.y     = this.sabF32[b + SLOT_Y_OFF]!;
        ship.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
        ship.vx    = this.sabF32[b + SLOT_VX_OFF]!;
        ship.vy    = this.sabF32[b + SLOT_VY_OFF]!;
        ship.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
        // Decode applied tick: storedValue=0 means no input applied yet (use 0);
        // storedValue=N+1 means client tick N was applied.
        const storedTick = this.sabU32[b + SLOT_APPLIED_TICK_OFF]!;
        this.sabAppliedTicks.set(playerId, storedTick === 0 ? 0 : storedTick - 1);
      }

      for (const [obstacleId, slot] of this.obstacleIdToSlot) {
        const obs = this.state.obstacles.get(obstacleId);
        if (!obs) continue;
        const b = slotBase(slot);
        obs.x     = this.sabF32[b + SLOT_X_OFF]!;
        obs.y     = this.sabF32[b + SLOT_Y_OFF]!;
        obs.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
        obs.vx    = this.sabF32[b + SLOT_VX_OFF]!;
        obs.vy    = this.sabF32[b + SLOT_VY_OFF]!;
      }

      const seq2 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 === seq2) break; // consistent read
      // seq changed during read → writer modified data, retry
    }

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;

    // Record positions for lag compensation — alive ships only.
    this.snapshotRing.record(
      this.serverTick,
      Array.from(this.playerToSlot.keys())
        .filter((id) => {
          const ship = this.state.ships.get(id);
          return ship?.alive === true;
        })
        .map((id) => {
          const s = this.state.ships.get(id)!;
          return { id, x: s.x, y: s.y, vx: s.vx, vy: s.vy };
        }),
    );

    // Advance physical projectiles and check for collisions.
    this.advanceProjectiles();

    // Periodic snapshot: every 5 minutes (60 Hz × 300 s = 18 000 ticks).
    if (this.serverTick > 0 && this.serverTick % 18_000 === 0) {
      try { saveSnapshot(this.roomId, this.state.toJSON()); } catch { /* non-critical */ }
    }

    // Broadcast authoritative snapshot at 20 Hz using an independent counter
    // on the main thread, not a SAB tick divisibility check. Divisibility caused
    // ~25% missed broadcasts when the two 60 Hz loops (worker + Colyseus) were
    // slightly out of phase. The counter fires every 3 main-thread update() calls
    // (= every 50 ms) regardless of which SAB tick value is currently visible.
    if (++this.broadcastCounter >= 3 && this.serverTick > 0) {
      this.broadcastCounter = 0;
      const states: SnapshotMessage['states'] = {};
      const ackedTicks: SnapshotMessage['ackedTicks'] = {};
      for (const [playerId] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (ship && ship.alive) {
          states[playerId] = { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, angle: ship.angle, angvel: ship.angvel };
          ackedTicks[playerId] = this.sabAppliedTicks.get(playerId) ?? 0;
        }
      }
      const obstacles: SnapshotMessage['obstacles'] = {};
      for (const [id] of this.obstacleIdToSlot) {
        const o = this.state.obstacles.get(id);
        if (o) obstacles[id] = { x: o.x, y: o.y, vx: o.vx, vy: o.vy, angle: o.angle };
      }
      const snap: SnapshotMessage = { type: 'snapshot', serverTick: this.serverTick, states, ackedTicks, obstacles };

      // Per-client backpressure check before broadcast.
      for (const client of this.clients) {
        const bp = checkBackpressure(client, logger);
        if (bp === 'close') {
          client.leave(4002);
          continue;
        }
        if (bp === 'drop') continue;
        client.send('snapshot', snap);
      }

      serverLogEvent('snapshot_broadcast', {
        serverTick: this.serverTick,
        playerCount: this.playerToSlot.size,
        ackedTicks,
        states: Object.fromEntries(
          Object.entries(states).map(([id, s]) => [id, { x: parseFloat(s.x.toFixed(3)), y: parseFloat(s.y.toFixed(3)), vx: parseFloat(s.vx.toFixed(3)), vy: parseFloat(s.vy.toFixed(3)) }]),
        ),
      });
    }
  }
}
