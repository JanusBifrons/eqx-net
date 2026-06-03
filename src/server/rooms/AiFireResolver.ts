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
  type MissileWeaponDef,
  type ProjectileWeaponDef,
  type HitscanWeaponDef,
  type WeaponId,
} from '../../core/combat/WeaponCatalogue.js';
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

export class AiFireResolver {
  constructor(private readonly deps: AiFireResolverDeps) {}

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

    // Per-mount weapon resolution (weapons/energy/AI overhaul §1). Each
    // barrel fires its OWN catalogue weapon, with range/damage read off the
    // resolved def — fixing the latent bug where the hitscan branch used the
    // hardcoded HITSCAN_RANGE / HITSCAN_DAMAGE instead of the def (which also
    // meant bolt drones had no projectile path at all).
    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      const mount = slotMounts[mIdx]!;
      const weaponDef = getWeapon(mount.weaponId);
      const mountWorld = d.mountWorldOrigin(self.x, self.y, self.angle, mount);
      const currentMountAngle = droneAngles?.[mIdx] ?? 0;
      const mountFireAngle = fireAngle + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      const rayFromX = mountWorld.x + ndx * 16;
      const rayFromY = mountWorld.y + ndy * 16;

      // Missile fire path: lock-on + spawn via MissileSimulation. No
      // hit resolution at fire time — the simulation owns lifecycle and
      // emits missile_fired (broadcast there, not here).
      if (weaponDef.mode === 'missile') {
        d.spawnServerMissile(
          shooterId,
          rayFromX, rayFromY,
          ndx, ndy,
          weaponDef as MissileWeaponDef,
        );
        continue;
      }

      // Projectile (bolt) fire path: spawn a server projectile that rides the
      // snapshot projectiles[] slice. Like the player path, no laser_fired
      // broadcast and no fire-time hit resolution — the projectile pipeline
      // owns collision. Inherits the drone's own velocity so bolts lead
      // correctly while it strafes.
      if (weaponDef.mode === 'projectile') {
        const projDef = weaponDef as ProjectileWeaponDef;
        d.spawnServerProjectile(
          shooterId,
          rayFromX, rayFromY,
          self.vx + ndx * projDef.speed,
          self.vy + ndy * projDef.speed,
          projDef.damage, projDef.radius, projDef.maxTicks,
          mount.weaponId,
        );
        continue;
      }

      // Hitscan (beam) fire path: instant lag-comp-free hit test against the
      // live player poses; range/damage off the resolved def.
      const hitscanDef = weaponDef as HitscanWeaponDef;
      let hitId: string | null = null;
      let hitDist = Infinity;
      for (const [targetId] of d.playerToSlot) {
        const targetShip = d.getActiveShip(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const pose = d.shipPoseCache.get(targetId);
        if (!pose) continue;
        const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, hitscanDef.range, pose.x, pose.y, pose.angle);
        if (dist !== null && dist < hitDist) {
          hitDist = dist;
          hitId = targetId;
        }
      }

      if (hitId) {
        d.applyDamage(hitId, shooterId, hitscanDef.damage);
      }

      const beamEndX = rayFromX + ndx * (hitDist === Infinity ? hitscanDef.range : hitDist);
      const beamEndY = rayFromY + ndy * (hitDist === Infinity ? hitscanDef.range : hitDist);

      d.broadcast('laser_fired', {
        type: 'laser_fired',
        shooterId: wireShooterId,
        mountId: mount.id,
        fromX: rayFromX,
        fromY: rayFromY,
        toX: beamEndX,
        toY: beamEndY,
        hit: !!hitId,
        targetId: hitId ?? undefined,
      });
    }
  }
}
