/**
 * Authoritative registry for swarm entities. Maps a stable string id (used by
 * AI / bus events / snapshot ring) to a dense `u16 entityId` (used on the
 * wire) and to a SAB slot (used for physics state). Holds the last-broadcast
 * pose per entity so the encoder can produce delta packets without scanning
 * Rapier on its own.
 *
 * Entity IDs are dense 0..65535 to keep the binary packet stride minimal.
 * Slots are 0..MAX_ENTITIES-1, allocated by the SectorRoom slot pool.
 */

import type { Vec2 } from '../../core/swarm/asteroidShape.js';

export type SwarmKind =
  | 0 /* asteroid */
  | 1 /* drone */
  | 2 /* structure (GEP P4) */
  | 3 /* scrap (scrap-on-death Phase 2a) */;

export interface SwarmEntityRecord {
  id: string;
  entityId: number;
  slot: number;
  kind: SwarmKind;
  /** Collision radius — shipped on the wire and used by the server hitscan path. */
  radius: number;
  /** Polygon vertices in entity-local space, populated for kind=0 asteroids
   *  whose collider is a convex hull. Used by the polygon-aware hit resolver
   *  in `SectorRoom.handleFire`. The same array is the one passed to the
   *  physics worker at spawn time — single source of truth per asteroid. */
  vertices?: ReadonlyArray<Vec2>;
  /** Ship-kind id (e.g. 'fighter' / 'scout' / 'heavy'), only meaningful when
   *  `kind === 1` (drone). Asteroids carry no kind. Encoded on the wire as a
   *  u8 index into `SHIP_KINDS_LIST`; client renders the matching silhouette
   *  + colour. */
  shipKind?: string;
  /** Scrap-component index (scrap-on-death Phase 2a), only meaningful when
   *  `kind === 3` (scrap). Selects WHICH scrap group of the parent ship-kind
   *  (`shipKind` carries the parent id) this piece is — the index into
   *  `shipScrapGroups(parentKind)`. Encoded on the wire as the trailing u8 at
   *  `SWARM_REC_COMPONENT_INDEX_OFF`; absent / 0 for every other kind. */
  componentIndex?: number;
  /** Finite mineable resource pool (WS-4 / R2.27), only set for `kind === 0`
   *  asteroids — seeded from the silhouette area at spawn (`asteroidResources`).
   *  A Miner draws this down via `drawAsteroidResources`; an exhausted asteroid
   *  (`resources <= 0`) stops yielding but stays a solid obstacle (combat NEVER
   *  touches it — only mining). `resourcesMax` is the seed value (for the
   *  inspector / a remaining-fraction readout). Server-side state; surfaced to
   *  the client on a JSON slice in WS-4 Phase 6 (no `SWARM_WIRE_VERSION` bump). */
  resources?: number;
  resourcesMax?: number;
  /** Last pose actually included in a swarm packet, for delta detection.
   *  v3 (2026-05-09 AI lockstep) adds `angvel` so the encoder ships when a
   *  drone's spin rate changes even if its position is steady — the client AI
   *  needs the live `self.angvel` to feed the same damping term the server's
   *  AI uses. Pre-v3 the field was missing from the wire and from the delta
   *  detector; the client's drone angvel free-ran and AI torque diverged. */
  lastBroadcast: { x: number; y: number; angle: number; angvel: number };
  /** Phase: shield — true while this drone's shield is 0 (hull exposed).
   *  Maintained by SectorRoom at the shield 0-cross/restore; the swarm
   *  encoder ORs it into recordFlags bit 1. */
  shieldDown: boolean;
  /** Last sleeping flag included in a swarm packet, for transition detection. */
  lastBroadcastSleeping: boolean;
  /** Tick when this entity was last shipped in a packet. Used by sweepers later. */
  lastBroadcastTick: number;
}

const QUANT_POS = 0.05;   // 5 cm
const QUANT_ANGLE = 0.005; // ~0.3°
const QUANT_ANGVEL = 0.05; // ~3°/s; below this drones spin slowly enough that one-tick lag is invisible

