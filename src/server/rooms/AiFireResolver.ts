/**
 * Per-drone weapon-fire pipeline (AI side).
 *
 * Mirrors the player hitscan path (`SectorRoom.handleFire`) but skips
 * the message parser, the per-session hit_ack, and the temporal-
 * plausibility window — AI fires at the current tick by definition.
 * Cooldown is enforced via the same `lastFireClientTick` Map keyed by
 * AI shooter id.
 *
 * Owns nothing of its own; reaches into the room via deps for the
 * cooldown ledger, the drone pose snapshot, the mount catalogue + slewed
 * angles, the player target candidates, and the damage / broadcast
 * seams. Single-fire-path-per-side contract (Invariant #12).
 *
 * Extracted from SectorRoom (commit 21 partial; src/server/CLAUDE.md
 * "Multi-mount fire path" section).
 */

import { hasTurretFireControl } from '../../core/combat/mountReach.js';
import { DEFAULT_SHIP_KIND, getShipKind, type ShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import {
  getWeapon,
  hitscanFalloffFrac,
  type MissileWeaponDef,
  type WeaponId,
} from '../../core/combat/WeaponCatalogue.js';
import { getWeaponObject } from '../../core/combat/weapons/index.js';
import type { WeaponFireContext, WeaponFireSink } from '../../core/combat/weapons/Weapon.js';
import type { AiEntity } from '../../core/contracts/IAiBehaviour.js';
import type { LaserFiredEvent } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';
import { shipShotMuzzle, navalTurret, navalBarrelOffset } from '../../core/combat/muzzle.js';
import { NEVER_FIRED } from '../../core/combat/fireTemporal.js';

/** Per-player pose the resolver reads to test target hits. */
export interface ShipPose {
  x: number;
  y: number;
  angle: number;
}

/** Narrow view of swarmRegistry — only `get(id)` is needed for kind + entityId. */
export interface SwarmRecLookup {
  get(id: string): { entityId: number; shipKind?: string | null } | null | undefined;
}

export interface AiFireResolverDeps {
  /** Fire control: refuse a shot at `targetId` when it is a pilot this NPC
   *  holds no completed lock on. Absent ⇒ never blocked. */
  fireBlocked?: (shooterId: string, targetId: string) => boolean;
  /** NPC line of fire (friendly fire slice 2): true ⇒ a FRIENDLY body lies
   *  between the shooter at (fx, fy) and `targetId` along unit (dx, dy), so
   *  the drone holds fire this tick (no cooldown spent). The room resolves the
   *  target's distance. Absent ⇒ never blocked (unit harnesses). */
  lineOfFireBlocked?: (shooterId: string, targetId: string, fx: number, fy: number, dx: number, dy: number) => boolean;
  /** Cooldown ledger — keyed by shooter id (drone). */
  lastFireClientTick: Map<string, number>;
  /** Pose snapshot for the firing drone (SAB read). */
  swarmEntitySnapshot: (id: string) => AiEntity | null;
  /** Lookup for the drone's entityId + ship kind (wire id + mount list). */
  swarmRegistry: SwarmRecLookup;
  /** Resolves the active-slot mount list for a kind. */
  resolveSlotMounts: (kind: ShipKind, slotId?: string) => ReadonlyArray<WeaponMount>;
  /** Pure mount world-origin helper (composes mountGeometry.ts). */
  mountWorldOrigin: (
    shipX: number, shipY: number, shipAngle: number, mount: WeaponMount,
  ) => { x: number; y: number };
  /** Per-drone slewed mount angles (one Float32Array per drone). */
  droneMountAngles: Map<string, Float32Array>;
  /** Iterable of `[playerId, _]` for target candidates. */
  playerToSlot: Iterable<[string, number]>;
  /** Active-ship resolver — skips destroyed / lingering targets. */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Per-tick player pose cache. */
  shipPoseCache: Map<string, ShipPose>;
  /** Shield-aware ray-vs-ship test (cheap circle / hull-polygon refine). */
  playerHitscanDist: (
    ship: ShipState,
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number,
    cx: number, cy: number, angle: number,
  ) => number | null;
  /** Damage sink — invoked on a confirmed hit. */
  applyDamage: (targetId: string, shooterId: string, damage: number) => void;
  /** Friendly fire (owner decision 2026-11-10) — the first non-player thing
   *  along the beam: every swarm entity (drones of ANY side, structures of ANY
   *  owner, asteroids, scrap) and lingering hulls, skipping only `skipId` (the
   *  shooter). Returns a reused scratch (read it before the next call) or null.
   *  Absent ⇒ the beam tests players only (unit harnesses). Replaced the
   *  hostile-structure + other-allegiance passes, which let a beam pass through
   *  its own side. */
  nonPlayerRayHit?: (
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, skipId: string,
  ) => { id: string; wireId: string; dist: number } | null;
  /** Shield-fence plan — if an ACTIVE shield wall lies along the beam within
   *  `maxDist`, absorb the shot (apply the wall's grid-power damage model) and
   *  return the crossing distance; else null. Absent ⇒ no walls in the sector
   *  (byte-identical to the pre-fence behaviour). */
  blockBeamAtWall?: (
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, damage: number,
  ) => number | null;
  /** Broadcast a laser_fired event to every client. */
  broadcast: (type: 'laser_fired', msg: LaserFiredEvent) => void;
  /** Spawn a server-side projectile (delegates to ProjectilePipeline). Bolt
   *  drones (scout/fighter/heavy/gunship after the weapons overhaul) fire
   *  through this. */
  spawnServerProjectile: (
    ownerId: string,
    x: number, y: number, vx: number, vy: number,
    damage: number, radius: number, maxTicks: number,
    weaponId: WeaponId,
  ) => void;
  /** Spawn a server-side missile (delegates to MissileSimulation). Returns
   *  the assigned missileId on success or `null` on pool overflow. */
  spawnServerMissile: (
    ownerId: string,
    spawnX: number, spawnY: number,
    dirX: number, dirY: number,
    def: MissileWeaponDef,
  ) => number | null;
}

export class AiFireResolver implements WeaponFireSink {
  constructor(private readonly deps: AiFireResolverDeps) {}

  /** Reused per-mount fire geometry (the resolver IS the WeaponFireSink — see
   *  `src/core/combat/weapons/`). Mutated per mount; no per-fire allocation. */
  private readonly _fireCtx: WeaponFireContext = {
    fromX: 0, fromY: 0, dirX: 0, dirY: 0, shooterVx: 0, shooterVy: 0, mountId: '',
  };
  // Per-fire-event sink state — set in resolve() before the salvo.
  private _shooterId = '';
  private _wireShooterId = '';

  /**
   * Resolve an AI fire claim. Cooldown-rejected → silent no-op.
   * Zero-length direction → silent no-op. Per-mount iteration: each
   * mount in the drone's slot produces an independent laser_fired
   * broadcast with its own ray geometry; aggregate hit goes to the
   * damage sink (`applyDamage`).
   */
  resolve(shooterId: string, dirX: number, dirY: number, tick: number, targetId: string): void {
    const d = this.deps;

    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) return;
    const dirNdx = dirX / len;
    const dirNdy = dirY / len;

    // Drone fires from its own pose, offset 16u along the firing
    // direction so it doesn't self-hit on the next-tick ray.
    const self = d.swarmEntitySnapshot(shooterId);
    if (!self) return;
    const shooterRec = d.swarmRegistry.get(shooterId);
    const droneKindId = shooterRec?.shipKind ?? DEFAULT_SHIP_KIND;
    const droneKind = getShipKind(droneKindId);
    // Capitals fire turret by turret under WeaponMountTicker fire control
    // (fireMount), never as a hull-aimed salvo.
    if (hasTurretFireControl(droneKind)) return;
    const slotMounts = d.resolveSlotMounts(droneKind);
    if (slotMounts.length === 0) return;
    // Fire control: a pilot target needs a COMPLETED lock by this drone ⇒
    // no shot (the cooldown is not spent).
    if (d.fireBlocked?.(shooterId, targetId)) return;
    // Line of fire: an ally (or its own base) in the way ⇒ hold this tick.
    // Before the cooldown, so a held shot fires the moment the line clears.
    if (d.lineOfFireBlocked?.(shooterId, targetId, self.x, self.y, dirNdx, dirNdy)) return;

    // Slot-level cooldown gate (mirrors PlayerFireResolver). The slot fires
    // as one trigger; its cooldown is the MAX over its mounts' weapons.
    // Single-slot drones reuse the per-shooter scalar `lastFireClientTick`.
    let slotCooldown = 0;
    for (let i = 0; i < slotMounts.length; i++) {
      const c = getWeapon(slotMounts[i]!.weaponId).cooldownTicks;
      if (c > slotCooldown) slotCooldown = c;
    }
    const lastFireCt = d.lastFireClientTick.get(shooterId) ?? NEVER_FIRED;
    if (tick - lastFireCt < slotCooldown) return;
    d.lastFireClientTick.set(shooterId, tick);

    // Living World P3c — a CHARGE weapon winds up instead of firing: lock the
    // direction now, fire it `chargeTicks` later from `releaseCharges` (the
    // telegraph rides `drones[].charging`). One reused record per shooter.
    let chargeTicks = 0;
    for (let i = 0; i < slotMounts.length; i++) {
      const w = getWeapon(slotMounts[i]!.weaponId);
      if (w.mode === 'hitscan' && (w.chargeTicks ?? 0) > chargeTicks) chargeTicks = w.chargeTicks!;
    }
    if (chargeTicks > 0) {
      let c = this.charges.get(shooterId);
      if (c === undefined) {
        c = { active: false, readyTick: 0, dirX: 0, dirY: 0 };
        this.charges.set(shooterId, c);
      }
      c.active = true;
      c.readyTick = tick + chargeTicks;
      c.dirX = dirNdx;
      c.dirY = dirNdy;
      return;
    }
    this.fireNow(shooterId, dirNdx, dirNdy);
  }


  /** Capital fire control: fire ONE mount along its barrel (hull angle +
   *  base angle + the slewed mount angle). Reload, reach and on-target checks
   *  are the caller's (WeaponMountTicker.tickDrone). */
  fireMount(shooterId: string, mountIdx: number): void {
    const self = this.deps.swarmEntitySnapshot(shooterId);
    if (!self) return;
    this.fireNow(shooterId, -Math.sin(self.angle), Math.cos(self.angle), mountIdx);
  }
  /** Quad AA: the next barrel to fire, per shooter and mount index. */
  private readonly aaBarrel = new Map<string, Uint8Array>();

  /** Release every charge whose wind-up has elapsed (call once per server
   *  tick, after the AI tick). Fires from the shooter's CURRENT pose along the
   *  LOCKED direction — a dodgeable telegraph. Allocation-free. */
  releaseCharges(tick: number): void {
    if (this.charges.size === 0) return;
    for (const [id, c] of this.charges) {
      if (!c.active || tick < c.readyTick) continue;
      c.active = false;
      this.fireNow(id, c.dirX, c.dirY);
    }
  }

  /** The drone is mid wind-up (the snapshot `drones[].charging` bit). */
  isCharging(shooterId: string): boolean {
    return this.charges.get(shooterId)?.active === true;
  }

  /** The shooter left the world — drop its charge. */
  forget(shooterId: string): void {
    this.charges.delete(shooterId);
    this.aaBarrel.delete(shooterId);
  }

  /** P3c — per-shooter wind-up records (reused; never per-tick allocated). */
  private readonly charges = new Map<string, { active: boolean; readyTick: number; dirX: number; dirY: number }>();

  /** Fire the shooter's active slot now along a unit direction. */
  private fireNow(shooterId: string, dirNdx: number, dirNdy: number, onlyMount = -1): void {
    const d = this.deps;
    const self = d.swarmEntitySnapshot(shooterId);
    if (!self) return;
    const shooterRec = d.swarmRegistry.get(shooterId);
    const droneKindId = shooterRec?.shipKind ?? DEFAULT_SHIP_KIND;
    const droneKind = getShipKind(droneKindId);
    const slotMounts = d.resolveSlotMounts(droneKind);
    if (slotMounts.length === 0) return;

    // The fire direction the AI computed is the drone's body intent.
    // Re-express as an angle so mount.baseAngle can be added per mount.
    // For drones with rotating mounts, also add the per-mount slewed
    // angle from droneMountAngles so hits land where the visible barrel
    // points (and so the broadcast laser_fired carries the same
    // direction observers see the turret aimed at). Legacy single-mount
    // drones have no droneMountAngles entry → currentMountAngle = 0,
    // preserving the pre-4c behaviour bit-for-bit.
    const fireAngle = Math.atan2(-dirNdx, dirNdy);
    const wireShooterId = shooterRec ? `swarm-${shooterRec.entityId}` : shooterId;
    const droneAngles = d.droneMountAngles.get(shooterId);
    this._shooterId = shooterId;
    this._wireShooterId = wireShooterId;
    const ctx = this._fireCtx;

    // Per-mount weapon resolution (weapons/energy/AI overhaul §1). Each barrel
    // fires its OWN catalogue weapon, range/damage off the resolved def. The
    // per-mode fire dispatch collapses to one virtual call (GEP B3): the weapon
    // flyweight calls back the matching sink method below.
    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      if (onlyMount >= 0 && mIdx !== onlyMount) continue;
      const mount = slotMounts[mIdx]!;
      const mountWorld = d.mountWorldOrigin(self.x, self.y, self.angle, mount);
      const currentMountAngle = droneAngles?.[mIdx] ?? 0;
      const mountFireAngle = fireAngle + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      // Barrel tip for a turning turret; chin guns keep the drone clearance.
      const muzzleD = shipShotMuzzle(droneKind, mount, true);
      const rayFromX = mountWorld.x + ndx * muzzleD;
      const rayFromY = mountWorld.y + ndy * muzzleD;

      ctx.fromX = rayFromX;
      ctx.fromY = rayFromY;
      ctx.dirX = ndx;
      ctx.dirY = ndy;
      ctx.shooterVx = self.vx;
      ctx.shooterVy = self.vy;
      ctx.mountId = mount.id;
      // A naval turret fires a full salvo: one shell per barrel, each from
      // its own drawn barrel tip (shared offsets, core/combat/muzzle.ts).
      const naval = navalTurret(droneKind, mount);
      if (naval === null || naval.barrels <= 1) {
        getWeaponObject(mount.weaponId).resolveFire(ctx, this);
        continue;
      }
      const rightX = ndy, rightY = -ndx;
      if (mount.size === 'AA') {
        // Quad AA: the barrels fire in turn, one per trigger (a stream).
        let cyc = this.aaBarrel.get(shooterId);
        if (cyc === undefined || cyc.length < slotMounts.length) { cyc = new Uint8Array(slotMounts.length); this.aaBarrel.set(shooterId, cyc); }
        const k = cyc[mIdx]! % naval.barrels;
        cyc[mIdx] = k + 1;
        const off = navalBarrelOffset(naval, k);
        ctx.fromX = rayFromX + rightX * off;
        ctx.fromY = rayFromY + rightY * off;
        getWeaponObject(mount.weaponId).resolveFire(ctx, this);
        continue;
      }
      for (let k = 0; k < naval.barrels; k++) {
        const off = navalBarrelOffset(naval, k);
        ctx.fromX = rayFromX + rightX * off;
        ctx.fromY = rayFromY + rightY * off;
        getWeaponObject(mount.weaponId).resolveFire(ctx, this);
      }
    }
  }

  // ─── WeaponFireSink — relocated VERBATIM from the former mode if-tree (GEP B3) ───

  /** Beam: instant lag-comp-free hit test against live player poses; on hit,
   *  applyDamage (internal shooter id); always broadcast laser_fired on the
   *  WIRE shooter id. */
  hitscan(ctx: WeaponFireContext, range: number, damage: number, falloffMinDamageFrac?: number, maxRange?: number): void {
    const d = this.deps;
    // P3.13 — `range` is the OPTIMAL (full-damage) range; the ray reaches
    // `maxRange` (≥ range) and damage falls off reverse-square BEYOND optimal.
    const rayRange = maxRange ?? range;
    const rayFromX = ctx.fromX;
    const rayFromY = ctx.fromY;
    const ndx = ctx.dirX;
    const ndy = ctx.dirY;
    let hitId: string | null = null;
    let wireHitId: string | null = null;
    let hitDist = Infinity;
    for (const [targetId] of d.playerToSlot) {
      const targetShip = d.getActiveShip(targetId);
      if (!targetShip || !targetShip.alive) continue;
      const pose = d.shipPoseCache.get(targetId);
      if (!pose) continue;
      const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, rayRange, pose.x, pose.y, pose.angle);
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = targetId;
        wireHitId = targetId;
      }
    }

    // Friendly fire (owner decision 2026-11-10): everything else in the path,
    // whatever its side — drones, structures, rocks, scrap, parked hulls.
    // Closest-of-both wins, so an ally in front of the target takes the beam.
    const other = d.nonPlayerRayHit?.(rayFromX, rayFromY, ndx, ndy, Math.min(rayRange, hitDist), this._shooterId) ?? null;
    if (other !== null && other.dist < hitDist) {
      hitDist = other.dist;
      hitId = other.id;
      wireHitId = other.wireId;
    }

    // Shield-fence plan: an ACTIVE shield wall in front of the target absorbs
    // the beam (the wall takes the hit; the target behind takes nothing). Only
    // walls closer than the resolved target (or the range, with no target) count.
    const scanDist = hitDist === Infinity ? rayRange : hitDist;
    const wallDist = d.blockBeamAtWall?.(rayFromX, rayFromY, ndx, ndy, scanDist, damage) ?? null;
    if (wallDist === null && hitId) {
      // P3.13 — full to optimal `range`, reverse-square falloff to maxRange
      // (server-authoritative; the client never predicts beam damage).
      const effDamage = falloffMinDamageFrac !== undefined
        ? damage * hitscanFalloffFrac(hitDist, range, rayRange, falloffMinDamageFrac)
        : damage;
      d.applyDamage(hitId, this._shooterId, effDamage);
    }

    const blocked = wallDist !== null;
    const endDist = blocked ? wallDist : scanDist;
    const beamEndX = rayFromX + ndx * endDist;
    const beamEndY = rayFromY + ndy * endDist;

    d.broadcast('laser_fired', {
      type: 'laser_fired',
      shooterId: this._wireShooterId,
      mountId: ctx.mountId,
      fromX: rayFromX,
      fromY: rayFromY,
      toX: beamEndX,
      toY: beamEndY,
      hit: blocked || !!hitId,
      targetId: blocked ? undefined : (wireHitId ?? undefined),
    });
  }

  /** Bolt: spawn a server projectile (inherits the drone's velocity). */
  spawnProjectile(
    ctx: WeaponFireContext,
    vx: number,
    vy: number,
    damage: number,
    radius: number,
    maxTicks: number,
    weaponId: WeaponId,
  ): void {
    this.deps.spawnServerProjectile(this._shooterId, ctx.fromX, ctx.fromY, vx, vy, damage, radius, maxTicks, weaponId);
  }

  /** Missile: lock-at-launch + lifecycle owned by MissileSimulation. */
  spawnMissile(ctx: WeaponFireContext, def: MissileWeaponDef): void {
    this.deps.spawnServerMissile(this._shooterId, ctx.fromX, ctx.fromY, ctx.dirX, ctx.dirY, def);
  }
}
