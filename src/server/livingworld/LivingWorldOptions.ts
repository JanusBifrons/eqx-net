/**
 * LivingWorldOptions — the director's tuning record, defaults, cross-director
 * hooks and boot-time env readers. Moved verbatim out of `LivingWorldDirector.ts`
 * (which re-exports every name, so existing imports keep working).
 */
import type { SectorOwner } from '../../shared-types/galaxySnapshot.js';
import type { WorldEventView } from '../../shared-types/worldEvents.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import {
  SQUAD_SIZE,
  LIVING_WORLD_SQUAD_COUNT,
  DEFAULT_SQUAD_LAYOUT,
  type SquadLayout,
} from './director/SquadPool.js';
import { DRONE_BOT_ID_PREFIX } from './directorBotIds.js';
import type { PersistedSectorControl } from './DirectorPersistence.js';

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
