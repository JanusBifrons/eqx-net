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
 * It composes the PURE `population` math (distribution / migration /
 * respawn-sector / edge-pose, deterministic via injected `Rng`) and a
 * per-bot `BotTransitController` (the pure `TransitStateMachine`). It
 * mutates the world only through the thin `LivingWorldRoom` hooks.
 *
 * Lifecycle is a guarded state machine; ENTITY_DESTROYED / ENTITY_SHED
 * bus events take precedence and every transition is idempotent, so the
 * many overlapping signals (kill-during-transit, shed-then-kill, …)
 * converge instead of racing. See the plan's risk audit.
 */
import type { Bus } from '../../core/events/Bus.js';
import { SPOOL_DURATION_MS } from '../../core/transit/TransitStateMachine.js';
import { SHIP_KINDS_LIST, type ShipKindId } from '../../shared-types/shipKinds.js';
import { BotTransitController } from './BotTransitController.js';
import type { BotCarry } from './botTypes.js';
import {
  computeDesiredDistribution,
  planMigrations,
  pickRespawnSector,
  sectorEdgePose,
  type Rng,
} from './population.js';

/** The narrow surface the director drives. `SectorRoom` satisfies this
 *  structurally (Step 3 hooks + the `eventBus` accessor); the director
 *  never imports the 3.8k-line room. */
export interface LivingWorldRoom {
  eventBus(): Bus;
  playerCount(): number;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
  }): boolean;
  despawnLivingWorldBot(botId: string): BotCarry | null;
  markBotHostile(botId: string): void;
}

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
  maxMigrationsPerTick: 4,
  shedRecoveryMs: 10_000,
  initialStaggerMs: 200,
  spoolMs: SPOOL_DURATION_MS,
};

type BotState = 'active' | 'in-transit' | 'respawning';

interface BotRecord {
  botId: string;
  kind: ShipKindId;
  /** Sector the bot is in while `active`; last sector otherwise. */
  sectorKey: string;
  state: BotState;
  /** Wall-clock the bot may (re)spawn — gated additionally by shed
   *  recovery. Meaningful only while `respawning`. */
  respawnAtMs: number;
  /** Wall-clock the bot last arrived somewhere (arrival-cooldown anchor). */
  arrivedAtMs: number;
  controller: BotTransitController | null;
}

export interface DirectorSnapshot {
  total: number;
  active: number;
  inTransit: number;
  respawning: number;
  perSector: Record<string, { players: number; bots: number }>;
}

