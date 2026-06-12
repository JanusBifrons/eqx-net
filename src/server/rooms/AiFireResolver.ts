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

import { DEFAULT_SHIP_KIND, getShipKind, type ShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import {
  getWeapon,
  hitscanFalloffFrac,
  type MissileWeaponDef,
  type WeaponId,
} from '../../core/combat/WeaponCatalogue.js';
import { getWeaponObject } from '../../core/combat/weapons/index.js';
import type { WeaponFireContext, WeaponFireSink } from '../../core/combat/weapons/Weapon.js';
import { rayHitsSphere } from '../../core/combat/Weapons.js';
import type { AiEntity } from '../../core/contracts/IAiBehaviour.js';
import type { LaserFiredEvent } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';

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
  /** Wave-system Phase 2 — hostile structures this drone may hit, as static
   *  circles. Optional: omitted (or empty) ⇒ the beam tests players only
   *  (pre-wave behaviour, byte-identical). The room supplies the faction-
   *  filtered, constructed structures the drone's body target already selected
   *  among. A structure beam hit routes through `applyDamage(structureId,
   *  shooterId, …)` → the StructureEntity leaf (no new damage branch). */
  structureHitTargets?: () => Iterable<{ id: string; x: number; y: number; radius: number }>;
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
  resolve(shooterId: string, dirX: number, dirY: number, tick: number): void {
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
    const slotMounts = d.resolveSlotMounts(droneKind);
    if (slotMounts.length === 0) return;

    // Slot-level cooldown gate (mirrors PlayerFireResolver). The slot fires
    // as one trigger; its cooldown is the MAX over its mounts' weapons.
    // Single-slot drones reuse the per-shooter scalar `lastFireClientTick`.
    let slotCooldown = 0;
    for (let i = 0; i < slotMounts.length; i++) {
      const c = getWeapon(slotMounts[i]!.weaponId).cooldownTicks;
      if (c > slotCooldown) slotCooldown = c;
    }
    const lastFireCt = d.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < slotCooldown) return;
    d.lastFireClientTick.set(shooterId, tick);

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
      const mount = slotMounts[mIdx]!;
      const mountWorld = d.mountWorldOrigin(self.x, self.y, self.angle, mount);
      const currentMountAngle = droneAngles?.[mIdx] ?? 0;
      const mountFireAngle = fireAngle + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      const rayFromX = mountWorld.x + ndx * 16;
      const rayFromY = mountWorld.y + ndy * 16;

      ctx.fromX = rayFromX;
      ctx.fromY = rayFromY;
      ctx.dirX = ndx;
      ctx.dirY = ndy;
      ctx.shooterVx = self.vx;
      ctx.shooterVy = self.vy;
      ctx.mountId = mount.id;
      getWeaponObject(mount.weaponId).resolveFire(ctx, this);
    }
  }

  // ─── WeaponFireSink — relocated VERBATIM from the former mode if-tree (GEP B3) ───

  /** Beam: instant lag-comp-free hit test against live player poses; on hit,
   *  applyDamage (internal shooter id); always broadcast laser_fired on the
   *  WIRE shooter id. */
  hitscan(ctx: WeaponFireContext, range: number, damage: number, falloffMinDamageFrac?: number): void {
    const d = this.deps;
    const rayFromX = ctx.fromX;
    const rayFromY = ctx.fromY;
    const ndx = ctx.dirX;
    const ndy = ctx.dirY;
    let hitId: string | null = null;
    let hitDist = Infinity;
    for (const [targetId] of d.playerToSlot) {
      const targetShip = d.getActiveShip(targetId);
      if (!targetShip || !targetShip.alive) continue;
      const pose = d.shipPoseCache.get(targetId);
      if (!pose) continue;
      const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, range, pose.x, pose.y, pose.angle);
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = targetId;
      }
    }

    // Wave-system Phase 2: second pass against hostile structures (static
    // circles). Closest-of-both-passes wins, so a structure in front of a
    // player takes the beam. Absent/empty source ⇒ this loop never runs ⇒
    // byte-identical to the player-only path.
    const structs = d.structureHitTargets?.();
    if (structs) {
      for (const s of structs) {
        const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, range, s.x, s.y, s.radius);
        if (dist !== null && dist < hitDist) {
          hitDist = dist;
          hitId = s.id;
        }
      }
    }

    // Shield-fence plan: an ACTIVE shield wall in front of the target absorbs
    // the beam (the wall takes the hit; the target behind takes nothing). Only
    // walls closer than the resolved target (or the range, with no target) count.
    const scanDist = hitDist === Infinity ? range : hitDist;
    const wallDist = d.blockBeamAtWall?.(rayFromX, rayFromY, ndx, ndy, scanDist, damage) ?? null;
    if (wallDist === null && hitId) {
      // R2.29 — reverse-square damage falloff over range (server-authoritative).
      const effDamage = falloffMinDamageFrac !== undefined
        ? damage * hitscanFalloffFrac(hitDist, range, falloffMinDamageFrac)
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
      targetId: blocked ? undefined : (hitId ?? undefined),
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
