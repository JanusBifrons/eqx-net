/**
 * Resting wrecks, scrap and plain asteroids as the fine nav layer's static
 * obstacles (navigation fine rebuild slice C2; owner, 2026-11-18: only static
 * or sleeping things not expected to move go to the planner, moving ones are
 * left to steering). Fed by discrete events only: the room bus's
 * `ENTITY_SLEPT`, a sweep of the bodies already asleep when navigation starts,
 * and `SwarmEvictor` (the one removal site) for eviction. An obstacle stays
 * where its body last came to rest: a wake does not remove it (a nudged piece
 * re-sleeps close by, and a woken body is steered round like anything else);
 * the next rest moves it, and only a rest farther than a quantum from the last
 * one sent is sent again, so wake/sleep flapping costs nothing.
 */
import type { Bus } from '../../core/events/Bus.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { rockParts } from '../rooms/SectorObstacles.js';
import { isLootPod } from '../../shared-types/swarmWireFormat.js';
import { FINE_NAV_CELL } from '../../core/nav/fineField.js';
import { FLAG_SLEEPING, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';

/** Bodies smaller than half a fine cell are left to steering. */
export const RESTING_MIN_RADIUS = FINE_NAV_CELL / 2;
/** A rest within this of the last one sent (u, rad) is not sent again. */
export const RESTING_POSE_QUANTUM = 8;
export const RESTING_ANGLE_QUANTUM = 0.05;

/** What the room hands in. */
export interface RestingSources {
  swarm: { get(id: string): SwarmEntityRecord | null; all(): Iterable<SwarmEntityRecord> };
  sabF32(): Float32Array;
  sabU32(): Uint32Array;
  bus: Bus;
}

/** Does this swarm body, at rest, go to the planner? Wreck pieces, scrap
 *  (never a loot pod: tractored and picked up) and plain asteroids (field
 *  rocks come through the cut field; structures through the registry;
 *  drones always move). */
export function restsAsObstacle(rec: SwarmEntityRecord): boolean {
  if (rec.radius < RESTING_MIN_RADIUS) return false;
  if (rec.kind === 4) return true;
  if (rec.kind === 3) return !isLootPod(rec);
  if (rec.kind === 0) return rec.fieldRock !== true;
  return false;
}

interface Sent { navId: number; x: number; y: number; angle: number }

export class RestingObstacles {
  private readonly sent = new Map<string, Sent>();
  private readonly onSlept = (e: { entityId: string }): void => this.slept(e.entityId);
  /** Obstacles sent so far (tests, diagnostics). */
  sends = 0;

  constructor(
    private readonly src: RestingSources,
    private readonly send: (navId: number, o: GridObstacle | null) => void,
    private readonly newId: () => number,
  ) {}

  /** Starts listening, and sends every body already asleep. */
  attach(): void {
    this.src.bus.on('ENTITY_SLEPT', this.onSlept);
    const u32 = this.src.sabU32();
    for (const rec of this.src.swarm.all()) {
      if ((u32[slotBase(rec.slot) + SLOT_FLAGS_OFF]! & FLAG_SLEEPING) !== 0) this.slept(rec.id);
    }
  }

  detach(): void {
    this.src.bus.off('ENTITY_SLEPT', this.onSlept);
    this.sent.clear();
  }

  /** Body `id` came to rest (a player hull or a moving kind is ignored). */
  slept(id: string): void {
    const rec = this.src.swarm.get(id);
    if (!rec || !restsAsObstacle(rec)) return;
    const f = this.src.sabF32(), b = slotBase(rec.slot);
    const x = f[b + SLOT_X_OFF]!, y = f[b + SLOT_Y_OFF]!, angle = f[b + SLOT_ANGLE_OFF]!;
    let s = this.sent.get(id);
    if (s) {
      const da = Math.abs(Math.atan2(Math.sin(angle - s.angle), Math.cos(angle - s.angle)));
      if (Math.abs(x - s.x) < RESTING_POSE_QUANTUM && Math.abs(y - s.y) < RESTING_POSE_QUANTUM && da < RESTING_ANGLE_QUANTUM) return;
    } else {
      this.sent.set(id, s = { navId: this.newId(), x, y, angle });
    }
    s.x = x; s.y = y; s.angle = angle;
    const parts = rockParts(rec);
    let radius = rec.radius;
    if (parts) for (const part of parts) for (const p of part) radius = Math.max(radius, Math.hypot(p.x, p.y));
    this.sends++;
    this.send(s.navId, { x, y, radius, angle, parts });
  }

  /** Body `id` left the world (`SwarmEvictor`). */
  gone(id: string): void {
    const s = this.sent.get(id);
    if (!s) return;
    this.sent.delete(id);
    this.send(s.navId, null);
  }
}
