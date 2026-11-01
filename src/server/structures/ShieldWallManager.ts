/**
 * Shield-wall lifecycle (shield-fence plan; gates: plan soft-leaping-truffle v2
 * phase V). Owns the live walls a player's shield EMITTERS project, mirroring
 * eqx-peri's `GridManager` shield-wall bookkeeping. A wall is NOT a placed
 * structure / not a swarm entity — it forms automatically:
 *   - between two same-owner, CONSTRUCTED, CONNECTED emitters (Shield Pylons,
 *     Shield Gates, Shield Airlocks). A pylon end is its centre; a gate end is
 *     the gate post nearest the far end (`emitterAnchor`), so a fence runs
 *     right up to a gate's posts;
 *   - across each built gate's own gap (a "span": one for a Shield Gate, one per
 *     end for an Airlock). A span blocks only while its gate is CLOSED
 *     (`gateOpenMask`, from the GateController).
 * Geometry is derived from the structure poses with the shared core helpers, so
 * the server collider, the client prediction collider and the drawn span agree.
 *
 * Responsibilities:
 *   - `update(nowMs)` (called on the grid pulse + the faster turret tick):
 *     form/teardown walls as emitters appear/disappear, and refresh each wall's
 *     blocking state (powered + not stunned + not an open span) onto its
 *     physics collider.
 *   - `onWallHit(wallId, damage, nowMs)`: resolve a weapon hit via the
 *     grid-power model (surplus absorbs → batteries cover the excess → overwhelm
 *     both = stun). Server-authoritative.
 *   - `wallStateFor(postId)` / `wallsUpFor(id)`: the state room state surfaces
 *     so the client can derive + render + predict the walls.
 *   - `blockShot` / `blockProjectile` / `forEachActiveWall`: the main-thread
 *     weapon-vs-wall test (the server has no live Rapier world).
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
import {
  GATE_SPAN_THICKNESS,
  emitterAnchor,
  gateSpanWorld,
  gateSpans,
  gateTypeOf,
  isShieldEmitterKind,
} from '../../core/structures/gateGeometry.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

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
  /** Gates: open bits for a gate (bit i ⇒ span i open). Absent ⇒ none open. */
  gateOpenMask?(id: string): number;
}

interface WallRecord {
  /** Physics-body id for the wall. */
  id: string;
  postA: string;
  postB: string;
  /** World endpoints (structures are static, so fixed when the wall forms). */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** -1 for a wall between two emitters; ≥ 0 for a gate's own span (index),
   *  where postA === postB === the gate. */
  span: number;
  /** Wall-clock ms until which the wall is stunned (0 = not stunned). */
  stunnedUntilMs: number;
  /** Last value pushed to the collider, so we only post on a transition. */
  lastActive: boolean;
}

/** A structure's quarter-turn rotation in radians. */
function rotRad(rec: StructureRecord): number {
  return ((rec.rot ?? 0) * Math.PI) / 180;
}

export class ShieldWallManager {
  /** key → wall (emitter-pair walls by pair key, gate spans by body id). */
  private readonly walls = new Map<string, WallRecord>();
  /** Gate ids whose spans are formed (so steady-state reconcile builds no keys). */
  private readonly spanGates = new Set<string>();
  private readonly anchorA = { x: 0, y: 0 };
  private readonly anchorB = { x: 0, y: 0 };

  constructor(private readonly hooks: ShieldWallHooks) {}

  /** Form/teardown walls for the current emitter topology, then refresh each
   *  wall's blocking state. Cheap (emitters are few); safe to call every tick. */
  update(nowMs: number): void {
    this.reconcileTopology();
    for (const w of this.walls.values()) this.refreshActive(w, nowMs);
  }

