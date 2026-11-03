/**
 * Military patrols (plan soft-leaping-truffle v4, phase M2). Each garrison
 * flies a small squad of its owner's `patrol-fighter`s round its approaches.
 *
 *  - ROAM: each patrol ship flies the base's four corner waypoints (just
 *    outside its fence) in turn, starting at a different corner, so the squad
 *    spreads round the base.
 *  - ENGAGE: once a second, any pilot within `PATROL_ENGAGE_RANGE` of the
 *    base who is hostile to its owner (`relationOf`: a hostile act against
 *    the base, or standing below the owner's threshold) is marked hostile to
 *    every patrol ship of that base, through the room's `markBotHostile`
 *    channel (it broadcasts `bot_aggro`). Neutral pilots are left alone; the
 *    drone AI forgets a target that stays away.
 *  - RESPAWN: a lost patrol ship comes back after `PATROL_RESPAWN_MS`. Ships
 *    spawn at their waypoint OUTSIDE the fence: a fence stops every ship and
 *    gates open only for pilots, so a patrol born inside could never leave.
 *
 * The owner's faction rides the snapshot as `drones[].fac` (`factionOf`), so
 * clients tint patrols in their faction's colour. Not persisted: NPC bases
 * regenerate on boot, and so do their patrols. Room-owned, ticked from the
 * 1 Hz structure pulse; steady state allocates nothing.
 */
import type { FactionId } from '../../shared-types/factions.js';

export const PATROL_BOT_PREFIX = 'patrol-';
/** Pilots this close to a garrison's centre can draw its patrol. */
export const PATROL_ENGAGE_RANGE = 3500;
export const PATROL_RESPAWN_MS = 60_000;
/** How far outside the base's box the waypoints sit. */
export const PATROL_WAYPOINT_MARGIN = 500;
/** A patrol ship this close to its waypoint moves on to the next. */
export const PATROL_ARRIVE = 300;

export interface PatrolHooks {
  spawn(botId: string, x: number, y: number): boolean;
  /** Write a live patrol ship's pose into `out`; false when it is gone. */
  poseOf(botId: string, out: { x: number; y: number }): boolean;
  moveTo(botId: string, x: number, y: number): void;
  /** Mark a patrol ship hostile to a pilot (and tell clients). */
  markHostile(botId: string, playerId: string): void;
  /** Visit every active pilot in the room (id + pose). */
  forEachPilot(cb: (playerId: string, x: number, y: number) => void): void;
  /** The pilot is hostile to this owner (a hostile act, or low standing). */
  isHostileToOwner(playerId: string, owner: string): boolean;
}

interface Patrol {
  owner: string;
  faction: FactionId;
  cx: number;
  cy: number;
  /** Corner waypoints, game space: x0, y0, x1, y1, ... */
  points: number[];
  ships: Array<{ id: string; leg: number; deadAtMs: number }>;
}

export class PatrolSubsystem {
  private readonly patrols: Patrol[] = [];
  private readonly factionById = new Map<string, FactionId>();
  private readonly scratch = { x: 0, y: 0 };
  private currentPatrol: Patrol | null = null;

  constructor(private readonly h: PatrolHooks) {}

  /**
   * Add a garrison's patrol: `count` ships named `patrol-<tag>-<i>`, flying
   * the corners of `box` (the base's footprint). (cx, cy) is the base centre
   * (the engage range is measured from it).
   */
  addBase(tag: string, owner: string, faction: FactionId, box: { x0: number; x1: number; y0: number; y1: number }, cx: number, cy: number, count: number): void {
    const m = PATROL_WAYPOINT_MARGIN;
    const points = [box.x0 - m, box.y0 - m, box.x1 + m, box.y0 - m, box.x1 + m, box.y1 + m, box.x0 - m, box.y1 + m];
    const p: Patrol = { owner, faction, cx, cy, points, ships: [] };
    for (let i = 0; i < count; i++) {
      const id = `${PATROL_BOT_PREFIX}${tag}-${i}`;
      p.ships.push({ id, leg: i % 4, deadAtMs: -Infinity });
      this.factionById.set(id, faction);
    }
    this.patrols.push(p);
    for (const s of p.ships) this.spawnShip(p, s);
  }

  get count(): number {
    return this.patrols.length;
  }

  /** The faction a patrol ship flies for (undefined if it isn't one). */
  factionOf(botId: string): FactionId | undefined {
    return this.factionById.get(botId);
  }

  isPatrol(botId: string): boolean {
    return this.factionById.has(botId);
  }

  /** A patrol ship was destroyed: it comes back later. */
  onDestroyed(botId: string, nowMs: number): void {
    for (const p of this.patrols) {
      for (const s of p.ships) if (s.id === botId) s.deadAtMs = nowMs;
    }
  }

  /** ~1 Hz: respawn, roam, engage. */
  tick(nowMs: number): void {
    for (const p of this.patrols) {
      for (const s of p.ships) {
        if (!this.h.poseOf(s.id, this.scratch)) {
          if (s.deadAtMs === -Infinity) s.deadAtMs = nowMs;
          if (nowMs - s.deadAtMs >= PATROL_RESPAWN_MS) this.spawnShip(p, s);
          continue;
        }
        const wx = p.points[s.leg * 2]!;
        const wy = p.points[s.leg * 2 + 1]!;
        if (Math.hypot(this.scratch.x - wx, this.scratch.y - wy) <= PATROL_ARRIVE) s.leg = (s.leg + 1) % 4;
        this.h.moveTo(s.id, p.points[s.leg * 2]!, p.points[s.leg * 2 + 1]!);
      }
      this.currentPatrol = p;
      this.h.forEachPilot(this.engagePilot);
    }
    this.currentPatrol = null;
  }

  /** Bound once (no per-tick closure): mark a hostile pilot near the base. */
  private readonly engagePilot = (playerId: string, x: number, y: number): void => {
    const p = this.currentPatrol;
    if (p === null) return;
    if (Math.hypot(x - p.cx, y - p.cy) > PATROL_ENGAGE_RANGE) return;
    if (!this.h.isHostileToOwner(playerId, p.owner)) return;
    for (const s of p.ships) this.h.markHostile(s.id, playerId);
  };

  private spawnShip(p: Patrol, s: { id: string; leg: number; deadAtMs: number }): void {
    if (this.h.spawn(s.id, p.points[s.leg * 2]!, p.points[s.leg * 2 + 1]!)) {
      s.deadAtMs = -Infinity;
      this.h.moveTo(s.id, p.points[s.leg * 2]!, p.points[s.leg * 2 + 1]!);
    }
  }
}
