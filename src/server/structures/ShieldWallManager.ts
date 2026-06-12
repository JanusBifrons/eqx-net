/**
 * Shield-wall lifecycle (shield-fence plan). Owns the live walls a player's
 * paired `shield_pylon`s project, mirroring eqx-peri's `GridManager` shield-wall
 * bookkeeping. A wall is NOT a placed structure / not a swarm entity — it forms
 * automatically between two same-owner, CONSTRUCTED, CONNECTED pylons, and its
 * geometry is derived from the two pylon poses (so the server collider, the
 * client predWorld collider, and the rendered span all agree).
 *
 * Responsibilities:
 *   - `update(nowMs)` (called on the grid pulse + the faster turret tick):
 *     form/teardown walls as pylon pairs appear/disappear, and refresh each
 *     wall's ACTIVE state (powered + not stunned) onto its physics collider.
 *   - `onWallHit(wallId, damage, nowMs)`: resolve a weapon hit via the
 *     grid-power model (surplus absorbs → batteries cover the excess → overwhelm
 *     both = stun). Server-authoritative.
 *   - `wallStateFor(postId)`: the `(otherPost, active)` pair the snapshot slice
 *     surfaces so the client can derive + render the span.
 *   - `forEachActiveWall(nowMs, cb)`: active wall segments for the main-thread
 *     weapon-vs-wall absorption test (the server has no live Rapier world).
 *
 * All decision logic over injected hooks — unit-testable like the other
 * structure subsystems.
 */
import {
  SHIELD_WALL_THICKNESS,
  SHIELD_WALL_STUN_MS,
  isWallActive,
  rayCrossesSegment,
  resolveWallHit,
  wallPairKey,
} from '../../core/structures/ShieldWall.js';
import type { StructureRegistry } from './StructureRegistry.js';

export interface ShieldWallHooks {
  registry: StructureRegistry;
  /** Battery-backed power summary (the grid subsystem's effective one). */
  powerSummaryFor(id: string): { netPower: number; powered: boolean };
  /** Total stored battery charge in the component containing `id`. */
  componentBatteryCharge(id: string): number;
  /** Drain `amount` from the component's batteries; returns the amount drained. */
  drainComponentBatteries(id: string, amount: number): number;
  /** Post the worker wall commands (via the PhysicsWorkerProxy). */
  spawnWall(id: string, ax: number, ay: number, bx: number, by: number, thickness: number): void;
  setWallActive(id: string, active: boolean): void;
  removeWall(id: string): void;
}

interface WallRecord {
  /** Physics-body id for the span (`wall-${pairKey}`). */
  id: string;
  postA: string;
  postB: string;
  /** Wall-clock ms until which the wall is stunned (0 = not stunned). */
  stunnedUntilMs: number;
  /** Last value pushed to the collider, so we only post on a transition. */
  lastActive: boolean;
}

export class ShieldWallManager {
  /** pairKey → wall. */
  private readonly walls = new Map<string, WallRecord>();

  constructor(private readonly hooks: ShieldWallHooks) {}

  /** Form/teardown walls for the current pylon topology, then refresh each
   *  wall's active state. Cheap (pylons are few); safe to call every tick. */
  update(nowMs: number): void {
    this.reconcileTopology();
    for (const w of this.walls.values()) this.refreshActive(w, nowMs);
  }

  private reconcileTopology(): void {
    const reg = this.hooks.registry;
    // FORM: every same-owner, constructed, connected pylon pair without a wall.
    for (const a of reg.all()) {
      if (a.kind !== 'shield_pylon' || !a.isConstructed) continue;
      for (const conn of reg.connectionsOf(a.id)) {
        const otherId = conn.getOtherNode(a.id);
        if (otherId === null) continue;
        const b = reg.get(otherId);
        if (!b || b.kind !== 'shield_pylon' || !b.isConstructed || b.owner !== a.owner) continue;
        const key = wallPairKey(a.id, b.id);
        if (this.walls.has(key)) continue;
        const id = `wall-${key}`;
        this.hooks.spawnWall(id, a.x, a.y, b.x, b.y, SHIELD_WALL_THICKNESS);
        this.walls.set(key, { id, postA: a.id, postB: b.id, stunnedUntilMs: 0, lastActive: true });
      }
    }
    // TEARDOWN: any wall whose pair is no longer eligible (pylon destroyed /
    // disconnected / deconstructed / owner changed).
    for (const [key, w] of this.walls) {
      if (!this.pairEligible(w)) {
        this.hooks.removeWall(w.id);
        this.walls.delete(key);
      }
    }
  }

  private pairEligible(w: WallRecord): boolean {
    const reg = this.hooks.registry;
    const a = reg.get(w.postA);
    const b = reg.get(w.postB);
    return (
      !!a && !!b &&
      a.kind === 'shield_pylon' && b.kind === 'shield_pylon' &&
      a.isConstructed && b.isConstructed &&
      a.owner === b.owner &&
      reg.hasConnection(a.id, b.id)
    );
  }

  private refreshActive(w: WallRecord, nowMs: number): void {
    const powered = this.hooks.powerSummaryFor(w.postA).powered;
    const active = isWallActive(powered, w.stunnedUntilMs, nowMs);
    if (active !== w.lastActive) {
      this.hooks.setWallActive(w.id, active);
      w.lastActive = active;
    }
  }

