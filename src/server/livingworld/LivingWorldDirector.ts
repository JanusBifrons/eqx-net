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
 *     via `director/HunterBotPool.ts`;
 *   - hop-by-hop traversal (`director/SquadTraversal.ts`), the incoming banner
 *     (`director/IncomingBanners.ts`), galaxy-map views
 *     (`director/GalaxyStatsView.ts`), save/restore (`DirectorPersistence.ts`)
 *     and the options/hooks record (`LivingWorldOptions.ts`).
 *
 * It mutates the world only through the thin `LivingWorldRoom` hooks
 * (extracted to `LivingWorldRoom.ts` so the type lives beside the
 * sub-modules that consume it).
 */
import type { Bus, BusEventPayloads } from '../../core/events/Bus.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { guarded } from '../rooms/guardedLoop.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { liveEntrySectors, type Rng } from './population.js';
import type { BotCarry } from './botTypes.js';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type { SectorStructurePresence } from '../../shared-types/galaxyPresence.js';
import { LivingWorldRoom } from './LivingWorldRoom.js';
import { HunterBotPool, type DirectorSnapshot } from './director/HunterBotPool.js';
import { HunterBotWarpController } from './director/HunterBotWarpController.js';
import { SquadPool } from './director/SquadPool.js';
import { WaveSquadBehaviour } from './director/SquadBehaviour.js';
import { SquadHerding } from './director/SquadHerding.js';
import { HunterBotRespawner } from './director/HunterBotRespawner.js';
import type { DirectorActivity } from './director/DirectorActivity.js';
import { EscalatingWavePattern } from './director/WavePattern.js';
import { WaveDirector, type WaveStep } from './director/WaveDirector.js';
import { GalaxyStatsView } from './director/GalaxyStatsView.js';
import { IncomingBanners } from './director/IncomingBanners.js';
import { SquadTraversal } from './director/SquadTraversal.js';
import type { WarpWarningEvent } from '../../shared-types/messages.js';
import {
  DIRECTOR_PERSIST_INTERVAL_MS,
  applyDirectorState,
  buildDirectorState,
  type DirectorPersistence,
  type DirectorStateHost,
} from './DirectorPersistence.js';
import {
  DEFAULT_LIVING_WORLD_OPTIONS,
  type LivingWorldOptions,
  type LivingWorldHooks,
} from './LivingWorldOptions.js';
import { gameNow, gameSetInterval, gameClearTimer, type GameTimer } from '../time/gameTime.js';

// Re-export the room type so existing imports from this module keep working.
export type { LivingWorldRoom } from './LivingWorldRoom.js';
export type { BotRecord, DirectorSnapshot } from './director/HunterBotPool.js';

export {
  LIVING_WORLD_BOT_COUNT,
  isLivingWorldDisabled,
  resolveBotSpoolMs,
  resolveBotHopMs,
  DRONE_HOP_SPOOL_MS,
  DEFAULT_LIVING_WORLD_OPTIONS,
  type LivingWorldOptions,
  type LivingWorldHooks,
} from './LivingWorldOptions.js';

export { hopSpoolMs, decideRallyRelease } from './director/SquadTraversal.js';

export { squadDisplayLabel } from './director/IncomingBanners.js';

