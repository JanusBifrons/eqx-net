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
import { guarded } from '../rooms/guardedLoop.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { BotTransitController } from './BotTransitController.js';
import {
  sectorEdgePose,
  squadEdgePose,
  nextHopToward,
  pickEntrySector,
  liveEntrySectors,
  pickRoamGoal,
  enemyBotCountsBySector,
  type Rng,
} from './population.js';
import { getSector, getNeighbours, isEntrySector } from '../../core/galaxy/galaxy.js';
import { clampToSectorBounds } from '../../shared-types/sectorBounds.js';
import type { BotCarry } from './botTypes.js';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type { SectorStructurePresence } from '../../shared-types/galaxyPresence.js';
import { LivingWorldRoom } from './LivingWorldRoom.js';
import { HunterBotPool, type BotRecord, type DirectorSnapshot } from './director/HunterBotPool.js';
import { HunterBotWarpController } from './director/HunterBotWarpController.js';
import { SquadPool, SQUAD_SIZE, LIVING_WORLD_SQUAD_COUNT, type SquadRecord } from './director/SquadPool.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { WaveSquadBehaviour } from './director/SquadBehaviour.js';
import { EscalatingWavePattern } from './director/WavePattern.js';
import { WaveDirector, type WaveStep } from './director/WaveDirector.js';
import { IncomingRegistry } from './IncomingRegistry.js';
import type { WarpDisposition } from '../../shared-types/messages.js';
import { DIRECTOR_STATE_VERSION, type DirectorPersistence } from './DirectorPersistence.js';

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
 *  Returns `undefined` (⇒ use the `DRONE_HOP_SPOOL_MS` default) when unset/invalid.
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

/** Director-level inter-sector hop-travel override (ms), read from
 *  `EQX_BOT_HOP_MS`. Returns `undefined` (⇒ use the `hopTravelMs` default) when
 *  unset/invalid. The drone-warp-in design's emergent travel time per galaxy
 *  hop; E2E timelines inject a tiny value so a multi-hop traversal completes in
 *  the test window instead of minutes. Read once at boot. */