/**
 * Speed (u/s, taxicab) above which we skip the quantisation check entirely
 * and ship pose every tick. Below this we treat the entity as effectively
 * stationary — pose updates are gated by quantisation. This keeps the wire
 * idle while asteroids drift below sub-quant velocities, but a thrusting
 * drone stays smooth (no freeze-burst chunking).
 */
const MOVING_SPEED_TAXI = 0.5;

export class SwarmEntityRegistry {
  private readonly byId = new Map<string, SwarmEntityRecord>();
  private readonly byEntityId = new Map<number, SwarmEntityRecord>();
  private readonly freeEntityIds: number[] = [];
  private nextEntityId = 0;

  /** Allocate a fresh dense entityId. Reuses freed ones first. */
  private allocEntityId(): number {
    const reused = this.freeEntityIds.pop();
    if (reused !== undefined) return reused;
    if (this.nextEntityId >= 65535) {
      throw new Error('SwarmEntityRegistry: exhausted u16 entity id space');
    }
    return this.nextEntityId++;
  }

  register(id: string, slot: number, kind: SwarmKind, radius: number, x: number, y: number, angle: number): SwarmEntityRecord {
    if (this.byId.has(id)) {
      throw new Error(`SwarmEntityRegistry: id "${id}" already registered`);
    }
    const entityId = this.allocEntityId();
    const record: SwarmEntityRecord = {
      id,
      entityId,
      slot,
      kind,
      radius,
      lastBroadcast: { x, y, angle, angvel: 0 },
      shieldDown: false,
      lastBroadcastSleeping: false,
      lastBroadcastTick: -1,
    };
    this.byId.set(id, record);
    this.byEntityId.set(entityId, record);
    return record;
  }

  unregister(id: string): SwarmEntityRecord | null {
    const rec = this.byId.get(id);
    if (!rec) return null;
    this.byId.delete(id);
    this.byEntityId.delete(rec.entityId);
    this.freeEntityIds.push(rec.entityId);
    return rec;
  }

  get(id: string): SwarmEntityRecord | null {
    return this.byId.get(id) ?? null;
  }

  getByEntityId(entityId: number): SwarmEntityRecord | null {
    return this.byEntityId.get(entityId) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  size(): number {
    return this.byId.size;
  }

  /** Iterate all registered records in registration order. */
  *all(): IterableIterator<SwarmEntityRecord> {
    for (const rec of this.byId.values()) yield rec;
  }

  /**
   * Returns true if (x,y,angle) differs from `lastBroadcast` by more than the
   * quantisation epsilons OR if the entity is currently moving. The velocity
   * gate is the fix for Defect 2 in the 5c-stabilise plan: when a drone is
   * accelerating its per-tick deltas dip below the quantisation threshold for
   * 2-3 ticks at a time, then jump above; the client saw freeze-burst-freeze.
   * Below MOVING_SPEED_TAXI the entity is treated as stationary and the
   * quantisation gate suppresses chatter.
   */
  static poseChanged(
    rec: SwarmEntityRecord,
    x: number,
    y: number,
    angle: number,
    vx: number,
    vy: number,
    angvel: number,
  ): boolean {
    if (Math.abs(vx) + Math.abs(vy) > MOVING_SPEED_TAXI) return true;
    return (
      Math.abs(rec.lastBroadcast.x - x) >= QUANT_POS ||
      Math.abs(rec.lastBroadcast.y - y) >= QUANT_POS ||
      Math.abs(rec.lastBroadcast.angle - angle) >= QUANT_ANGLE ||
      Math.abs(rec.lastBroadcast.angvel - angvel) >= QUANT_ANGVEL
    );
  }
}

export const SWARM_MOVING_SPEED_TAXI = MOVING_SPEED_TAXI;
export const SWARM_QUANT_ANGVEL = QUANT_ANGVEL;