  private reconcileTopology(): void {
    const reg = this.hooks.registry;
    // FORM: each built gate's spans, plus every same-owner, constructed,
    // connected emitter pair without a wall.
    for (const a of reg.all()) {
      if (!isShieldEmitterKind(a.kind) || !a.isConstructed) continue;
      if (gateTypeOf(a.kind) !== null && !this.spanGates.has(a.id)) this.formSpans(a);
      for (const conn of reg.connectionsOf(a.id)) {
        const otherId = conn.getOtherNode(a.id);
        if (otherId === null) continue;
        const b = reg.get(otherId);
        if (!b || !isShieldEmitterKind(b.kind) || !b.isConstructed || b.owner !== a.owner) continue;
        const key = wallPairKey(a.id, b.id);
        if (this.walls.has(key)) continue;
        // Each end anchors on the post nearest the other end (a pylon: its centre).
        emitterAnchor(b.kind, b.x, b.y, rotRad(b), a.x, a.y, this.anchorB);
        emitterAnchor(a.kind, a.x, a.y, rotRad(a), this.anchorB.x, this.anchorB.y, this.anchorA);
        emitterAnchor(b.kind, b.x, b.y, rotRad(b), this.anchorA.x, this.anchorA.y, this.anchorB);
        const id = `wall-${key}`;
        const w: WallRecord = {
          id, postA: a.id, postB: b.id,
          ax: this.anchorA.x, ay: this.anchorA.y, bx: this.anchorB.x, by: this.anchorB.y,
          span: -1, stunnedUntilMs: 0, lastActive: true,
        };
        this.hooks.spawnWall(id, w.ax, w.ay, w.bx, w.by, SHIELD_WALL_THICKNESS);
        this.walls.set(key, w);
      }
    }
    // TEARDOWN: any wall whose pair is no longer eligible (emitter destroyed /
    // disconnected / deconstructed / owner changed), or whose gate is gone.
    for (const [key, w] of this.walls) {
      if (this.wallEligible(w)) continue;
      this.hooks.removeWall(w.id);
      this.walls.delete(key);
      if (w.span >= 0) this.spanGates.delete(w.postA);
    }
  }

  /** Spawn a built gate's own shield spans (one per end). */
  private formSpans(gate: StructureRecord): void {
    const n = gateSpans(gate.kind).length;
    for (let i = 0; i < n; i++) {
      if (!gateSpanWorld(gate.kind, gate.x, gate.y, rotRad(gate), i, this.anchorA, this.anchorB)) continue;
      const id = `wall-gate-${gate.id}-${i}`;
      const w: WallRecord = {
        id, postA: gate.id, postB: gate.id,
        ax: this.anchorA.x, ay: this.anchorA.y, bx: this.anchorB.x, by: this.anchorB.y,
        span: i, stunnedUntilMs: 0, lastActive: true,
      };
      this.hooks.spawnWall(id, w.ax, w.ay, w.bx, w.by, GATE_SPAN_THICKNESS);
      this.walls.set(id, w);
    }
    this.spanGates.add(gate.id);
  }

  private wallEligible(w: WallRecord): boolean {
    const reg = this.hooks.registry;
    const a = reg.get(w.postA);
    if (w.span >= 0) return !!a && a.isConstructed && gateTypeOf(a.kind) !== null;
    const b = reg.get(w.postB);
    return (
      !!a && !!b &&
      isShieldEmitterKind(a.kind) && isShieldEmitterKind(b.kind) &&
      a.isConstructed && b.isConstructed &&
      a.owner === b.owner &&
      reg.hasConnection(a.id, b.id)
    );
  }

  /** The wall's shield is UP: powered and not stunned. */
  private up(w: WallRecord, nowMs: number): boolean {
    return isWallActive(this.hooks.powerSummaryFor(w.postA).powered, w.stunnedUntilMs, nowMs);
  }

  /** The wall blocks: up, and (for a gate span) its gate end is closed. */
  private blocks(w: WallRecord, nowMs: number): boolean {
    if (!this.up(w, nowMs)) return false;
    if (w.span < 0) return true;
    const mask = this.hooks.gateOpenMask?.(w.postA) ?? 0;
    return (mask & (1 << w.span)) === 0;
  }

  private refreshActive(w: WallRecord, nowMs: number): void {
    const active = this.blocks(w, nowMs);
    if (active !== w.lastActive) {
      this.hooks.setWallActive(w.id, active);
      w.lastActive = active;
    }
  }

