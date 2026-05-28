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

import {
  HITSCAN_RANGE,
  HITSCAN_DAMAGE,
} from '../../core/combat/Weapons.js';
import { DEFAULT_SHIP_KIND, getShipKind, type ShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import { getWeapon, type MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';
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

    // Per-weapon cooldown rate limit (matches PlayerFireResolver). For
    // mixed-mode AI mounts (none today), the first mount's weapon sets
    // the salvo cadence; this matches the existing one-weapon-per-ship
    // assumption further down the function.
    const firstAiWeaponId = slotMounts[0]?.weaponId ?? 'hitscan';
    const firstAiWeaponDef = getWeapon(firstAiWeaponId);
    const lastFireCt = d.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < firstAiWeaponDef.cooldownTicks) return;
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

    // Weapon mode discriminator. AI drones today fire one weapon kind per
    // ship — the first mount's weaponId determines the mode for the whole
    // salvo. (Mixed-mode AI mounts would need a per-mount branch; punt
    // until a kind ships with mixed mounts.) Reuses the same firstAiWeaponDef
    // resolved above for the cooldown gate.

    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      const mount = slotMounts[mIdx]!;
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
      if (firstAiWeaponDef.mode === 'missile') {
        d.spawnServerMissile(
          shooterId,
          rayFromX, rayFromY,
          ndx, ndy,
          firstAiWeaponDef as MissileWeaponDef,
        );
        continue;
      }

      let hitId: string | null = null;
      let hitDist = Infinity;
      for (const [targetId] of d.playerToSlot) {
        const targetShip = d.getActiveShip(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const pose = d.shipPoseCache.get(targetId);
        if (!pose) continue;
        const dist = d.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, pose.x, pose.y, pose.angle);
        if (dist !== null && dist < hitDist) {
          hitDist = dist;
          hitId = targetId;
        }
      }

      if (hitId) {
        d.applyDamage(hitId, shooterId, HITSCAN_DAMAGE);
      }

      const beamEndX = rayFromX + ndx * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
      const beamEndY = rayFromY + ndy * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);

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