  /**
   * Resolve a weapon hit on the wall with body id `wallId`. Returns true if the
   * shot was ABSORBED (the wall was active). Drains batteries for the excess
   * over the grid surplus; stuns the wall when both are overwhelmed.
   */
  onWallHit(wallId: string, damage: number, nowMs: number): boolean {
    const rec = this.byBodyId(wallId);
    if (!rec) return false;
    const powered = this.hooks.powerSummaryFor(rec.postA).powered;
    if (!isWallActive(powered, rec.stunnedUntilMs, nowMs)) return false; // already down
    const { netPower } = this.hooks.powerSummaryFor(rec.postA);
    const charge = this.hooks.componentBatteryCharge(rec.postA);
    const result = resolveWallHit(damage, netPower, charge);
    if (result.batteryDrain > 0) this.hooks.drainComponentBatteries(rec.postA, result.batteryDrain);
    if (result.stun) {
      rec.stunnedUntilMs = nowMs + SHIELD_WALL_STUN_MS;
      if (rec.lastActive) { this.hooks.setWallActive(rec.id, false); rec.lastActive = false; }
    }
    return true;
  }

  /**
   * R2.18 — a Shield Pylon is undamageable while ANY of its walls is up: route
   * damage aimed at the PYLON BODY into an active wall instead (the same
   * grid-power model span-crossing shots use, via `onWallHit` — so a hit on the
   * pylon and a hit through the span drain the SAME component buffer and can
   * both eventually stun the wall). Returns true if ABSORBED (⇒ the pylon takes
   * 0 damage). Iterates ALL walls anchored on the pylon and absorbs at the FIRST
   * ACTIVE one, so a multi-wall pylon stays protected when any single wall is up
   * (NOT just the first-iterated, which may be stunned). Returns false when no
   * wall is up ⇒ the pylon is damageable normally.
   */
  absorbForPylon(pylonId: string, damage: number, nowMs: number): boolean {
    for (const w of this.walls.values()) {
      if (w.postA !== pylonId && w.postB !== pylonId) continue;
      const powered = this.hooks.powerSummaryFor(w.postA).powered;
      if (!isWallActive(powered, w.stunnedUntilMs, nowMs)) continue;
      // Delegate to onWallHit (keyed off postA's component) so body-directed and
      // span-crossing absorption stay byte-identical in their grid effect.
      return this.onWallHit(w.id, damage, nowMs);
    }
    return false;
  }

  /** The `(otherPost, active)` for a pylon, for the snapshot slice. The pylon
   *  may anchor more than one wall (≤3 connections); the FIRST is surfaced
   *  (one span rendered per pair; the client dedups by pair anyway). */
  wallStateFor(postId: string, nowMs: number): { otherPost: string; active: boolean } | undefined {
    for (const w of this.walls.values()) {
      if (w.postA !== postId && w.postB !== postId) continue;
      const other = w.postA === postId ? w.postB : w.postA;
      const powered = this.hooks.powerSummaryFor(w.postA).powered;
      return { otherPost: other, active: isWallActive(powered, w.stunnedUntilMs, nowMs) };
    }
    return undefined;
  }

  /**
   * If an ACTIVE wall lies along a shot's UNIT ray within `maxDist`, absorb the
   * shot at the NEAREST such wall (apply its grid-power damage model) and return
   * the crossing distance; else null. The server has no live Rapier world, so
   * beam-vs-wall absorption is this main-thread segment test (ship blocking is
   * the worker's static body). Used by the player + AI hitscan resolvers.
   */
  blockShot(
    fromX: number, fromY: number, dirX: number, dirY: number,
    maxDist: number, damage: number, nowMs: number,
  ): number | null {
    let nearestDist = Infinity;
    let nearestId = '';
    for (const w of this.walls.values()) {
      if (!isWallActive(this.hooks.powerSummaryFor(w.postA).powered, w.stunnedUntilMs, nowMs)) continue;
      const a = this.hooks.registry.get(w.postA);
      const b = this.hooks.registry.get(w.postB);
      if (!a || !b) continue;
      const t = rayCrossesSegment(fromX, fromY, dirX, dirY, a.x, a.y, b.x, b.y);
      if (t !== null && t <= maxDist && t < nearestDist) {
        nearestDist = t;
        nearestId = w.id;
      }
    }
    if (nearestId === '') return null;
    this.onWallHit(nearestId, damage, nowMs);
    return nearestDist;
  }

  /** Whether a projectile's one-tick step `(x,y)→(x+stepX,y+stepY)` crosses an
   *  ACTIVE wall — if so, absorb it (apply the wall's grid-power damage) and
   *  return true so the caller drops the projectile. Alloc-free (delegates to
   *  the for-loop `blockShot`) — safe in the per-tick projectile advance. */
  blockProjectile(x: number, y: number, stepX: number, stepY: number, damage: number, nowMs: number): boolean {
    const len = Math.hypot(stepX, stepY);
    if (len < 1e-6) return false;
    return this.blockShot(x, y, stepX / len, stepY / len, len, damage, nowMs) !== null;
  }

  /** Active wall segments (pylon-to-pylon), for the main-thread weapon-vs-wall
   *  absorption test. Reads live pylon poses from the registry. */
  forEachActiveWall(
    nowMs: number,
    cb: (wallId: string, ax: number, ay: number, bx: number, by: number) => void,
  ): void {
    const reg = this.hooks.registry;
    for (const w of this.walls.values()) {
      const powered = this.hooks.powerSummaryFor(w.postA).powered;
      if (!isWallActive(powered, w.stunnedUntilMs, nowMs)) continue;
      const a = reg.get(w.postA);
      const b = reg.get(w.postB);
      if (!a || !b) continue;
      cb(w.id, a.x, a.y, b.x, b.y);
    }
  }

  /** Tear down every wall (room dispose). */
  removeAll(): void {
    for (const w of this.walls.values()) this.hooks.removeWall(w.id);
    this.walls.clear();
  }

  private byBodyId(wallId: string): WallRecord | undefined {
    for (const w of this.walls.values()) if (w.id === wallId) return w;
    return undefined;
  }
}
