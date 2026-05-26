/**
 * LivingWorldDirector — the process-global brain that keeps a fixed pool
 * of hunter bots alive, distributed, and warping toward players.
 *
 * Single owner of bot lifecycle (Invariant #12 philosophy: one ownership
 * site). All 7 galaxy SectorRooms live in one Node process, so the
 * director holds direct references and performs the cross-room hop
 * server-internally — bots are NOT Colyseus clients, so the player
 * Limbo / reserveSeatFor / onJoin path cannot carry them.
 *
 * It composes:
 *   - the PURE `population` math (distribution / migration / respawn-sector /
 *     edge-pose, deterministic via injected `Rng`), via
 *     `director/HunterBotDistribution.ts`;
 *   - a per-bot `BotTransitController` (the pure `TransitStateMachine`),
 *     orchestrated via `director/HunterBotWarpController.ts`;
 *   - the bot-record lifecycle (state machine, idempotent respawn),
 *     via `director/HunterBotPool.ts`.
 *
 * It mutates the world only through the thin `LivingWorldRoom` hooks
 * (extracted to `LivingWorldRoom.ts` so the type lives beside the
 * sub-modules that consume it).
 */
import type { Bus } from '../../core/events/Bus.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { SPOOL_DURATION_MS } from '../../core/transit/TransitStateMachine.js';
import { BotTransitController } from './BotTransitController.js';
import { pickRespawnSector, sectorEdgePose, type Rng } from './population.js';
import { LivingWorldRoom } from './LivingWorldRoom.js';
import { HunterBotPool, type DirectorSnapshot } from './director/HunterBotPool.js';
import { HunterBotDistribution } from './director/HunterBotDistribution.js';
import { HunterBotWarpController } from './director/HunterBotWarpController.js';

// Re-export the room type so existing imports from this module keep working.
export type { LivingWorldRoom } from './LivingWorldRoom.js';
export type { BotRecord, DirectorSnapshot } from './director/HunterBotPool.js';

export const LIVING_WORLD_BOT_COUNT = 25;

export interface LivingWorldOptions {
  /** Total bots the director keeps alive. */
  botCount: number;
  /** Control-loop period (ms). Population/routing is discrete
   *  low-frequency logic — NOT a physics-tick concern. */
  controlIntervalMs: number;
  /** Dramatic delay between a combat kill and the bot warping back in
   *  "from outside known space" (user-chosen ~10–15 s). */
  respawnDelayMs: number;
  /** A just-arrived bot is not re-tasked for this long (anti-flap). */
  arrivalCooldownMs: number;
  /** Player-occupancy hysteresis: a sector that had a player within this
   *  window keeps attracting bots even if `playerCount()` momentarily
   *  reads 0. (diag 2026-05-16 q272do) */
  playerStickyMs: number;
  /** Max transits started per control tick (legible warp traffic). */
  maxMigrationsPerTick: number;
  /** Once no bot has been load-shed for this long, the paused population
   *  refills — cooperating with TiDi instead of fighting the shedder. */
  shedRecoveryMs: number;
  /** Initial warp-ins are spread out by this step so 25 bots don't all
   *  appear on the same tick. */
  initialStaggerMs: number;
  /** Per-bot vulnerable spool length (defaults to the player value). */
  spoolMs: number;
}

export const DEFAULT_LIVING_WORLD_OPTIONS: LivingWorldOptions = {
  botCount: LIVING_WORLD_BOT_COUNT,
  controlIntervalMs: 1500,
  respawnDelayMs: 12_000,
  arrivalCooldownMs: 5_000,
  playerStickyMs: 30_000,
  maxMigrationsPerTick: 4,
  shedRecoveryMs: 10_000,
  initialStaggerMs: 200,
  spoolMs: SPOOL_DURATION_MS,
};

export class LivingWorldDirector {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly sectorKeys: string[];
  private readonly opts: LivingWorldOptions;
  private readonly rng: Rng;
  private readonly nowMs: () => number;
  private readonly pool: HunterBotPool;
  private readonly distribution: HunterBotDistribution;
  private readonly warp: HunterBotWarpController;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastShedAtMs = -Infinity;
  /** Per-room (bus, handler) pairs for clean teardown. */
  private readonly subs: Array<{
    bus: Bus;
    onDestroyed: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void;
    onShed: (e: { type: 'ENTITY_SHED'; entityId: string }) => void;
  }> = [];

  constructor(
    rooms: Map<string, LivingWorldRoom>,
    options: Partial<LivingWorldOptions> & { rng?: Rng; nowMs?: () => number } = {},
  ) {
    this.rooms = rooms;
    this.sectorKeys = [...rooms.keys()];
    this.opts = { ...DEFAULT_LIVING_WORLD_OPTIONS, ...options };
    this.rng = options.rng ?? Math.random;
    this.nowMs = options.nowMs ?? Date.now;
    this.pool = new HunterBotPool({
      botCount: this.opts.botCount,
      initialStaggerMs: this.opts.initialStaggerMs,
      rng: this.rng,
      nowMs: this.nowMs,
    });
    this.distribution = new HunterBotDistribution();
    this.warp = new HunterBotWarpController({
      rooms: this.rooms,
      pool: this.pool,
      rng: this.rng,
      respawnDelayMs: this.opts.respawnDelayMs,
    });
  }