export class LivingWorldDirector {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly sectorKeys: string[];
  private readonly opts: LivingWorldOptions;
  private readonly rng: Rng;
  private readonly nowMs: () => number;
  private readonly bots = new Map<string, BotRecord>();

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
  }

  /** Begin the control loop. Idempotent. The interval is `unref`'d so it
   *  never keeps the Node process alive on its own (mirrors the Limbo
   *  prune timer). */
  start(): void {
    if (this.timer) return;
    const now = this.nowMs();
    for (let i = 0; i < this.opts.botCount; i++) {
      const botId = `lwbot-${i}`;
      const kind = SHIP_KINDS_LIST[Math.floor(this.rng() * SHIP_KINDS_LIST.length)]!.id;
      this.bots.set(botId, {
        botId,
        kind,
        sectorKey: this.sectorKeys[0] ?? '',
        state: 'respawning',
        // Stagger the initial wave so 25 bots don't warp in on one tick.
        respawnAtMs: now + i * this.opts.initialStaggerMs,
        arrivedAtMs: now,
        controller: null,
      });
    }
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const onDestroyed = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        const rec = this.bots.get(e.entityId);
        if (rec) this.scheduleRespawn(rec, this.opts.respawnDelayMs);
      };
      const onShed = (e: { type: 'ENTITY_SHED'; entityId: string }): void => {
        const rec = this.bots.get(e.entityId);
        if (!rec) return;
        this.lastShedAtMs = this.nowMs();
        // Shed-and-pause: schedule a refill, but the respawn step's
        // shed-recovery gate holds it until the load actually clears.
        this.scheduleRespawn(rec, 0);
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
    for (const rec of this.bots.values()) {
      rec.controller?.dispose();
      rec.controller = null;
    }
  }

  /** Read-only introspection for tests / the `/dev/population` route. */
  snapshot(): DirectorSnapshot {
    const perSector: DirectorSnapshot['perSector'] = {};
    for (const [key, room] of this.rooms) {
      perSector[key] = { players: room.playerCount(), bots: 0 };
    }
    let active = 0;
    let inTransit = 0;
    let respawning = 0;
    for (const rec of this.bots.values()) {
      if (rec.state === 'active') {
        active++;
        const ps = perSector[rec.sectorKey];
        if (ps) ps.bots++;
      } else if (rec.state === 'in-transit') inTransit++;
      else respawning++;
    }
    return { total: this.bots.size, active, inTransit, respawning, perSector };
  }

  /** The control loop — see the class doc + plan for the algorithm. */
  private tick(): void {
    const now = this.nowMs();

    // ── 1. respawn / initial seed (gated by shed recovery) ───────────────
    const shedRecovered = now - this.lastShedAtMs > this.opts.shedRecoveryMs;
    for (const rec of this.bots.values()) {
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
      } else {
        rec.respawnAtMs = now;
      }
    }

    // ── 2. distribution + migrations ─────────────────────────────────────
    const playerCounts = new Map<string, number>();
    for (const [key, room] of this.rooms) playerCounts.set(key, room.playerCount());

    const current = new Map<string, string[]>();
    for (const k of this.sectorKeys) current.set(k, []);
    const frozen = new Set<string>();
    let activeCount = 0;
    for (const rec of this.bots.values()) {
      if (rec.state !== 'active') continue;
      activeCount++;
      current.get(rec.sectorKey)?.push(rec.botId);
      if (now - rec.arrivedAtMs < this.opts.arrivalCooldownMs) frozen.add(rec.botId);
    }

    const desired = computeDesiredDistribution({
      sectorKeys: this.sectorKeys,
      playerCounts,
      budget: activeCount,
    });
    const migrations = planMigrations({
      sectorKeys: this.sectorKeys,
      current,
      desired,
      maxPerTick: this.opts.maxMigrationsPerTick,
      frozen,
    });
    for (const m of migrations) {
      const rec = this.bots.get(m.botId);
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
      ctrl.begin({
        now: this.nowMs,
        commit: () => this.doHop(rec, m.from, m.to),
        outcome: (res) => this.onTransitOutcome(rec, m.from, m.to, res),
      });
    }

    // ── 3. proactive hunt: bots in player-occupied sectors aggro ─────────
    for (const rec of this.bots.values()) {
      if (rec.state !== 'active') continue;
      const room = this.rooms.get(rec.sectorKey);
      if (room && room.playerCount() > 0) room.markBotHostile(rec.botId);
    }
  }

  /** The atomic cross-room hop, invoked by the controller at spool end.
   *  Pre-checks the destination slot BEFORE despawning the source so a
   *  transit can't lose a bot to slot exhaustion. */
  private doHop(rec: BotRecord, from: string, to: string): boolean {
    const src = this.rooms.get(from);
    const dest = this.rooms.get(to);
    if (!src || !dest) return false;
    if (!dest.hasFreeSlot()) return false; // bot stays put; director retries
    const carry = src.despawnLivingWorldBot(rec.botId);
    if (!carry) return false; // already gone (killed/shed mid-spool) — handler owns it
    const pose = sectorEdgePose(this.rng);
    const ok = dest.spawnLivingWorldBot({
      botId: rec.botId,
      kind: carry.kind,
      x: pose.x,
      y: pose.y,
      vx: pose.vx,
      vy: pose.vy,
      health: carry.health,
    });
    if (!ok) {
      // True race: pre-check passed but the slot was taken between. The
      // bot already left the source — self-heal by warping it back in
      // from no-origin so the population converges back to N.
      rec.kind = carry.kind;
      this.scheduleRespawn(rec, this.opts.respawnDelayMs);
      return true; // accounted for via the respawn path
    }
    rec.kind = carry.kind;
    return true;
  }

  private onTransitOutcome(
    rec: BotRecord,
    from: string,
    to: string,
    res: 'arrived' | 'failed' | 'destroyed',
  ): void {
    // A lifecycle event (kill / shed / emergency respawn) may have taken
    // ownership while the controller settled — guard so we never clobber
    // a 'respawning' record back to 'active'.
    if (rec.state !== 'in-transit') return;
    if (res === 'arrived') {
      rec.state = 'active';
      rec.sectorKey = to;
      rec.arrivedAtMs = this.nowMs();
      rec.controller = null;
    } else if (res === 'failed') {
      rec.state = 'active';
      rec.sectorKey = from; // never left the source
      rec.controller = null;
    } else {
      // 'destroyed' but the ENTITY_DESTROYED handler hasn't run yet
      // (subscription-order race) — own the transition here; the handler
      // is idempotent when it follows.
      this.scheduleRespawn(rec, this.opts.respawnDelayMs);
    }
  }

  /** Idempotent: a record already heading for respawn is left alone, so
   *  the overlapping kill / shed / emergency / transit-outcome signals
   *  converge to a single scheduled warp-in. */
  private scheduleRespawn(rec: BotRecord, delayMs: number): void {
    if (rec.state === 'respawning') return;
    rec.state = 'respawning';
    rec.respawnAtMs = this.nowMs() + delayMs;
    rec.controller?.dispose();
    rec.controller = null;
  }
}
