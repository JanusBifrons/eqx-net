/**
 * SquadHerding — the director's ambient (non-wave) squad movement: slow roam
 * between sectors (avoiding live combat), merged clusters (`mergeClusters`),
 * and in-sector herding (leader course + flock roles). Moved verbatim out of
 * `LivingWorldDirector.ts`; it runs as one `DirectorActivity` on the
 * director's control tick (never the 60 Hz loop).
 */
import { sectorSpace, SOLAR_SECTORS } from '../../../shared-types/sectorBounds.js';
import { nearestSite, sectorSites } from '../../../core/galaxy/sectorSites.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { getNeighbours } from '../../../core/galaxy/galaxy.js';
import { pickRoamGoal, type Rng } from '../population.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { HunterBotPool } from './HunterBotPool.js';
import type { SquadPool, SquadRecord } from './SquadPool.js';
import { planClusterJoins, type ClusterCandidate } from './clusterJoins.js';
import type { DirectorActivity } from './DirectorActivity.js';

/** Leader-course tunables (non-combat herding). Radius (game units) of the ring
 *  the LEADER's in-sector A→B course points are drawn from, centred on origin.
 *  Legs are LONG chords of this ring (up to ~2× the radius) so the herd CRUISES
 *  edge-to-edge ACROSS the sector — over the long roam dwell it traverses the
 *  central zone (encounterable) while ARRIVING at the edge, never popping in on
 *  top of a player at the centre (the 2026-06-19 playtest "spawned on top" fix —
 *  the central-arrival experiment was reverted; visibility comes from the long
 *  dwell + long legs, not from arriving on top). */
export const FORMATION_DEST_RANGE = sectorSpace(2000);

/** Centre a roaming squad's flock course circles: the pocket nearest (x, y)
 *  in a solar-system sector, else the sector origin (today). */
export function flockCentre(sectorKey: string, x: number, y: number): { x: number; y: number } {
  if (!SOLAR_SECTORS) return { x: 0, y: 0 };
  const site = nearestSite(sectorSites(sectorKey), x, y);
  return site ? { x: site.x, y: site.y } : { x: 0, y: 0 };
}
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

export interface SquadHerdingDeps {
  rooms: Map<string, LivingWorldRoom>;
  sectorKeys: string[];
  pool: HunterBotPool;
  squadPool: SquadPool;
  rng: Rng;
  opts: { roamIntervalMs: number; mergeClusters?: boolean };
  /** The director's hop-by-hop member advance (shared with the wave steps). */
  advanceMembersTowardGoal: (squad: SquadRecord) => void;
}

export class SquadHerding implements DirectorActivity {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly sectorKeys: string[];
  private readonly pool: HunterBotPool;
  private readonly squadPool: SquadPool;
  private readonly rng: Rng;
  private readonly opts: SquadHerdingDeps['opts'];
  private readonly advance: (squad: SquadRecord) => void;
  /** squadId → wall-clock the squad may next pick a new roam goal (the
   *  slow-roam dwell). Idle squads drift one roam hop per `roamIntervalMs`. */
  readonly squadRoamNextAtMs = new Map<string, number>();
  /** Merged clusters (`mergeClusters`): joiner squadId → host squadId. */
  private clusterJoins: Map<string, string> = new Map();
  /** Non-combat herding: squadId → the LEADER's current IN-SECTOR A→B course
   *  point (the leader cruises to it; followers flock to the leader). Re-picked
   *  once the leader arrives. */
  private readonly squadFormationDest = new Map<string, { x: number; y: number }>();
  /** Reused scratch for the active-members-in-sector list (alloc-free). */
  private readonly _formationMembers: string[] = [];

  constructor(deps: SquadHerdingDeps) {
    this.rooms = deps.rooms;
    this.sectorKeys = deps.sectorKeys;
    this.pool = deps.pool;
    this.squadPool = deps.squadPool;
    this.rng = deps.rng;
    this.opts = deps.opts;
    this.advance = deps.advanceMembersTowardGoal;
  }

  /** Control tick: roam idle squads (2b), then herd gathered ones (2b-ii). */
  step(now: number): void {
    this.roamStep(now);
    this.flockStep();
  }