  /** Begin the control loop. Idempotent. The interval is `unref`'d so it
   *  never keeps the Node process alive on its own (mirrors the Limbo
   *  prune timer). */
  start(): void {
    if (this.timer) return;
    this.pool.seed(this.sectorKeys[0] ?? '');
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const onDestroyed = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        const rec = this.pool.get(e.entityId);
        if (rec) this.pool.scheduleRespawn(rec, this.opts.respawnDelayMs);
      };
      const onShed = (e: { type: 'ENTITY_SHED'; entityId: string }): void => {
        const rec = this.pool.get(e.entityId);
        if (!rec) return;
        this.lastShedAtMs = this.nowMs();
        // Shed-and-pause: schedule a refill, but the respawn step's
        // shed-recovery gate holds it until the load actually clears.
        this.pool.scheduleRespawn(rec, 0);
      };
      bus.on('ENTITY_DESTROYED', onDestroyed);
      bus.on('ENTITY_SHED', onShed);
      this.subs.push({ bus, onDestroyed, onShed });
    }
    const timer = setInterval(() => this.tick(), this.opts.controlIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Stop the loop, abandon in-flight transits, unsubscribe. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of this.subs) {
      s.bus.off('ENTITY_DESTROYED', s.onDestroyed);
      s.bus.off('ENTITY_SHED', s.onShed);
    }
    this.subs.length = 0;
    this.pool.disposeControllers();
  }

  /** Read-only introspection for tests / the `/dev/population` route. */
  snapshot(): DirectorSnapshot {
    return this.pool.snapshot(this.sectorKeys, (k) => {
      const room = this.rooms.get(k);
      return room ? room.playerCount() : 0;
    });
  }

  /** The control loop — see the class doc + plan for the algorithm. */
  private tick(): void {
    const now = this.nowMs();

    // ── 1. respawn / initial seed (gated by shed recovery) ───────────────
    this.respawnStep(now);

    // ── 2. distribution + migrations ─────────────────────────────────────
    const livePlayerCounts = new Map<string, number>();
    for (const [key, room] of this.rooms) livePlayerCounts.set(key, room.playerCount());
    const { migrations } = this.distribution.plan({
      sectorKeys: this.sectorKeys,
      livePlayerCounts,
      nowMs: now,
      pool: this.pool,
      playerStickyMs: this.opts.playerStickyMs,
      arrivalCooldownMs: this.opts.arrivalCooldownMs,
      maxMigrationsPerTick: this.opts.maxMigrationsPerTick,
    });
    for (const m of migrations) {
      const rec = this.pool.get(m.botId);
      if (!rec || rec.state !== 'active') continue;
      const fromRoom = this.rooms.get(m.from);
      if (!fromRoom) continue;
      rec.state = 'in-transit';
      const ctrl = new BotTransitController(rec.botId, fromRoom.eventBus(), this.opts.spoolMs);
      rec.controller = ctrl;
      fromRoom.eventBus().emit('BOT_TRANSIT_STARTED', {
        type: 'BOT_TRANSIT_STARTED',
        botId: rec.botId,
        from: m.from,
        to: m.to,
      });
      serverLogEvent('bot_transit_start', { botId: rec.botId, from: m.from, to: m.to });
      ctrl.begin({
        now: this.nowMs,
        commit: () => this.warp.doHop(rec, m.from, m.to),
        outcome: (res) => this.warp.onTransitOutcome(rec, m.from, m.to, res),
      });
    }

    // ── 3. proactive hunt: bots in player-occupied sectors aggro ─────────
    this.distribution.forEachActive(this.pool, (rec) => {
      const room = this.rooms.get(rec.sectorKey);
      if (room && room.playerCount() > 0) room.markBotHostile(rec.botId);
    });

    // ── 4. per-tick population telemetry (diag bucket: 'population') ──────
    const snap = this.snapshot();
    serverLogEvent('population_report', {
      total: snap.total,
      active: snap.active,
      inTransit: snap.inTransit,
      respawning: snap.respawning,
      perSector: snap.perSector,
    });
  }

  /** Step 1 of `tick`: warp-in respawning bots when their delay elapses
   *  AND shed recovery has cleared. */
  private respawnStep(now: number): void {
    const shedRecovered = now - this.lastShedAtMs > this.opts.shedRecoveryMs;
    for (const rec of this.pool.values()) {
      if (rec.state !== 'respawning' || rec.respawnAtMs > now || !shedRecovered) continue;
      const sector = pickRespawnSector(this.rng, this.sectorKeys);
      const room = this.rooms.get(sector);
      if (!room || !room.hasFreeSlot()) {
        rec.respawnAtMs = now; // keep retrying next tick
        continue;
      }
      const pose = sectorEdgePose(this.rng);
      const ok = room.spawnLivingWorldBot({
        botId: rec.botId,
        kind: rec.kind,
        x: pose.x,
        y: pose.y,
        vx: pose.vx,
        vy: pose.vy,
      });
      if (ok) {
        rec.state = 'active';
        rec.sectorKey = sector;
        rec.arrivedAtMs = now;
        serverLogEvent('bot_spawn', { botId: rec.botId, sectorKey: sector, kind: rec.kind });
      } else {
        rec.respawnAtMs = now;
      }
    }
  }
}