export { FORMATION_DEST_RANGE, flockCentre } from './director/SquadHerding.js';

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
  /** HUD "incoming ships" banner feed (`director/IncomingBanners.ts`). */
  private readonly incoming: IncomingBanners;
  /** Hop-by-hop squad-member traversal (`director/SquadTraversal.ts`). */
  private readonly traversal: SquadTraversal;
  /** Galaxy-map read-only views (`director/GalaxyStatsView.ts`). */
  private readonly galaxyStats: GalaxyStatsView;
  /** Save/restore view of this director (`DirectorPersistence.ts`), built once. */
  private readonly stateHost: DirectorStateHost;
  /** Phase 5 — optional director-state persistence ("restart from any state").
   *  Null in tests / when no sink is injected (⇒ today's fresh seed every boot). */
  private readonly directorPersistence: DirectorPersistence | null;
  private readonly hooks: LivingWorldHooks;

  private timer: GameTimer | null = null;
  private lastShedAtMs = -Infinity;
  /** Wall-clock of the last in-loop crash-defence persist (throttle anchor). */
  private lastPersistAtMs = -Infinity;
  /** Roam + merged clusters + in-sector herding (`director/SquadHerding.ts`). */
  private readonly herding: SquadHerding;
  /** Respawn ingress + arrival resolvers (`director/HunterBotRespawner.ts`). */
  private readonly respawner: HunterBotRespawner;
  /** Extension point: control-tick world activities, run in order (step 2b).
   *  A new activity is a `DirectorActivity` file + one entry here. */
  private readonly activities: readonly DirectorActivity[];
  /** Per-room (bus, handler) pairs for clean teardown. */
  private readonly subs: Array<{
    bus: Bus;
    onDestroyed: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void;
    onShed: (e: { type: 'ENTITY_SHED'; entityId: string }) => void;
    onDeparted: (e: BusEventPayloads['BOT_DESPAWNED']) => void;
  }> = [];

  constructor(
    rooms: Map<string, LivingWorldRoom>,
    options: Partial<LivingWorldOptions> & {
      rng?: Rng;
      nowMs?: () => number;
      /** Phase 5 — inject to make the director persist + restore its squad
       *  continuity across a restart. Omit ⇒ stateless (today's fresh seed). */
      directorPersistence?: DirectorPersistence;
      hooks?: LivingWorldHooks;
    } = {},
  ) {
    this.rooms = rooms;
    this.sectorKeys = [...rooms.keys()];
    this.opts = { ...DEFAULT_LIVING_WORLD_OPTIONS, ...options };
    this.rng = options.rng ?? Math.random;
    this.nowMs = options.nowMs ?? gameNow;
    this.directorPersistence = options.directorPersistence ?? null;
    this.hooks = { ...(options.hooks ?? {}) };
    this.pool = new HunterBotPool({
      botCount: this.opts.botCount,
      initialStaggerMs: this.opts.initialStaggerMs,
      rng: this.rng,
      nowMs: this.nowMs,
      botIdPrefix: this.opts.botIdPrefix,
    });
    this.warp = new HunterBotWarpController({
      rooms: this.rooms,
      pool: this.pool,
      rng: this.rng,
      respawnDelayMs: this.opts.respawnDelayMs,
      hopTravelMs: this.opts.hopTravelMs,
      // Lazy (squadPool is constructed just below) — resolved at hop-arrival time
      // so a squad re-forms clustered at each sector it hops into.
      squadKeyOf: (botId) => this.squadPool.squadOf(botId)?.squadId ?? botId,
      // WS-E #15 — resolve inline hostility at the ARRIVAL instant so a member
      // landing in its squad's target (base) sector is hostile in the same step
      // as spawn — closing the warp-arrive race that left it neutral until the
      // next ~1.5 s control-tick `markSquadHostileToFaction` pulse.
      hostileSpecFor: (botId, sectorKey) => this.hostileSpecFor(botId, sectorKey),
      // WS-E #13/#19 — a WAVE hop arrives at its CARRY pose (clamped) so attackers
      // arrive spread near where they left, not stacked at one edge anchor; roam
      // hops return null → the edge spawn (enter from outside, never on-top).
      arrivalPoseFor: (botId, to, carry) => this.arrivalPoseFor(botId, to, carry),
    });
    this.squadPool = new SquadPool();
    this.waveDirector = new WaveDirector({
      rooms: this.rooms,
      squadPool: this.squadPool,
      hunterPool: this.pool,
      behaviour: new WaveSquadBehaviour(),
      pattern: new EscalatingWavePattern(),
      dispatchIntervalMs: this.opts.dispatchIntervalMs,
      waveMaxAttackMs: this.opts.waveMaxAttackMs,
    });
    const shared = { rooms: this.rooms, sectorKeys: this.sectorKeys, pool: this.pool, squadPool: this.squadPool, rng: this.rng, opts: this.opts };
    this.respawner = new HunterBotRespawner({ ...shared, hooks: this.hooks, lastShedAtMs: () => this.lastShedAtMs });
    this.herding = new SquadHerding({ ...shared, advanceMembersTowardGoal: (sq) => this.advanceMembersTowardGoal(sq) });
    this.activities = [this.herding];
    this.incoming = new IncomingBanners({ rooms: this.rooms, pool: this.pool, squadPool: this.squadPool, herding: this.herding, opts: this.opts });
    this.traversal = new SquadTraversal({ rooms: this.rooms, pool: this.pool, warp: this.warp, incoming: this.incoming, opts: this.opts, nowMs: this.nowMs });
    this.galaxyStats = new GalaxyStatsView({ rooms: this.rooms, pool: this.pool, squadPool: this.squadPool, hooks: this.hooks });
    this.stateHost = { squadPool: this.squadPool, waveDirector: this.waveDirector, hooks: this.hooks };
  }

  /** Begin the control loop. Idempotent. The interval is `unref`'d so it
   *  never keeps the Node process alive on its own (mirrors the Limbo
   *  prune timer). */
  start(): void {
    if (this.timer) return;
    // Squads home at ENTRY (edge) sectors — every drone enters the galaxy from
    // the edge and hops inward (drone-warp-in design); none is seeded into an
    // interior sector. `liveEntrySectors` intersects the global edge ring with
    // the rooms we actually hold (+ falls back to all live rooms for a
    // single-interior test harness).
    const entryKeys = liveEntrySectors(this.sectorKeys);
    const homeSector = entryKeys[0] ?? this.sectorKeys[0] ?? '';
    this.pool.seed(homeSector);
    // Group the pool into squads. Drones: homogeneous 'fighter' squads (shown as
    // "8 × Legionnaires" in the warp warning). Robots (P1b): mixed-tier squads
    // via the layout's per-slot `memberKind`. Each member's hull is forced to its
    // seeded slot kind so the squad renders exactly as laid out.
    const botIds = [...this.pool.values()].map((r) => r.botId);
    // Spread squad homes across the entry sectors so they don't all pile into
    // one edge; each squad gathers at its home entry until a wave routes it.
    const leadKind = this.opts.leadKind;
    this.squadPool.seed(
      botIds,
      (i) => entryKeys[i % entryKeys.length] ?? homeSector,
      () => leadKind,
      this.opts.squadLayout,
    );
    for (const rec of this.pool.values()) {
      const kind = this.squadPool.memberKindOf(rec.botId);
      if (kind !== undefined) rec.kind = kind;
    }
    // Phase 5 — "restart from any state": overlay persisted squad continuity onto
    // the fresh seed (sectors / targets / states + wave bookkeeping). Bots stay
    // `respawning` from `pool.seed`; the first `tick()` respawns each at its
    // squad's RESTORED sector and `waveDirector.plan` resumes the wave (or cleanly
    // stands down per live readiness). No-op (today's fresh seed) when no row.
    this.restoreFromPersistence();
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
      // A bot that fled (its own morale warp-out) left the sector for good:
      // free its record like a loss, so the pool refills (2026-11-14). A
      // 'transit' despawn is the director's own move and is not a loss.
      const onDeparted = (e: BusEventPayloads['BOT_DESPAWNED']): void => {
        if (e.reason !== 'fled') return;
        const rec = this.pool.get(e.botId);
        if (rec) this.pool.scheduleRespawn(rec, this.opts.respawnDelayMs);
      };
      bus.on('ENTITY_DESTROYED', onDestroyed);
      bus.on('ENTITY_SHED', onShed);
      bus.on('BOT_DESPAWNED', onDeparted);
      this.subs.push({ bus, onDestroyed, onShed, onDeparted });
    }
    // Error boundary (campaign 1.1): a throw escaping tick() was an uncaught
    // exception on the single-process host. Log-and-continue instead.
    const timer = gameSetInterval(guarded('director-tick', () => this.tick()), this.opts.controlIntervalMs);
    this.timer = timer;
    // Populate the snapshot cache once so `/galaxy/snapshot` answers with live
    // counts before the first control tick fires.
    this.galaxyStats.recompute();
  }

  /** Stop the loop, abandon in-flight transits, unsubscribe. Idempotent. */
  /**
   * v4 T3 — a teleporter carried one of this director's bots to another
   * sector: despawn it here, spawn it there at (x, y) with its carry, and
   * record the new sector. Only an ACTIVE bot that isn't mid-hop moves.
   * Returns false when the bot isn't this director's (the caller tries the
   * next director).
   */
  teleportBot(botId: string, from: string, to: string, x: number, y: number): boolean {
    const rec = this.pool.get(botId);
    if (!rec || rec.state !== 'active' || rec.sectorKey !== from || rec.controller !== null) return false;
    const src = this.rooms.get(from);
    const dest = this.rooms.get(to);
    if (!src || !dest || !dest.hasFreeSlot()) return false;
    const carry = src.despawnLivingWorldBot(botId);
    if (!carry) return false;
    const ok = dest.spawnLivingWorldBot({ botId, kind: carry.kind, x, y, vx: carry.vx, vy: carry.vy, health: carry.health });
    rec.kind = carry.kind;
    if (!ok) {
      this.pool.scheduleRespawn(rec, this.opts.respawnDelayMs);
      return true;
    }
    this.pool.markActive(rec, to);
    serverLogEvent('bot_teleported', { botId, from, to });
    return true;
  }

  stop(): void {
    if (this.timer) {
      gameClearTimer(this.timer);
      this.timer = null;
    }
    for (const s of this.subs) {
      s.bus.off('ENTITY_DESTROYED', s.onDestroyed);
      s.bus.off('ENTITY_SHED', s.onShed);
      s.bus.off('BOT_DESPAWNED', s.onDeparted);
    }
    this.subs.length = 0;
    this.pool.disposeControllers();
    this.warp.disposePending();
    this.incoming.reset();
  }

  /** Read-only introspection for tests / the `/dev/population` route. */
  snapshot(): DirectorSnapshot {
    return this.pool.snapshot(this.sectorKeys, (k) => {
      const room = this.rooms.get(k);
      return room ? room.playerCount() : 0;
    });
  }

  /** Read-only squad-state counts (`forming/idle/warping/attacking/retreating`)
   *  for tests + telemetry — e.g. asserting a base-less player never triggers a
   *  wave (no `warping`/`attacking` squad). */
  squadSnapshot(): ReturnType<SquadPool['snapshot']> {
    return this.squadPool.snapshot();
  }

  /**
   * Phase 5 — overlay persisted squad continuity onto the freshly-seeded pool.
   * Runs inside `start()` AFTER seeding (squads + membership exist), BEFORE the
   * control loop starts. Hydrate → null ⇒ keep today's fresh seed; else restore
   * each known squad's sector/target/state + the wave bookkeeping. The existing
   * respawn + plan machinery then re-spawns bots at the restored sectors and
   * resumes / stands down.
   */
  private restoreFromPersistence(): void {
    const p = this.directorPersistence?.hydrate();
    if (p) applyDirectorState(this.stateHost, p);
  }

  /**
   * Persist the director's ABSTRACT continuity (per-squad sector/target/state +
   * wave bookkeeping). Called on graceful shutdown (index.ts) and throttled from
   * the control loop. No-op when no persistence sink is injected.
   */
  persistState(): void {
    const dp = this.directorPersistence;
    if (!dp) return;
    dp.persist(buildDirectorState(this.stateHost, this.nowMs()));
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
    // Robots (P1b) never wave: they roam and fight on sight via the stance table.
    if (this.opts.wavesEnabled) {
      for (const step of this.waveDirector.plan(now)) this.executeWaveStep(step);
    }

    // ── 2b. world activities, in order: roam idle/unassigned squads, then
    //        herd gathered ones (leader course + flock roles) — `SquadHerding` ──
    for (let i = 0; i < this.activities.length; i++) this.activities[i]!.tick(now);

    // ── 2c. clear "incoming" banners for squads that have arrived ────────
    this.incoming.reconcile();

    // ── 3. telemetry (population + squad/wave counts) ────────────────────
    const snap = this.snapshot();
    const squads = this.squadPool.snapshot();
    serverLogEvent('population_report', {
      allegiance: this.opts.allegiance,
      total: snap.total,
      active: snap.active,
      inTransit: snap.inTransit,
      respawning: snap.respawning,
      perSector: snap.perSector,
      squads: squads.byState,
    });

    // ── 3b. refresh the cached /galaxy/snapshot live counts (O(1) HTTP reads) ──
    this.galaxyStats.recompute();

    // ── 4. throttled crash-defence persist (off the 60 Hz live loop) ─────
    if (this.directorPersistence && now - this.lastPersistAtMs >= DIRECTOR_PERSIST_INTERVAL_MS) {
      this.lastPersistAtMs = now;
      this.persistState();
    }

    // ── 5. P3 — side-specific per-tick work (robot territory + nexus) ─────
    this.hooks.onTick?.(now);
  }

  /** P3 — attach cross-director hooks after construction (the robot
   *  territory is built from the director it hooks into). Merges. */
  setHooks(hooks: LivingWorldHooks): void {
    Object.assign(this.hooks, hooks);
  }

  /** P1b — this director's ACTIVE bots per sector (body in `GalaxyStatsView`). */
  activeBotCountsBySector(): Map<string, number> {
    return this.galaxyStats.activeBotCountsBySector();
  }

  /** Phase-3 — the cached live per-sector snapshot (structurally satisfies
   *  `GalaxyStatsProvider`; wired to `GET /galaxy/snapshot` in index.ts via
   *  `setGalaxyStatsProvider`). O(1): served from the control-tick cache. */
  galaxySnapshot(): SectorLiveState[] {
    return this.galaxyStats.galaxySnapshot();
  }

  /** Equinox Phase 7 — per-sector "my structures" counts (body in `GalaxyStatsView`). */
  playerStructurePresence(playerId: string): SectorStructurePresence[] {
    return this.galaxyStats.playerStructurePresence(playerId);
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
        // Drop the stale roam dwell so a stood-down squad starts drifting again
        // from wherever it retreated to, rather than waiting on an old schedule.
        this.squadRoamNextAtMs.delete(sq.squadId);
      }
    }
  }

  /** Roam dwell schedule (owned by `SquadHerding`; tests reach it by name). */
  private get squadRoamNextAtMs(): Map<string, number> {
    return this.herding.squadRoamNextAtMs;
  }

  /** The cluster (host + joined squads) bots in `sectorKey`, host's first. */
  clusterMembersOf(hostId: string, sectorKey: string): string[] {
    return this.herding.clusterMembersOf(hostId, sectorKey);
  }

  /** A squad's current goal sector (inspection / tests). */
  squadGoalOf(squadId: string): string | undefined {
    return this.squadPool.get(squadId)?.sectorKey;
  }

  /** Merged clusters (inspection / tests): joiner squadId → host squadId. */
  clusters(): ReadonlyMap<string, string> {
    return this.herding.clusters();
  }

  /** Execute one WaveDirector step (the side-effecting half — the planning is
   *  pure in WaveDirector). */
  private executeWaveStep(step: WaveStep): void {
    switch (step.kind) {
      case 'warp': {
        this.squadPool.setState(step.squad, 'warping');
        // Hop-by-hop traversal: advance every member that isn't yet at the goal
        // ONE galaxy-graph hop toward it. Re-issued every control tick while the
        // squad is warping, so members traverse independently (stragglers + the
        // members respawning in from the edge keep flowing toward the goal).
        //
        // The warp-in HUD warning is NO LONGER fired here (Phase-4 P0). The old
        // wave-only final-approach broadcast missed roamers / lone fighters /
        // players — the banner read "Nothing incoming" while ships arrived. The
        // warning now rides the SINGLE universal hop choke point
        // (`startSquadMemberTransit` → `IncomingRegistry`), so this branch's hops
        // are announced there by construction, alongside roam + traversal hops.
        this.advanceMembersTowardGoal(step.squad);
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
        // Stragglers keep hopping in while the on-site members fight: the
        // instant-hop model warped all 8 at once, but hop-by-hop must not strand
        // members who haven't reached the goal yet.
        this.advanceMembersTowardGoal(step.squad);
        break;
      }
      case 'retreat': {
        this.squadPool.setState(step.squad, 'retreating');
        const room = this.rooms.get(step.sectorKey);
        if (room) {
          room.setFactionUnderWave(step.factionId, false);
          room.purgeFactionHostility(step.factionId);
        }
        // Drop any lingering "incoming" banner for this squad's target sector — a
        // stood-down squad is no longer warping in.
        this.incoming.clearSquad(step.squad.squadId, step.sectorKey);
        this.squadPool.clearTarget(step.squad);
        // WS-E #8 — tag WHY the wave stood down so a cadence audit can tell a
        // healthy time-box phase-end from a de-escalation or a fully-razed base.
        serverLogEvent('wave_deescalated', {
          factionId: step.factionId,
          sectorKey: step.sectorKey,
          reason: step.reason,
        });
        auditEvent({
          event: 'wave_repelled',
          sector: step.sectorKey,
          owner: step.factionId,
          reason: step.reason,
        });
        break;
      }
    }
  }

  /** Hop-by-hop member advance (body in `SquadTraversal`; tests reach it by name). */
  private advanceMembersTowardGoal(squad: Parameters<SquadTraversal['advanceMembersTowardGoal']>[0]): number {
    return this.traversal.advanceMembersTowardGoal(squad);
  }

  /** Phase-4 P0 — player-transit back-channel (body in `IncomingBanners`). */
  registerIncomingPlayer(spec: Parameters<IncomingBanners['registerIncomingPlayer']>[0]): void {
    this.incoming.registerIncomingPlayer(spec);
  }

  /** Phase-4 P0 — clear an inbound player (arrival / cancel / abort). */
  clearIncomingPlayer(playerId: string, destSectorKey: string): void {
    this.incoming.clearIncomingPlayer(playerId, destSectorKey);
  }

  /** Replay what is still inbound to `destSectorKey` to a pilot who just arrived. */
  replayIncomingTo(destSectorKey: string, send: (msg: WarpWarningEvent) => void): void {
    this.incoming.replayIncomingTo(destSectorKey, send);
  }

  /** WS-E #15 — inline-hostility spawn spec (body in `HunterBotRespawner`). */
  private hostileSpecFor(
    botId: string,
    sectorKey: string,
  ): { hostileToFaction?: { playerId: string; structureIds: readonly string[] } } {
    return this.respawner.hostileSpecFor(botId, sectorKey);
  }

  /** WS-E #13/#19 — arrival pose for a hopping member (body in `HunterBotRespawner`). */
  private arrivalPoseFor(
    botId: string,
    to: string,
    carry: BotCarry,
  ): { x: number; y: number; vx: number; vy: number } | null {
    return this.respawner.arrivalPoseFor(botId, to, carry);
  }

  /** Step 1 of `tick` (body in `HunterBotRespawner`). */
  private respawnStep(now: number): void {
    this.respawner.respawnStep(now);
  }
}