  private advanceMembersTowardGoal(squad: SquadRecord): void {
    this.advance(squad);
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
  roamStep(now: number): void {
    const avoidCombat = (sectorKey: string): boolean => this.sectorInRecentCombat(sectorKey);
    if (this.opts.mergeClusters) this.planClusters();
    for (const sq of this.squadPool.all()) {
      if (sq.state !== 'idle' || sq.targetFactionId !== null) continue;
      // A squad merged into a cluster takes its host's goal (set when the host
      // picks one, below) instead of choosing its own.
      if (this.clusterJoins.has(sq.squadId)) {
        this.advanceMembersTowardGoal(sq);
        continue;
      }
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
        // Its merged squads travel with it.
        for (const [joinerId, hostId] of this.clusterJoins) {
          if (hostId !== sq.squadId) continue;
          const joiner = this.squadPool.get(joinerId);
          if (joiner === undefined) continue;
          joiner.sectorKey = goal;
          this.squadRoamNextAtMs.set(joinerId, now + this.opts.roamIntervalMs);
        }
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
  squadGatheredAt(squad: SquadRecord, sector: string): boolean {
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
  /** Re-plan merged clusters (`mergeClusters`): squads idle in the same
   *  sector join the first one there (`planClusterJoins`). Control cadence. */
  planClusters(): void {
    const cands: ClusterCandidate[] = [];
    for (const sq of this.squadPool.all()) {
      let live = 0;
      for (const botId of sq.botIds) {
        const rec = this.pool.get(botId);
        if (rec && (rec.state === 'active' || rec.state === 'in-transit')) live++;
      }
      cands.push({
        squadId: sq.squadId,
        sectorKey: sq.sectorKey,
        eligible: sq.state === 'idle' && sq.targetFactionId === null,
        gathered: this.squadGatheredAt(sq, sq.sectorKey),
        size: live,
      });
    }
    const next = planClusterJoins(cands, this.clusterJoins);
    for (const [j, h] of next) {
      if (this.clusterJoins.get(j) !== h) serverLogEvent('robot_cluster_merged', { squadId: j, hostId: h, sector: this.squadPool.get(h)?.sectorKey });
    }
    this.clusterJoins = next;
  }

  /** The cluster (host + joined squads) bots in `sectorKey`, host's first —
   *  the first is the cluster's leader. Control cadence (allocates). */
  clusterMembersOf(hostId: string, sectorKey: string): string[] {
    const out: string[] = [];
    const add = (sq: SquadRecord | undefined): void => {
      for (const botId of sq?.botIds ?? []) {
        const rec = this.pool.get(botId);
        if (rec && rec.state === 'active' && rec.sectorKey === sectorKey) out.push(botId);
      }
    };
    add(this.squadPool.get(hostId));
    for (const [j, h] of this.clusterJoins) if (h === hostId) add(this.squadPool.get(j));
    return out;
  }

  /** A squad's current goal sector (inspection / tests). */
  squadGoalOf(squadId: string): string | undefined {
    return this.squadPool.get(squadId)?.sectorKey;
  }

  /** Merged clusters (inspection / tests): joiner squadId → host squadId. */
  clusters(): ReadonlyMap<string, string> {
    return this.clusterJoins;
  }

  flockStep(): void {
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

      // A merged cluster flocks as ONE pack on the HOST's leader: a joined
      // squad's bots follow it (with the whole cluster for separation).
      const hostId = this.clusterJoins.get(sq.squadId);
      if (hostId !== undefined) {
        const pack = this.clusterMembersOf(hostId, sq.sectorKey);
        const hostLeader = pack[0];
        const hostSq = this.squadPool.get(hostId);
        if (hostLeader !== undefined && hostSq !== undefined && hostSq.botIds.includes(hostLeader)) {
          for (const botId of pack) if (sq.botIds.includes(botId)) room.setBotFlockFollow(botId, hostLeader, pack);
          continue;
        }
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
        // The course circles the squad's POCKET (solar-system sectors, Phase 4:
        // the one nearest the leader; off = the sector origin, as today), so a
        // squad that arrived at a gate pocket flocks there instead of setting
        // off on a 170 km drift toward home.
        const c = flockCentre(sq.sectorKey, leaderPose.x, leaderPose.y);
        const awayAng =
          Math.atan2(leaderPose.y - c.y, leaderPose.x - c.x) + Math.PI + (this.rng() - 0.5) * FORMATION_LEG_SPREAD;
        dest = {
          x: c.x + Math.cos(awayAng) * FORMATION_DEST_RANGE,
          y: c.y + Math.sin(awayAng) * FORMATION_DEST_RANGE,
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
}