export function resolveBotHopMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env['EQX_BOT_HOP_MS'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Per-hop vulnerable spool length. A WAVE's FINAL approach into its target sector
 * uses the long `waveApproachMs` (≈ the player's 30 s warp) so the attack
 * TELEGRAPHS with a real "incoming" countdown; every other hop — intermediate
 * wave hops AND roam hops (roamers are never a wave, so `isWave` is false) — uses
 * the fast `normalMs` so a multi-hop wave still converges. The 2026-06-19 playtest
 * "the attack came out of nowhere with 2.5 s warning" fix, decoupled + unit-locked.
 */
export function hopSpoolMs(
  isWave: boolean,
  isFinalApproach: boolean,
  normalMs: number,
  waveApproachMs: number,
): number {
  return isWave && isFinalApproach ? waveApproachMs : normalMs;
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
  /** Per-bot vulnerable spool length for a NORMAL hop (ms) — the fast
   *  cross-galaxy traversal cadence (`DRONE_HOP_SPOOL_MS`). */
  spoolMs: number;
  /** Vulnerable spool length for a WAVE's FINAL approach hop INTO its target
   *  sector (ms). Much longer than `spoolMs` (≈ the player's 30 s warp) so an
   *  incoming wave TELEGRAPHS: the squad visibly winds up in the adjacent sector
   *  and the target gets a real ~30 s "incoming wave" countdown, instead of the
   *  2.5 s-per-hop surprise that read as "no warning, spawned on top" (2026-06-19
   *  playtest). Only the final approach is slow — intermediate hops stay
   *  `spoolMs` fast so a multi-hop wave still converges (a uniform 30 s/hop was
   *  the pre-2026-06-18 bug that took waves minutes + never arrived). */
  waveApproachSpoolMs: number;
  /** Invulnerable inter-sector flight time per galaxy-graph hop (ms). The
   *  drone-warp-in design's emergent travel: a 2-hop dispatch costs ~2×, so
   *  farther bases take longer to reach. Override via `EQX_BOT_HOP_MS`. */
  hopTravelMs: number;
  /** Dwell (ms) an idle squad waits at its current roam goal before drifting to
   *  a new one — the slow-roam cadence that replaces the retired ambient patrol
   *  floor. Members stay NEUTRAL while roaming (hostility is wave-only). */
  roamIntervalMs: number;
  /** Minimum spacing (ms) between squad dispatches against the SAME ready
   *  faction — the director routes ≤1 squad per this window at a base. */
  dispatchIntervalMs: number;
  /** Phase-1 issue 4 — max ms a squad stays `attacking` before the wave falls
   *  back (a discrete assault PHASE), freeing the faction for a fresh squad on
   *  the next dispatch. Must be < `dispatchIntervalMs` for a lull between phases. */
  waveMaxAttackMs: number;
}

/** Display label for a squad's homogeneous hull in the warp-in warning
 *  ("8 × Legionnaires"). v1 squads are all `fighter`, shown as "Legionnaire"
 *  (a flavour codename, NOT a ship-kind — invariant #11; the wire `shipKind`
 *  stays `fighter`). A future mixed-kind WavePattern extends this map. */
export function squadDisplayLabel(kind: ShipKindId): string {
  return kind === 'fighter' ? 'Legionnaire' : kind;
}

/** Visible per-hop dwell (ms) for a DRONE squad's inter-sector hop — the drone
 *  analogue of a player's `SPOOL_DURATION_MS` (30 s) vulnerable warp spool, but
 *  DECOUPLED from it. The 30 s value is a PLAYER mechanic; drone hops wrongly
 *  inherited it, which broke the whole wave pipeline (Equinox Tweaks Phase 2,
 *  issue 3): a squad crosses the galaxy hop-by-hop, so at 30 s/hop a wave took
 *  MINUTES to reach a base — killed members respawn at the galaxy edge and
 *  restart the journey, so the squad never got a member to SETTLE in the target
 *  sector, never entered `attack`, and never marked hostility. The live server
 *  proved it: 17 waves dispatched, 0 resolved, 0 bots ever in the target,
 *  33/56 bots stuck inTransit. A short dwell keeps drones VISIBLE in each sector
 *  (the body stays in the source room during the spool) while letting waves
 *  actually converge + sustain pressure faster than the base turret clears them.
 *  FEEL knob — confirm the dwell pacing on-device; overridable via
 *  `EQX_BOT_SPOOL_MS`. Regression lock: `waveEngagesPresentOwner.test.ts`. */
export const DRONE_HOP_SPOOL_MS = 2500;

export const DEFAULT_LIVING_WORLD_OPTIONS: LivingWorldOptions = {
  botCount: LIVING_WORLD_BOT_COUNT,
  controlIntervalMs: 1500,
  respawnDelayMs: 12_000,
  arrivalCooldownMs: 5_000,
  playerStickyMs: 30_000,
  maxMigrationsPerTick: 4,
  shedRecoveryMs: 10_000,
  initialStaggerMs: 200,
  // Drone hops use the SHORT visible dwell (NOT the 30 s player warp spool) so
  // waves actually traverse + converge — see `DRONE_HOP_SPOOL_MS`.
  spoolMs: DRONE_HOP_SPOOL_MS,
  // A wave's FINAL approach into the target sector spools ~30 s (the player warp
  // duration) so the attack telegraphs with a real countdown + a visible windup
  // in the adjacent sector — the 2026-06-19 "the attack came out of nowhere with
  // no warning" fix. Intermediate hops stay `spoolMs` fast (convergence). FEEL
  // knob — confirm on-device.
  waveApproachSpoolMs: 30_000,
  // 0 = NO invisible inter-sector flight (Equinox: "drones should always be on
  // the actual game world, not in some ethereal warp"). The cross-sector hop is
  // now an atomic despawn-source/spawn-dest (deferred one macrotask) — a drone
  // is a LIVE, visible entity in a real sector at all times. Paced travel still
  // emerges from the VISIBLE per-hop spool dwell (`spoolMs`): a squad lingers in
  // each sector for the spool, then jumps to the next, so a farther base still
  // takes proportionally longer to reach — just visibly, never in limbo.
  // Tunable via EQX_BOT_HOP_MS (a non-zero value re-introduces the invisible
  // flight window; not recommended).
  hopTravelMs: 0,
  // ~6 min dwell between roam hops — roaming squads LINGER in a sector flying
  // A→B flock-cruise legs, then drift to a neighbour. 45 s was far too twitchy
  // (a squad barely arrived before hopping again, so it never settled anywhere
  // visible). Frequent hopping is for WAVES (a squad bearing down on a base),
  // not roamers. FEEL knob — confirm on-device.
  roamIntervalMs: 360_000,
  // One squad per ready faction per 5 min (then it traverses hop-by-hop).
  dispatchIntervalMs: 300_000,
  // A wave falls back after 3 min of attacking (a discrete phase) so the faction
  // is freed for a fresh squad next dispatch — phased assaults, not one grind.
  waveMaxAttackMs: 180_000,
};

/** Leader-course tunables (non-combat herding). Radius (game units) of the ring
 *  the LEADER's in-sector A→B course points are drawn from, centred on origin.
 *  Legs are LONG chords of this ring (up to ~2× the radius) so the herd CRUISES
 *  edge-to-edge ACROSS the sector — over the long roam dwell it traverses the
 *  central zone (encounterable) while ARRIVING at the edge, never popping in on
 *  top of a player at the centre (the 2026-06-19 playtest "spawned on top" fix —
 *  the central-arrival experiment was reverted; visibility comes from the long
 *  dwell + long legs, not from arriving on top). */
const FORMATION_DEST_RANGE = 2000;
/** Re-pick the leader's course once it's within this distance of it (so the herd
 *  continuously flies new A→B legs rather than parking). */
const FORMATION_DEST_ARRIVE = 250;
/** Angular spread (rad) around the "fly to the far side" bearing for course
 *  variety. The leader always aims roughly ACROSS the central zone (opposite its
 *  current bearing) so every leg is LONG — otherwise a random absolute point can
 *  land next to the leader and it just mills in place (the milling bug). */
const FORMATION_LEG_SPREAD = Math.PI / 2;
/** Non-combat herding: the squad is "gathered" (the leader may cruise its course)
 *  while every follower is within this distance of the leader. When the farthest
 *  follower is beyond it, the director HOLDS the leader at its own pose so the
 *  flock catches up — the user's "you can also just make the leader wait". Set
 *  comfortably above the boids settle band (separation floor → follow radius ≈
 *  150–220) so a gathered herd isn't whipsawed back into a hold by minor drift. */
const FLOCK_GATHER_RADIUS = 500;

/** Throttle (ms) for the director's crash-defence state persist inside the
 *  control loop — matches the 60 s sector-snapshot cadence. The PRIMARY persist
 *  is on graceful shutdown (index.ts); this bounds loss if the process is killed
 *  uncleanly. It's a CRITICAL enqueue from the 1.5 s control loop, NOT the 60 Hz
 *  `update()`, so it stays off the live loop. */
const DIRECTOR_PERSIST_INTERVAL_MS = 60_000;

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
  /** Phase-4 P0 — the single per-destination "incoming ships" feed behind the
   *  HUD banner. Fed off the universal hop choke point + the player-transit path. */
  private readonly incoming: IncomingRegistry;
  /** Phase 5 — optional director-state persistence ("restart from any state").
   *  Null in tests / when no sink is injected (⇒ today's fresh seed every boot). */
  private readonly directorPersistence: DirectorPersistence | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastShedAtMs = -Infinity;
  /** Wall-clock of the last in-loop crash-defence persist (throttle anchor). */
  private lastPersistAtMs = -Infinity;
  /** Phase-3 — cached live per-sector snapshot for `GET /galaxy/snapshot`,
   *  recomputed once per ~1.5 s control tick so HTTP requests are O(1). */
  private galaxyStatsCache: SectorLiveState[] = [];
  /** squadId → wall-clock the squad may next pick a new roam goal (the
   *  slow-roam dwell). Idle squads drift one roam hop per `roamIntervalMs`. */
  private readonly squadRoamNextAtMs = new Map<string, number>();
  /** Non-combat herding: squadId → the LEADER's current IN-SECTOR A→B course
   *  point (the leader cruises to it; followers flock to the leader). Re-picked
   *  once the leader arrives. */
  private readonly squadFormationDest = new Map<string, { x: number; y: number }>();
  /** Reused scratch for the active-members-in-sector list (alloc-free). */
  private readonly _formationMembers: string[] = [];
  /** Per-room (bus, handler) pairs for clean teardown. */
  private readonly subs: Array<{
    bus: Bus;
    onDestroyed: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void;
    onShed: (e: { type: 'ENTITY_SHED'; entityId: string }) => void;
  }> = [];

  constructor(
    rooms: Map<string, LivingWorldRoom>,
    options: Partial<LivingWorldOptions> & {
      rng?: Rng;
      nowMs?: () => number;
      /** Phase 5 — inject to make the director persist + restore its squad
       *  continuity across a restart. Omit ⇒ stateless (today's fresh seed). */
      directorPersistence?: DirectorPersistence;
    } = {},
  ) {
    this.rooms = rooms;
    this.sectorKeys = [...rooms.keys()];
    this.opts = { ...DEFAULT_LIVING_WORLD_OPTIONS, ...options };
    this.rng = options.rng ?? Math.random;
    this.nowMs = options.nowMs ?? Date.now;
    this.directorPersistence = options.directorPersistence ?? null;
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
    this.incoming = new IncomingRegistry(this.rooms);
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
    // Group the pool into homogeneous squads (v1: all 'fighter', shown as
    // "8 × Legionnaires" in the warp warning). Each member's hull is forced to
    // its squad's kind so the squad is visually homogeneous and the warning
    // label is honest (a future WavePattern can vary the kind per squad).
    const botIds = [...this.pool.values()].map((r) => r.botId);
    // Spread squad homes across the entry sectors so they don't all pile into
    // one edge; each squad gathers at its home entry until a wave routes it.
    this.squadPool.seed(
      botIds,
      (i) => entryKeys[i % entryKeys.length] ?? homeSector,
      () => 'fighter',
    );
    for (const rec of this.pool.values()) {
      const squad = this.squadPool.squadOf(rec.botId);
      if (squad) rec.kind = squad.kind;
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
      bus.on('ENTITY_DESTROYED', onDestroyed);
      bus.on('ENTITY_SHED', onShed);
      this.subs.push({ bus, onDestroyed, onShed });
    }
    // Error boundary (campaign 1.1): a throw escaping tick() was an uncaught
    // exception on the single-process host. Log-and-continue instead.
    const timer = setInterval(guarded('director-tick', () => this.tick()), this.opts.controlIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
    // Populate the snapshot cache once so `/galaxy/snapshot` answers with live
    // counts before the first control tick fires.
    this.recomputeGalaxyStats();
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
    if (!p) return;
    this.squadPool.restoreStates(p.squads);
    this.waveDirector.restore({ waveCount: p.waveCount, lastDispatchAtMs: p.lastDispatchAtMs });
    serverLogEvent('director_state_restored', { squads: p.squads.length });
  }

  /**
   * Persist the director's ABSTRACT continuity (per-squad sector/target/state +
   * wave bookkeeping). Called on graceful shutdown (index.ts) and throttled from
   * the control loop. No-op when no persistence sink is injected.
   */
  persistState(): void {
    const dp = this.directorPersistence;
    if (!dp) return;
    const wave = this.waveDirector.serialize();
    dp.persist({
      version: DIRECTOR_STATE_VERSION,
      savedAtMs: this.nowMs(),
      squads: this.squadPool.serialize(),
      waveCount: wave.waveCount,
      lastDispatchAtMs: wave.lastDispatchAtMs,
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
    for (const step of this.waveDirector.plan(now)) this.executeWaveStep(step);

    // ── 2b. roam idle/unassigned squads (the ambient floor replacement) ──
    this.roamStep(now);

    // ── 2b-ii. herd gathered idle squads: leader cruises a course, the rest
    //          FLOCK to it (continuous boids in the drone brain) ──
    this.flockStep();

    // ── 2c. clear "incoming" banners for squads that have arrived ────────
    this.reconcileIncoming();

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

    // ── 3b. refresh the cached /galaxy/snapshot live counts (O(1) HTTP reads) ──
    this.recomputeGalaxyStats();

    // ── 4. throttled crash-defence persist (off the 60 Hz live loop) ─────
    if (this.directorPersistence && now - this.lastPersistAtMs >= DIRECTOR_PERSIST_INTERVAL_MS) {
      this.lastPersistAtMs = now;
      this.persistState();
    }
  }

  /** Recompute the cached `/galaxy/snapshot` live state — one entry per galaxy
   *  room. The room reports its TOTAL present drones (enemies+neutrals) +
   *  players + structures; the director RE-SPLITS enemies vs neutrals by
   *  FACTION-hostility, not the room's present-player view.
   *
   *  Why: hostility is faction → faction (each player is their own faction). A
   *  drone is an "enemy" the moment its squad is DISPATCHED at a base
   *  (targetFactionId set) — independent of whether the targeted player is
   *  present (Equinox: waves attack regardless of presence). The room's
   *  `liveCounts` only knew "hostile to a PRESENT player", so an offline base
   *  under attack showed zero enemies on the map. The squad-derived count fixes
   *  that: a dispatched wave shows red in whatever sector its members occupy,
   *  from dispatch through traversal to arrival; roaming squads stay neutral.
   *  Runs on the ~1.5 s control tick (never the 60 Hz loop), so allocating here
   *  is fine. */
  private recomputeGalaxyStats(): void {
    const enemyBySector = enemyBotCountsBySector(this.squadPool.all(), (id) => this.pool.get(id));
    const out: SectorLiveState[] = [];
    for (const [key, room] of this.rooms) {
      const counts = room.liveCounts?.() ?? {
        players: room.playerCount(),
        enemies: 0,
        neutrals: 0,
        structures: 0,
      };
      // Total drones actually present in the sector (the room is ground truth
      // for "how many"); the director decides the enemy/neutral SPLIT by wave.
      const totalDrones = counts.enemies + counts.neutrals;
      const enemies = Math.min(enemyBySector.get(key) ?? 0, totalDrones);
      const neutrals = Math.max(0, totalDrones - enemies);
      const region = getSector(key)?.region ?? null;
      out.push({
        key,
        players: counts.players,
        enemies,
        neutrals,
        structures: counts.structures,
        // Cosmetic/static v1: ownership IS the sector's region faction; the shape
        // carries `null` for the FUTURE "unclaimed" case (shared-types/galaxySnapshot.ts).
        owner: region ? { factionId: region, contested: false } : null,
        // Equinox Phase 9 (item 5) — recent-combat tally (null when quiet); the
        // room owns the sliding window, the director just forwards it.
        recentCombat: room.recentCombat?.() ?? null,
      });
    }
    this.galaxyStatsCache = out;
  }

  /** Phase-3 — the cached live per-sector snapshot (structurally satisfies
   *  `GalaxyStatsProvider`; wired to `GET /galaxy/snapshot` in index.ts via
   *  `setGalaxyStatsProvider`). O(1): served from the control-tick cache. */
  galaxySnapshot(): SectorLiveState[] {
    return this.galaxyStatsCache;
  }

  /** Equinox Phase 7 — per-sector count of structures owned by `playerId` (the
   *  galaxy-map "my structures" overlay). Computed ON DEMAND from each live
   *  room's registry (per-player, so it can't share the global snapshot cache);
   *  off the 60 Hz tick — called at the ~4 s presence poll. Sectors where the
   *  player owns nothing are omitted, keeping the payload small. */
  playerStructurePresence(playerId: string): SectorStructurePresence[] {
    const out: SectorStructurePresence[] = [];
    for (const [key, room] of this.rooms) {
      const n = room.ownedStructureCount?.(playerId) ?? 0;
      if (n > 0) out.push({ key, structures: n });
    }
    return out;
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

  /**
   * Slow-roam idle, UNASSIGNED squads around the galaxy graph (the ambient
   * patrol floor replacement). A squad drifts one roam hop per `roamIntervalMs`
   * once it has gathered at its current goal: pick a random LIVE neighbour as
   * the new goal, then advance members toward it hop-by-hop. Roaming squads stay
   * NEUTRAL — hostility is marked ONLY in the wave `attack` branch, never here —
   * so a roaming pack that drifts through a base-less player's sector does not
   * hunt them. Roam hops are real despawn→spawn pairs (`bot_transit_commit`),
   * never from-nowhere ingress, so they may legally enter interior sectors.
   *
   * WS-E #22 — roaming squads AVOID active-combat sectors. The roam-goal pick is
   * given an `avoidCombat` predicate built from each room's `recentCombat()`
   * (a non-null summary ⇒ combat within the ~5-min sliding window), so a neutral
   * pack re-routes around a firefight; if every live neighbour is in combat the
   * squad HOLDS at its current sector. An avoidance that changed the outcome is
   * audit-logged (`roam_avoid_combat`).
   */
  private roamStep(now: number): void {
    const avoidCombat = (sectorKey: string): boolean => this.sectorInRecentCombat(sectorKey);
    for (const sq of this.squadPool.all()) {
      if (sq.state !== 'idle' || sq.targetFactionId !== null) continue;
      const sched = this.squadRoamNextAtMs.get(sq.squadId);
      if (sched === undefined) {
        // First sighting: dwell at the home edge before the first drift.
        this.squadRoamNextAtMs.set(sq.squadId, now + this.opts.roamIntervalMs);
      } else if (now >= sched && this.squadGatheredAt(sq, sq.sectorKey)) {
        const from = sq.sectorKey;
        // Did we skip ANY live neighbour for being in combat? Compute it BEFORE
        // the (single) RNG-consuming pick so we don't perturb the draw — the
        // audit wants the name of a representative skipped sector.
        const avoided = this.firstCombatNeighbour(from);
        const goal = pickRoamGoal(this.rng, from, this.sectorKeys, avoidCombat);
        sq.sectorKey = goal;
        this.squadRoamNextAtMs.set(sq.squadId, now + this.opts.roamIntervalMs);
        // Audit a combat-driven re-route: a neighbour was skipped for combat and
        // the squad picked elsewhere (or held at `from` because all were unsafe).
        if (avoided !== null && goal !== avoided) {
          auditEvent({
            event: 'roam_avoid_combat',
            sector: from,
            squadId: sq.squadId,
            from,
            avoided,
            to: goal,
          });
          serverLogEvent('roam_avoid_combat', { squadId: sq.squadId, from, avoided, to: goal });
        }
      }
      // Always drift toward the current goal (no-op once gathered there).
      this.advanceMembersTowardGoal(sq);
    }
  }

  /** WS-E #22 — true iff `sectorKey`'s room reports combat within its recent
   *  window (`recentCombat()` returns non-null). The room owns the ~5-min
   *  sliding `RecentCombatLog`; the director just queries it for roam routing.
   *  Off the 60 Hz loop (the ~1.5 s control tick). */
  private sectorInRecentCombat(sectorKey: string): boolean {
    return this.rooms.get(sectorKey)?.recentCombat?.() != null;
  }

  /** WS-E #22 — a representative LIVE neighbour of `from` that's in active combat
   *  (for the `roam_avoid_combat` audit's `avoided` field), or null when none.
   *  Order follows the galaxy graph adjacency so it's deterministic. Control-tick
   *  cadence — off the 60 Hz loop. */
  private firstCombatNeighbour(from: string): string | null {
    for (const n of getNeighbours(from)) {
      if (this.rooms.has(n.key) && this.sectorInRecentCombat(n.key)) return n.key;
    }
    return null;
  }

  /** True iff the squad has ≥1 active member, ALL its active members are in
   *  `sector`, and none is in flight — i.e. the squad has fully gathered there.
   *  Respawning members (warping in from the edge) are ignored: a squad with a
   *  reinforcement still inbound is "gathered" for roam-decision purposes and
   *  the reinforcement simply chases the next goal. */
  private squadGatheredAt(squad: SquadRecord, sector: string): boolean {
    let active = 0;
    for (const botId of squad.botIds) {
      const rec = this.pool.get(botId);
      if (!rec) continue;
      if (rec.state === 'in-transit') return false;
      if (rec.state === 'active') {
        if (rec.sectorKey !== sector) return false;
        active++;
      }
    }
    return active > 0;
  }

  /**
   * Non-combat herding ("AI bots which are 'roaming' just sit there… designate a
   * leader given a course, then use flocking/herding to guide the rest").
   * Replaces the old fixed-wedge-slot scheme (which assigned each follower a
   * STATIC world point every ~1.5 s and `arrive`d/STOPPED at it — a static blob,
   * not a formation). For every IDLE, unassigned squad gathered in one sector,
   * designate the first active member the LEADER, cruise it along a wandering
   * in-sector A→B course, and mark every OTHER member a FOLLOWER that FLOCKS to
   * the leader.
   *
   * THE STEERING IS PER-TICK IN THE DRONE BRAIN (60 Hz, `HostileDroneBehaviour.
   * tickFlock`): continuous cohesion/alignment/separation against the leader's +
   * neighbours' LIVE poses. This method only assigns ROLES at the control-loop
   * cadence (1.5 s is fine for ROLE assignment — only the steering must be 60 Hz,
   * which is exactly why the old slot-at-1.5 s scheme failed).
   *
   * Combat overrides this: a hostile (waved) drone is in COMBAT and never reads
   * the flock role, so a squad under attack pursues normally.
   */
  private flockStep(): void {
    // Env-gated herd diagnostics (`EQX_BOT_*`-style): off by default, inert in
    // production. Emits one `flock_debug` per idle squad per control tick (skip
    // reason or herd metrics: leaderR / maxGap / gathered / dest) → read via
    // GET /dev/events. The live-diagnosis + tuning lever for the herd.
    const dbg = process.env['EQX_FLOCK_DEBUG'] === '1';
    for (const sq of this.squadPool.all()) {
      if (sq.state !== 'idle' || sq.targetFactionId !== null) {
        if (dbg)
          serverLogEvent('flock_debug', {
            squadId: sq.squadId,
            sector: sq.sectorKey,
            skip: sq.state !== 'idle' ? `state=${sq.state}` : `targetFaction=${sq.targetFactionId}`,
          });
        continue;
      }
      const room = this.rooms.get(sq.sectorKey);
      if (!room) {
        if (dbg) serverLogEvent('flock_debug', { squadId: sq.squadId, sector: sq.sectorKey, skip: 'no-room' });
        continue;
      }

      // Active members present in this sector, in stable botIds order so the
      // leader designation is deterministic.
      const members = this._formationMembers;
      members.length = 0;
      let nTransit = 0;
      let nElsewhere = 0;
      for (const botId of sq.botIds) {
        const rec = this.pool.get(botId);
        if (!rec) continue;
        if (rec.state === 'active' && rec.sectorKey === sq.sectorKey) members.push(botId);
        else if (rec.state === 'in-transit') nTransit++;
        else if (rec.state === 'active') nElsewhere++;
      }
      if (members.length === 0) {
        if (dbg)
          serverLogEvent('flock_debug', {
            squadId: sq.squadId,
            sector: sq.sectorKey,
            skip: 'no-active-members',
            inTransit: nTransit,
            activeElsewhere: nElsewhere,
          });
        continue;
      }

      const leaderId = members[0]!;
      const leaderPose = room.getBotPose(leaderId);
      if (!leaderPose) {
        if (dbg) serverLogEvent('flock_debug', { squadId: sq.squadId, sector: sq.sectorKey, skip: 'no-leader-pose' });
        continue;
      }

      // Pick / refresh the leader's COURSE once it has (nearly) arrived (or has
      // none yet). Aim ACROSS the central zone — a point on the radius-RANGE ring
      // roughly OPPOSITE the leader's current bearing (± a spread for variety) —
      // so every leg is LONG and the leader genuinely CRUISES (the herd flies
      // with it) instead of milling near a randomly-close point.
      let dest = this.squadFormationDest.get(sq.squadId);
      if (
        dest === undefined ||
        Math.hypot(dest.x - leaderPose.x, dest.y - leaderPose.y) < FORMATION_DEST_ARRIVE
      ) {
        const awayAng =
          Math.atan2(leaderPose.y, leaderPose.x) + Math.PI + (this.rng() - 0.5) * FORMATION_LEG_SPREAD;
        dest = {
          x: Math.cos(awayAng) * FORMATION_DEST_RANGE,
          y: Math.sin(awayAng) * FORMATION_DEST_RANGE,
        };
        this.squadFormationDest.set(sq.squadId, dest);
      }

      // "Make the leader wait": measure how spread the squad is (the farthest
      // follower's gap to the leader). While the herd is gathered the leader
      // cruises its far course (throttled in the brain so followers tighten);
      // while it's spread the leader HOLDS at its own pose so the flock catches
      // up. Either way the leader role is THROTTLED via setBotFlockLeaderCourse —
      // followers move at full cruise and converge.
      let maxGap = 0;
      for (let i = 1; i < members.length; i++) {
        const fp = room.getBotPose(members[i]!);
        if (!fp) continue;
        const g = Math.hypot(fp.x - leaderPose.x, fp.y - leaderPose.y);
        if (g > maxGap) maxGap = g;
      }
      const gathered = maxGap <= FLOCK_GATHER_RADIUS;
      if (dbg)
        serverLogEvent('flock_debug', {
          squadId: sq.squadId,
          sector: sq.sectorKey,
          herded: true,
          members: members.length,
          inTransit: nTransit,
          activeElsewhere: nElsewhere,
          maxGap: Math.round(maxGap),
          gathered,
          leaderR: Math.round(Math.hypot(leaderPose.x, leaderPose.y)),
          leaderX: Math.round(leaderPose.x),
          leaderY: Math.round(leaderPose.y),
          destX: Math.round(dest.x),
          destY: Math.round(dest.y),
        });
      if (gathered) {
        room.setBotFlockLeaderCourse(leaderId, dest.x, dest.y);
      } else {
        room.setBotFlockLeaderCourse(leaderId, leaderPose.x, leaderPose.y);
      }

      // Every other member FLOCKS to the leader (continuous boids in the brain,
      // resolved against the leader's LIVE pose — not a stale slot). `members`
      // includes the leader; the follower brain skips self + the leader in its
      // separation loop. Passing the reused `members` array is safe —
      // `setFlockFollow` copies it synchronously.
      for (let i = 1; i < members.length; i++) {
        room.setBotFlockFollow(members[i]!, leaderId, members);
      }
    }
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
        this.incoming.clear(step.squad.squadId, step.sectorKey);
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

  /**
   * Warp every active member that isn't yet at the squad's goal (`sq.sectorKey`)
   * ONE galaxy-graph hop toward it (`nextHopToward`). Re-issued each control
   * tick while a squad is warping / attacking / roaming, so members traverse the
   * graph hop-by-hop and independently — a member that respawns in from an entry
   * sector or straggles behind keeps flowing toward the goal without any
   * squad-level "current location" bookkeeping (the multiset of member
   * `rec.sectorKey` IS the squad's position).
   *
   * `in-transit` members are skipped (the per-leg `BotTransitController` is
   * single-use; only `active` members not yet at their next hop are re-tasked).
   * Returns the number of members that began the FINAL leg (`nextHop === goal`)
   * this tick — the trigger for the one-shot warp-in warning.
   */
  private advanceMembersTowardGoal(squad: {
    botIds: readonly string[];
    sectorKey: string;
    targetFactionId?: string | null;
  }): number {
    const goal = squad.sectorKey;
    // A WAVE (tasked against a faction) telegraphs its FINAL approach into the
    // target with a long spool; everything else (intermediate wave hops, roam
    // hops) stays fast so traversal still converges. `targetFactionId` is unset
    // for roaming squads ⇒ they never get the slow approach.
    const isWave = squad.targetFactionId != null;
    let finalApproach = 0;
    for (const botId of squad.botIds) {
      const rec = this.pool.get(botId);
      if (!rec || rec.state !== 'active' || rec.sectorKey === goal) continue;
      let hop = nextHopToward(rec.sectorKey, goal);
      if (hop === null) {
        // No galaxy-graph route from here to the goal. In production every wave
        // target is a real graph sector, so this only happens for a goal that's
        // a LIVE room outside the graph (a synthetic test/engineering sector) —
        // hop directly to it. (Still a despawn→spawn pair, never a from-nowhere
        // ingress, so the entry-only-ingress invariant holds.) Truly unreachable
        // ⇒ leave the member.
        if (this.rooms.has(goal)) hop = goal;
        else continue;
      }
      const isFinalApproach = hop === goal;
      const spoolMs = hopSpoolMs(isWave, isFinalApproach, this.opts.spoolMs, this.opts.waveApproachSpoolMs);
      this.startSquadMemberTransit(rec, rec.sectorKey, hop, spoolMs);
      if (isFinalApproach) finalApproach++;
    }
    return finalApproach;
  }

  /** Spool one squad member from→to via the proven per-bot transit machinery
   *  (vulnerable spool, race-guarded outcome routing). Extracted from the old
   *  distribution-migration loop. */
  private startSquadMemberTransit(
    rec: BotRecord,
    from: string,
    to: string,
    spoolMs: number = this.opts.spoolMs,
  ): void {
    const fromRoom = this.rooms.get(from);
    if (!fromRoom) return;
    rec.state = 'in-transit';
    const ctrl = new BotTransitController(rec.botId, fromRoom.eventBus(), spoolMs);
    rec.controller = ctrl;
    fromRoom.eventBus().emit('BOT_TRANSIT_STARTED', {
      type: 'BOT_TRANSIT_STARTED',
      botId: rec.botId,
      from,
      to,
    });
    // Phase-4 P0 — the decision instant: this bot has ELECTED to warp into `to`
    // from another sector. Announce its squad as inbound to `to` (deduped on
    // squadId so 8 members = ONE banner entry; the registry follows a re-tasked
    // squad to a new goal). Covers wave, roam, AND traversal hops — the single
    // place the old wave-only warning missed.
    const squad = this.squadPool.squadOf(rec.botId);
    this.incoming.register({
      id: squad ? squad.squadId : rec.botId,
      destSectorKey: to,
      sourceSectorKey: from,
      label: squadDisplayLabel(squad ? squad.kind : rec.kind),
      count: squad ? squad.botIds.length : 1,
      disposition: this.dispositionForSquad(squad),
      // ≈ time-to-arrival for this leg: vulnerable spool + invulnerable flight.
      // Uses THIS hop's spool (a wave's final approach is ~30 s), so the HUD
      // countdown matches the real arrival instead of a fixed 2.5 s.
      etaMs: spoolMs + this.opts.hopTravelMs,
      kind: squad ? squad.kind : rec.kind,
    });
    serverLogEvent('bot_transit_start', { botId: rec.botId, from, to });
    ctrl.begin({
      now: this.nowMs,
      commit: () => this.warp.depart(rec, from, to),
      outcome: (res) => this.warp.onTransitOutcome(rec, from, to, res),
    });
  }

  /** Phase-4 P0 — a squad's coarse threat relation for the incoming banner. A
   *  wave (tasked against a faction) is an ENEMY (red); an idle/roaming pack is
   *  NEUTRAL (amber). Per-recipient PvP refinement is a future nicety — a tasked
   *  squad is bearing down on that faction's base, so coarse `enemy` is correct
   *  in practice. */
  private dispositionForSquad(squad: SquadRecord | undefined): WarpDisposition {
    return squad && squad.targetFactionId !== null ? 'enemy' : 'neutral';
  }

  /** Tail of `tick`: clear the "incoming" banner for any squad that has arrived
   *  (gathered at the entry's destination). Self-correcting against a missed
   *  edge — iterates the tiny registry, not the bot pool. Player entries are
   *  owned by the transit/arrival hooks and skipped here. */
  private reconcileIncoming(): void {
    for (const e of [...this.incoming.all()]) {
      if (e.player) continue;
      const squad = this.squadPool.get(e.id);
      // The squad is gone, or it has fully gathered at the destination, or no
      // member is still inbound to it ⇒ the warp-in is over.
      if (!squad || this.squadGatheredAt(squad, e.destSectorKey) || !this.anyMemberInboundTo(squad, e.destSectorKey)) {
        this.incoming.clear(e.id, e.destSectorKey);
      }
    }
  }

  /** True iff at least one of the squad's members is in-transit OR active-but-not-
   *  yet-arrived toward `dest` — i.e. the warp-in is still in progress. */
  private anyMemberInboundTo(squad: SquadRecord, dest: string): boolean {
    for (const botId of squad.botIds) {
      const rec = this.pool.get(botId);
      if (!rec) continue;
      if (rec.state === 'in-transit') return true;
      if (rec.state === 'active' && rec.sectorKey !== dest && squad.sectorKey === dest) return true;
    }
    return false;
  }

  /** Phase-4 P0 — player-transit back-channel: a player has begun spooling toward
   *  `destSectorKey`. Announce them as a FRIENDLY inbound to that sector's
   *  occupants. Called from `TransitOrchestrator` via the index.ts accessor. */
  registerIncomingPlayer(spec: {
    playerId: string;
    destSectorKey: string;
    sourceSectorKey: string;
    label: string;
    etaMs: number;
  }): void {
    this.incoming.register({
      id: spec.playerId,
      destSectorKey: spec.destSectorKey,
      sourceSectorKey: spec.sourceSectorKey,
      label: spec.label,
      count: 1,
      disposition: 'friendly',
      etaMs: spec.etaMs,
      player: true,
    });
  }

  /** Phase-4 P0 — clear an inbound player (arrival / cancel / abort). */
  clearIncomingPlayer(playerId: string, destSectorKey: string): void {
    this.incoming.clear(playerId, destSectorKey);
  }

  /**
   * WS-E #15 — build the optional `hostileToFaction` spawn spec for a bot landing
   * in `sectorKey`. A member is marked hostile INLINE at spawn ONLY when its
   * squad is on a wave (`targetFactionId` set) AND that wave targets THIS very
   * sector (the squad has reached its goal). Resolved against the destination
   * room (the only place that holds the faction's structure ids). Returns `{}`
   * (spread to nothing) for a roaming/neutral spawn or an intermediate hop — so a
   * member only flips hostile on landing AT the base, never mid-traverse.
   *
   * This closes the warp-arrive race: the old path spawned the member on a
   * macrotask AFTER the control tick's `markSquadHostileToFaction` ran, so the
   * arriving record didn't exist yet (`!rec` early-return) and the member stayed
   * neutral until the next ~1.5 s pulse.
   */
  private hostileSpecFor(
    botId: string,
    sectorKey: string,
  ): { hostileToFaction?: { playerId: string; structureIds: readonly string[] } } {
    const squad = this.squadPool.squadOf(botId);
    if (!squad || squad.targetFactionId === null) return {};
    // Only mark hostile when the member is landing in the squad's TARGET sector
    // (the base). An intermediate-hop arrival stays neutral until it reaches the
    // base, matching the wave's `attack`-only hostility pulse.
    if (squad.sectorKey !== sectorKey) return {};
    const room = this.rooms.get(sectorKey);
    if (!room || !room.factionHostility) return {};
    return { hostileToFaction: room.factionHostility(squad.targetFactionId) };
  }

  /**
   * WS-E #13/#19 — the ARRIVAL pose for a hopping member. A WAVE hop (squad has a
   * `targetFactionId`) carries the bot's pre-despawn SAB pose (CLAMPED to the
   * destination bounds — the same defense-in-depth `clampToSectorBounds` the
   * player `TransitOrchestrator.commitTransit` uses), so a squad's members arrive
   * SPREAD near where they each were in the source sector instead of all snapping
   * to one clustered edge anchor (the "all attacking drones appear in exactly the
   * same place" report). A ROAM hop (no target) returns null ⇒ the controller
   * falls back to the EDGE spawn, preserving the "roamers enter from the edge,
   * never pop in on top of a player at the centre" invariant (2026-06-19).
   */
  private arrivalPoseFor(
    botId: string,
    _to: string,
    carry: BotCarry,
  ): { x: number; y: number; vx: number; vy: number } | null {
    const squad = this.squadPool.squadOf(botId);
    if (!squad || squad.targetFactionId === null) return null; // roaming ⇒ edge spawn
    const { x, y } = clampToSectorBounds(carry.x, carry.y);
    return { x, y, vx: carry.vx, vy: carry.vy };
  }

  /** Step 1 of `tick`: warp-in respawning bots when their delay elapses
   *  AND shed recovery has cleared. */
  private respawnStep(now: number): void {
    const shedRecovered = now - this.lastShedAtMs > this.opts.shedRecoveryMs;
    for (const rec of this.pool.values()) {
      if (rec.state !== 'respawning' || rec.respawnAtMs > now || !shedRecovered) continue;
      // Ingress is ALWAYS at an entry (edge) sector — a (re)spawning bot "warps
      // in from outside known space" at the galaxy edge, NEVER in place in an
      // interior sector (the drone-warp-in invariant). If the squad's goal is
      // itself a live entry sector (an idle/forming squad gathered at its home
      // entry), the bot rejoins there directly — cohesive; otherwise (the goal
      // is an interior base / roam target) it enters at a random edge sector and
      // traverses back hop-by-hop via `advanceMembersTowardGoal`.
      const goal = this.squadPool.respawnSectorFor(rec.botId);
      const sector =
        goal !== null && this.rooms.has(goal) && isEntrySector(goal)
          ? goal
          : pickEntrySector(this.rng, this.sectorKeys);
      const room = this.rooms.get(sector);
      if (!room || !room.hasFreeSlot()) {
        rec.respawnAtMs = now; // keep retrying next tick
        continue;
      }
      // Spawn CLUSTERED with squadmates (the herd warps in together) when the
      // bot belongs to a squad; the per-squad+sector anchor means a whole squad
      // seeding/respawning into the same sector lands as one tight group.
      const squadKey = this.squadPool.squadOf(rec.botId)?.squadId;
      const pose = squadKey ? squadEdgePose(squadKey, sector, rec.botId) : sectorEdgePose(this.rng);
      const ok = room.spawnLivingWorldBot({
        botId: rec.botId,
        kind: rec.kind,
        x: pose.x,
        y: pose.y,
        vx: pose.vx,
        vy: pose.vy,
        // WS-E #15 — if this (re)spawning member belongs to a squad that's
        // ATTACKING the faction whose base lives in THIS sector, mark hostility
        // INLINE at spawn so a combat respawn rejoins hostile, not neutral.
        ...this.hostileSpecFor(rec.botId, sector),
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
