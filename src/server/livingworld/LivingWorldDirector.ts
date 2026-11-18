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
 *     (`director/GalaxyStatsView.ts`) and save/restore (`DirectorPersistence.ts`).
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
import type { SectorLiveState, SectorOwner } from '../../shared-types/galaxySnapshot.js';
import type { WorldEventView } from '../../shared-types/worldEvents.js';
import type { SectorStructurePresence } from '../../shared-types/galaxyPresence.js';
import { LivingWorldRoom } from './LivingWorldRoom.js';
import { HunterBotPool, type DirectorSnapshot } from './director/HunterBotPool.js';
import { HunterBotWarpController } from './director/HunterBotWarpController.js';
import {
  SquadPool,
  SQUAD_SIZE,
  LIVING_WORLD_SQUAD_COUNT,
  DEFAULT_SQUAD_LAYOUT,
  type SquadLayout,
} from './director/SquadPool.js';
import { DRONE_BOT_ID_PREFIX } from './directorBotIds.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
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
  type PersistedSectorControl,
} from './DirectorPersistence.js';
import { gameNow, gameSetInterval, gameClearTimer, type GameTimer } from '../time/gameTime.js';

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

export { hopSpoolMs, decideRallyRelease } from './director/SquadTraversal.js';

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
  /** Campaign 4.2 — max ms a WAVE squad's staged members wait at the rally ring
   *  (the sector adjacent to the target) for traversing squadmates before
   *  breaching anyway. See `decideRallyRelease`. Feel knob — tune on-device. */
  rallyMaxMs: number;
  /** Living World P1b — the side this director runs. `drones` (the default)
   *  is the wave director; `robots` roams the galaxy and fights ON SIGHT via
   *  the shared stance table (no waves, so `wavesEnabled` is false). */
  allegiance: 'drones' | 'robots';
  /** Bot id prefix — must be one of `directorBotIds.ts`'s prefixes. */
  botIdPrefix: string;
  /** Squad count / size / id prefix / per-slot hulls. */
  squadLayout: SquadLayout;
  /** Squad lead hull (homogeneous squads use it for every member). */
  leadKind: ShipKindId;
  /** false ⇒ never dispatch waves at bases (robots). Roam + flock still run. */
  wavesEnabled: boolean;
  /** Squads roaming the same sector merge into one bigger cluster (robots):
   *  a joined squad follows its host's roam goal and flocks on its leader. */
  mergeClusters: boolean;
}

/** Optional cross-director hooks (not tuning knobs, so not in the options
 *  record). */
export interface LivingWorldHooks {
  /** Extra per-sector ENEMY counts folded into `/galaxy/snapshot` — the drone
   *  director (the snapshot provider) counts the robot director's active bots
   *  as enemies, since robots are hostile to every player on sight. */
  extraEnemyCounts?: () => ReadonlyMap<string, number>;
  /** P3 — where (re)spawning bots appear instead of the galaxy edge (the robot
   *  nexus while it lives), or null ⇒ the normal edge ingress. */
  respawnAnchor?: () => { sectorKey: string; x: number; y: number } | null;
  /** P3 — called at the tail of every control tick (robot territory). */
  onTick?: (nowMs: number) => void;
  /** Live owner from the control meter (`RobotTerritory`); null = neutral, undefined ⇒ static controller. */
  sectorOwner?: (sectorKey: string) => SectorOwner | null | undefined;
  /** Step 1c — control entries saved WITH this director's state row, on every persist. */
  saveSectorControl?: () => PersistedSectorControl[];
  /** Step 1c — hand restored control entries back (`RobotTerritory.restoreControl`).
   *  Called from `start()` when the hydrated row carries them, so the hook must
   *  be set at construction (`options.hooks`), not via a later `setHooks`. */
  restoreSectorControl?: (entries: readonly PersistedSectorControl[]) => void;
  /** P4a — the name of a named elite roaming a sector (galaxy snapshot), or null. */
  sectorElite?: (sectorKey: string) => string | null;
  /** W2a — a flagship fleet in a sector (galaxy snapshot), or null. */
  sectorCapital?: (sectorKey: string) => { name: string; kind: string } | null;
  /** P4b — the world event running in a sector (galaxy snapshot), or null. */
  sectorEvent?: (sectorKey: string) => WorldEventView | null;
}

export { squadDisplayLabel } from './director/IncomingBanners.js';

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
  // Campaign 4.2 — staged wave members wait up to this long at the rally ring
  // for traversing squadmates before breaching anyway. Long enough for a
  // several-hop traversal (2.5 s dwell per hop) yet well under the 3 min attack
  // time-box, so a straggler cycle can't consume the whole assault phase. FEEL
  // knob — confirm on-device.
  rallyMaxMs: 90_000,
  allegiance: 'drones',
  botIdPrefix: DRONE_BOT_ID_PREFIX,
  squadLayout: DEFAULT_SQUAD_LAYOUT,
  leadKind: 'fighter',
  wavesEnabled: true,
  mergeClusters: false,
};

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