  /**
   * Resolve a weapon hit on the wall with body id `wallId`. Returns true if the
   * shot was ABSORBED (the wall was blocking). Drains batteries for the excess
   * over the grid surplus; stuns the wall when both are overwhelmed.
   */
  onWallHit(wallId: string, damage: number, nowMs: number): boolean {
    const rec = this.byBodyId(wallId);
    if (!rec) return false;
    if (!this.blocks(rec, nowMs)) return false; // down, or an open gate span
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
   * grid-power model span-crossing shots use, via `onWallHit`). Returns true if
   * ABSORBED (⇒ the pylon takes 0 damage). Iterates ALL walls anchored on the
   * pylon and absorbs at the FIRST active one, so a multi-wall pylon stays
   * protected when any single wall is up. False when no wall is up.
   */
  absorbForPylon(pylonId: string, damage: number, nowMs: number): boolean {
    for (const w of this.walls.values()) {
      if (w.span >= 0) continue;
      if (w.postA !== pylonId && w.postB !== pylonId) continue;
      if (!this.blocks(w, nowMs)) continue;
      return this.onWallHit(w.id, damage, nowMs);
    }
    return false;
  }

  /** The `(otherPost, active)` of a pylon's FIRST fence wall (room state
   *  `shieldWallTo`). Clients derive every wall from connections +
   *  `wallsUpFor`; this stays for diagnostics and existing tests. */
  wallStateFor(postId: string, nowMs: number): { otherPost: string; active: boolean } | undefined {
    for (const w of this.walls.values()) {
      if (w.span >= 0) continue;
      if (w.postA !== postId && w.postB !== postId) continue;
      const other = w.postA === postId ? w.postB : w.postA;
      return { otherPost: other, active: this.up(w, nowMs) };
    }
    return undefined;
  }

  /**
   * An emitter's walls are UP: it has at least one wall (fence walls and, for a
   * gate, its spans) and every one is powered and not stunned. A gate span's
   * OPEN state doesn't count — that is a separate wire field. The client draws
   * and predicts walls from connections + this flag (STRUCTURE_FLAG_WALL_ACTIVE).
   */
  wallsUpFor(id: string, nowMs: number): boolean {
    let any = false;
    for (const w of this.walls.values()) {
      if (w.postA !== id && w.postB !== id) continue;
      any = true;
      if (!this.up(w, nowMs)) return false;
    }
    return any;
  }

  /**
   * If a blocking wall lies along a shot's UNIT ray within `maxDist`, absorb
   * the shot at the NEAREST such wall (apply its grid-power damage model) and
   * return the crossing distance; else null. Used by the player + AI hitscan
   * resolvers (ship blocking is the worker's static body).
   */
  blockShot(
    fromX: number, fromY: number, dirX: number, dirY: number,
    maxDist: number, damage: number, nowMs: number,
  ): number | null {
    let nearestDist = Infinity;
    let nearestId = '';
    for (const w of this.walls.values()) {
      if (!this.blocks(w, nowMs)) continue;
      const t = rayCrossesSegment(fromX, fromY, dirX, dirY, w.ax, w.ay, w.bx, w.by);
      if (t !== null && t <= maxDist && t < nearestDist) {
        nearestDist = t;
        nearestId = w.id;
      }
    }
    if (nearestId === '') return null;
    this.onWallHit(nearestId, damage, nowMs);
    return nearestDist;
  }

  /** Whether a projectile's one-tick step `(x,y)→(x+stepX,y+stepY)` crosses a
   *  blocking wall — if so, absorb it and return true so the caller drops the
   *  projectile. Alloc-free — safe in the per-tick projectile advance. */
  blockProjectile(x: number, y: number, stepX: number, stepY: number, damage: number, nowMs: number): boolean {
    const len = Math.hypot(stepX, stepY);
    if (len < 1e-6) return false;
    return this.blockShot(x, y, stepX / len, stepY / len, len, damage, nowMs) !== null;
  }

  /** Blocking wall segments, for the main-thread weapon-vs-wall test. */
  forEachActiveWall(
    nowMs: number,
    cb: (wallId: string, ax: number, ay: number, bx: number, by: number) => void,
  ): void {
    for (const w of this.walls.values()) {
      if (!this.blocks(w, nowMs)) continue;
      cb(w.id, w.ax, w.ay, w.bx, w.by);
    }
  }

  /** Tear down every wall (room dispose). */
  removeAll(): void {
    for (const w of this.walls.values()) this.hooks.removeWall(w.id);
    this.walls.clear();
    this.spanGates.clear();
  }

  private byBodyId(wallId: string): WallRecord | undefined {
    for (const w of this.walls.values()) if (w.id === wallId) return w;
    return undefined;
  }
}
