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
import { HunterBotPool, type BotRecord, type DirectorSnapshot } from './director/HunterBotPool.js';
import { HunterBotWarpController } from './director/HunterBotWarpController.js';
import { SquadPool, SQUAD_SIZE, LIVING_WORLD_SQUAD_COUNT } from './director/SquadPool.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { WaveSquadBehaviour } from './director/SquadBehaviour.js';
import { EscalatingWavePattern } from './director/WavePattern.js';
import { WaveDirector, type WaveStep } from './director/WaveDirector.js';

// Re-export the room type so existing imports from this module keep working.
export type { LivingWorldRoom } from './LivingWorldRoom.js';
export type { BotRecord, DirectorSnapshot } from './director/HunterBotPool.js';

/** Total director-owned bots = squads × members (wave-system Phase 3/4). The
 *  bots are organised into `LIVING_WORLD_SQUAD_COUNT` homogeneous squads of
 *  `SQUAD_SIZE`. (Was a flat 25 before the squad refactor.) */
export const LIVING_WORLD_BOT_COUNT = LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE;

/** Ops kill-switch for the Living World hunter bots. When
 *  `EQX_DISABLE_LIVING_WORLD` is `1`/`true`, the server boot SKIPS constructing
 *  and starting the director — so no hunter bots spawn, migrate, or attack.
 *  Post wave-refactor (Phase 4) the ONLY proactive-aggression source is the
 *  WaveDirector declaring a wave against a ready base (the old on-sight
 *  occupancy aggro is retired). Ambient per-sector drones are unaffected: they
 *  remain NEUTRAL and only fight back if the player shoots them (the reactive
 *  `damage → markHostile` mirror), so building gameplay is peaceful with the
 *  switch set. Read once at boot — temporary by design: unset + restart to
 *  re-arm. */
export function isLivingWorldDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env['EQX_DISABLE_LIVING_WORLD'];
  return v === '1' || v === 'true';
}

/** Director-level drone-squad spool override (ms), read from `EQX_BOT_SPOOL_MS`.
 *  Returns `undefined` (⇒ use `SPOOL_DURATION_MS`, 5 min) when unset/invalid.
 *
 *  WHY a director env and not the per-room `transitSpoolMsOverride`: the
 *  director constructs every `BotTransitController(..., this.opts.spoolMs)`
 *  itself, so a per-room JoinOption never reaches a bot's spool. Tests that
 *  exercise the bot warp pipeline through the *production* director
 *  (`living-world.spec.ts` convergence poll) would otherwise wait 5 min per
 *  hop — they set this env to a small value. Read once at boot. */
