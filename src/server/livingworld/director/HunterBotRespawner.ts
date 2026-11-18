/**
 * HunterBotRespawner — warps respawning bots back in (entry-edge ingress, or
 * the robot nexus anchor) and resolves the arrival hostility / pose for hopping
 * members. Moved verbatim out of `LivingWorldDirector.ts`; runs on the
 * director's control tick (step 1), never the 60 Hz loop.
 */
import { clampToSectorBounds } from '../../../shared-types/sectorBounds.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { isEntrySector } from '../../../core/galaxy/galaxy.js';
import {
  sectorEdgePose,
  squadEdgePose,
  SQUAD_RESPAWN_EPOCH_MS,
  pickEntrySector,
  type Rng,
} from '../population.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { BotCarry } from '../botTypes.js';
import type { HunterBotPool } from './HunterBotPool.js';
import type { SquadPool } from './SquadPool.js';
import type { DirectorActivity } from './DirectorActivity.js';

/** Deterministic per-bot scatter around a respawn anchor (no pile-up on one point). */
function anchorJitter(botId: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < botId.length; i++) h = Math.imul(h ^ botId.charCodeAt(i), 16777619) >>> 0;
  const a = (h % 360) * (Math.PI / 180);
  const r = 140 + (h % 120);
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

export interface HunterBotRespawnerDeps {
  rooms: Map<string, LivingWorldRoom>;
  sectorKeys: string[];
  pool: HunterBotPool;
  squadPool: SquadPool;
  rng: Rng;
  opts: { shedRecoveryMs: number };
  /** The director's hooks object (mutated in place by `setHooks`, so read live). */
  hooks: { respawnAnchor?: () => { sectorKey: string; x: number; y: number } | null };
  /** Last load-shed instant (the director reassigns it; read live). */
  lastShedAtMs: () => number;
}

export class HunterBotRespawner implements DirectorActivity {
  private readonly rooms: Map<string, LivingWorldRoom>;
  private readonly sectorKeys: string[];
  private readonly pool: HunterBotPool;
  private readonly squadPool: SquadPool;
  private readonly rng: Rng;
  private readonly opts: HunterBotRespawnerDeps['opts'];
  private readonly hooks: HunterBotRespawnerDeps['hooks'];
  private readonly shedAt: () => number;

  constructor(deps: HunterBotRespawnerDeps) {
    this.rooms = deps.rooms;
    this.sectorKeys = deps.sectorKeys;
    this.pool = deps.pool;
    this.squadPool = deps.squadPool;
    this.rng = deps.rng;
    this.opts = deps.opts;
    this.hooks = deps.hooks;
    this.shedAt = deps.lastShedAtMs;
  }

  private get lastShedAtMs(): number {
    return this.shedAt();
  }

  step(now: number): void {
    this.respawnStep(now);
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
  hostileSpecFor(
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
  arrivalPoseFor(
    botId: string,
    to: string,
    carry: BotCarry,
  ): { x: number; y: number; vx: number; vy: number } | null {
    const squad = this.squadPool.squadOf(botId);
    if (!squad || squad.targetFactionId === null) return null; // roaming ⇒ edge spawn
    // TestMode rooms may name the landing point (the wave E2E's base is at the
    // origin; a carry pose up to ~7000 u away made the attack land in its
    // window by luck). Members are spread on a small ring, at rest.
    const fixed = this.rooms.get(to)?.testWaveArrival?.() ?? null;
    if (fixed) {
      const i = Math.max(0, squad.botIds.indexOf(botId));
      const a = (i / Math.max(1, squad.botIds.length)) * Math.PI * 2;
      return { x: fixed.x + Math.cos(a) * 60, y: fixed.y + Math.sin(a) * 60, vx: 0, vy: 0 };
    }
    const { x, y } = clampToSectorBounds(carry.x, carry.y);
    return { x, y, vx: carry.vx, vy: carry.vy };
  }

  /** Step 1 of `tick`: warp-in respawning bots when their delay elapses
   *  AND shed recovery has cleared. */
  respawnStep(now: number): void {
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
      // P3 — the robots-only ingress exception: while a respawn ANCHOR exists
      // (a living robot nexus), reinforcements spawn AT it instead of entering
      // from the galaxy edge.
      const anchor = this.hooks.respawnAnchor?.() ?? null;
      if (anchor !== null && this.rooms.has(anchor.sectorKey)) {
        const aRoom = this.rooms.get(anchor.sectorKey)!;
        if (!aRoom.hasFreeSlot()) { rec.respawnAtMs = now; continue; }
        const j = anchorJitter(rec.botId);
        const ok = aRoom.spawnLivingWorldBot({
          botId: rec.botId, kind: rec.kind, x: anchor.x + j.x, y: anchor.y + j.y,
        });
        if (ok) {
          rec.state = 'active';
          rec.sectorKey = anchor.sectorKey;
          rec.arrivedAtMs = now;
          serverLogEvent('bot_spawn', { botId: rec.botId, sectorKey: anchor.sectorKey, kind: rec.kind, anchor: true });
        } else {
          rec.respawnAtMs = now;
        }
        continue;
      }
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
      // Campaign 4.1: the anchor bearing rotates per RESPAWN EPOCH (time
      // bucket) — same-window respawns still cluster, but the same bot never
      // rematerialises at one fixed, farmable point forever (the "all
      // attackers appear at the exact same spot NE of 0,0" report).
      const squadKey = this.squadPool.squadOf(rec.botId)?.squadId;
      const epoch = Math.floor(now / SQUAD_RESPAWN_EPOCH_MS);
      const pose = squadKey
        ? squadEdgePose(squadKey, sector, rec.botId, epoch)
        : sectorEdgePose(this.rng, sector);
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