export function resolveBotSpoolMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env['EQX_BOT_SPOOL_MS'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

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

/** Display label for a squad's homogeneous hull in the warp-in warning
 *  ("8 × Legionnaires"). v1 squads are all `fighter`, shown as "Legionnaire"
 *  (a flavour codename, NOT a ship-kind — invariant #11; the wire `shipKind`
 *  stays `fighter`). A future mixed-kind WavePattern extends this map. */
export function squadDisplayLabel(kind: ShipKindId): string {
  return kind === 'fighter' ? 'Legionnaire' : kind;
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
  private readonly warp: HunterBotWarpController;
  private readonly squadPool: SquadPool;
  private readonly waveDirector: WaveDirector;

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
    this.warp = new HunterBotWarpController({
      rooms: this.rooms,
      pool: this.pool,
      rng: this.rng,
      respawnDelayMs: this.opts.respawnDelayMs,
    });
    this.squadPool = new SquadPool();
    this.waveDirector = new WaveDirector({
      rooms: this.rooms,
      squadPool: this.squadPool,
      hunterPool: this.pool,
      behaviour: new WaveSquadBehaviour(),
      pattern: new EscalatingWavePattern(),
    });
  }

  /** Begin the control loop. Idempotent. The interval is `unref`'d so it
   *  never keeps the Node process alive on its own (mirrors the Limbo
   *  prune timer). */
  start(): void {
    if (this.timer) return;
    const homeSector = this.sectorKeys[0] ?? '';
    this.pool.seed(homeSector);
    // Group the pool into homogeneous squads (v1: all 'fighter', shown as
    // "8 × Legionnaires" in the warp warning). Each member's hull is forced to
    // its squad's kind so the squad is visually homogeneous and the warning
    // label is honest (a future WavePattern can vary the kind per squad).
    const botIds = [...this.pool.values()].map((r) => r.botId);
    // Spread squads across the galaxy so they don't all pile into one sector;
    // each squad gathers at its own home until a wave routes it elsewhere.
    const keys = this.sectorKeys;
    this.squadPool.seed(
      botIds,
      (i) => keys[i % keys.length] ?? homeSector,
      () => 'fighter',
    );
    for (const rec of this.pool.values()) {
      const squad = this.squadPool.squadOf(rec.botId);
      if (squad) rec.kind = squad.kind;
    }
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

  /**
   * The control loop. Wave-driven (wave-system Phase 4): the old occupancy
   * distribution + proactive on-sight aggro (step 3) are RETIRED — drones go
   * hostile ONLY via the faction ledger (a wave declared against a ready base,
   * or a faction member attacking a drone). A player with no base roams an
   * unhunted galaxy (req #6, accepted).
   */
  private tick(): void {
    const now = this.nowMs();

    // ── 1. respawn (squad-aware) + forming/retreating → idle promotion ───
    this.respawnStep(now);
    this.promoteSquads();

    // ── 2. wave planning + squad advancement ─────────────────────────────
    for (const step of this.waveDirector.plan()) this.executeWaveStep(step);

    // ── 3. telemetry (population + squad/wave counts) ────────────────────
    const snap = this.snapshot();
    const squads = this.squadPool.snapshot();
    serverLogEvent('population_report', {
      total: snap.total,
      active: snap.active,
      inTransit: snap.inTransit,
      respawning: snap.respawning,
      perSector: snap.perSector,
      squads: squads.byState,
    });
  }

  /** Promote squads whose members have spawned (forming→idle) and squads that
   *  have stood down (retreating→idle, ready for a fresh assignment). */
  private promoteSquads(): void {
    for (const sq of this.squadPool.all()) {
      if (sq.state === 'forming') {
        const active = this.squadPool.activeMemberCount(
          sq,
          (id) => this.pool.get(id)?.state === 'active',
        );
        if (active > 0) this.squadPool.setState(sq, 'idle');
      } else if (sq.state === 'retreating') {
        this.squadPool.setState(sq, 'idle');
      }
    }
  }

  /** Execute one WaveDirector step (the side-effecting half — the planning is
   *  pure in WaveDirector). */
  private executeWaveStep(step: WaveStep): void {
    switch (step.kind) {
      case 'warp': {
        this.squadPool.setState(step.squad, 'warping');
        // Coordinated warp: every active member spools from its current sector
        // to the target in the SAME control tick (they arrive together, modulo
        // partial arrival under slot contention / mid-spool death — accepted).
        let warping = 0;
        for (const botId of step.squad.botIds) {
          const rec = this.pool.get(botId);
          if (!rec || rec.state !== 'active' || rec.sectorKey === step.to) continue;
          this.startSquadMemberTransit(rec, rec.sectorKey, step.to);
          warping++;
        }
        // ONE warp-in warning to the destination sector (not one per bot): the
        // HUD countdown banner. countdownMs = the spool the bots are serving;
        // it self-expires ≈ when they arrive, so no explicit clear is needed.
        const destRoom = this.rooms.get(step.to);
        if (destRoom && warping > 0) {
          destRoom.broadcastWarpWarning({
            type: 'warp_warning',
            id: step.squad.squadId,
            label: squadDisplayLabel(step.squad.kind),
            count: warping,
            countdownMs: this.opts.spoolMs,
            kind: step.squad.kind,
          });
        }
        break;
      }
      case 'attack': {
        this.squadPool.setState(step.squad, 'attacking');
        const room = this.rooms.get(step.sectorKey);
        if (room) {
          room.setFactionUnderWave(step.factionId, true);
          // Re-pulsed every control tick while attacking (beats FORGET_TICKS).
          room.markSquadHostileToFaction(step.squad.botIds, step.factionId);
        }
        break;
      }
      case 'retreat': {
        this.squadPool.setState(step.squad, 'retreating');
        const room = this.rooms.get(step.sectorKey);
        if (room) {
          room.setFactionUnderWave(step.factionId, false);
          room.purgeFactionHostility(step.factionId);
        }
        this.squadPool.clearTarget(step.squad);
        serverLogEvent('wave_deescalated', { factionId: step.factionId, sectorKey: step.sectorKey });
        break;
      }
    }
  }

  /** Spool one squad member from→to via the proven per-bot transit machinery
   *  (vulnerable spool, race-guarded outcome routing). Extracted from the old
   *  distribution-migration loop. */
  private startSquadMemberTransit(rec: BotRecord, from: string, to: string): void {
    const fromRoom = this.rooms.get(from);
    if (!fromRoom) return;
    rec.state = 'in-transit';
    const ctrl = new BotTransitController(rec.botId, fromRoom.eventBus(), this.opts.spoolMs);
    rec.controller = ctrl;
    fromRoom.eventBus().emit('BOT_TRANSIT_STARTED', {
      type: 'BOT_TRANSIT_STARTED',
      botId: rec.botId,
      from,
      to,
    });
    serverLogEvent('bot_transit_start', { botId: rec.botId, from, to });
    ctrl.begin({
      now: this.nowMs,
      commit: () => this.warp.doHop(rec, from, to),
      outcome: (res) => this.warp.onTransitOutcome(rec, from, to, res),
    });
  }

  /** Step 1 of `tick`: warp-in respawning bots when their delay elapses
   *  AND shed recovery has cleared. */
  private respawnStep(now: number): void {
    const shedRecovered = now - this.lastShedAtMs > this.opts.shedRecoveryMs;
    for (const rec of this.pool.values()) {
      if (rec.state !== 'respawning' || rec.respawnAtMs > now || !shedRecovered) continue;
      // Squad-aware respawn (hostile-review C4): a member of a committed squad
      // warps back into ITS squad's sector so "fight together" survives a
      // death; otherwise (unassigned / still forming) fall back to the ambient
      // random sector.
      const sector =
        this.squadPool.respawnSectorFor(rec.botId) ?? pickRespawnSector(this.rng, this.sectorKeys);
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
