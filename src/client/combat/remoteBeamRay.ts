/**
 * The client ray for remote STYLED beams (the capital heavy beam) and the
 * shield-ring snap shared with the local beam (weapon-mounts.md "Heavy beam
 * look").
 *
 * A remote heavy beam is drawn from the barrel tip down the turret's LIVE
 * angle and stops at the first thing the ray meets: a shield, a hull, an
 * asteroid, a structure or a wreck. Each frame `updateRemoteBeamDists` traces
 * that ray with the SAME hitscan the local pilot's beam uses
 * (`DisplayPoseHitscan` + `beamShieldEdgeDist`) and writes the length onto
 * the `mirror.remoteLasers` entry (`dist`), which travels to the renderer
 * (main thread or worker) with the rest of the mirror. No live turret angle
 * (the shooter is out of this viewer's interest) ⇒ `dist` is cleared and the
 * renderer aims at the wire end point instead.
 *
 * Kill follow-through: `laser_fired` carries no follow-through flag, so the
 * ray still stops on wreck pieces and scrap like any other hit.
 *
 * Allocation-free per frame (#14): one module scratch ray; the hitscan reuses
 * its own result object.
 */
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import { shipRayHit } from '@core/combat/shipHitShape';
import { beamHalfWidth } from '@core/combat/Weapons';
import { shipShotMuzzle } from '@core/combat/muzzle';
import { getWeapon } from '@core/combat/WeaponCatalogue';
import { getShipKind } from '@shared-types/shipKinds';
import { beamMaxDist } from './beamBands.js';
import type { DisplayPoseHitscan } from './displayPoseHitscan.js';
import { findMount, mountMuzzleRay, remoteBeamStyleForMount, type MuzzleRay } from '../render/beamStyles.js';

/**
 * Snap a beam's end to the drawn SHIELD ring when the ray stops on a
 * shield-up ship (the predWorld collider can lag the shield by a physics
 * step). Returns `hit.dist` for a shield-down hull, an asteroid or a miss of
 * the analytic shape. A wide beam (`halfWidth`) meets the ring grown by its
 * half-width (#15). Pure scalar maths, allocation-free (#14).
 */
export function beamShieldEdgeDist(
  mirror: RenderMirror, hit: { hitId: string; dist: number },
  fromX: number, fromY: number, fwdX: number, fwdY: number,
  maxRange: number, halfWidth: number,
): number {
  const hitId = hit.hitId;
  if (hitId.startsWith('swarm-')) {
    const sw = mirror.swarm?.get(Number(hitId.slice(6)));
    // Drones only (kind===1); asteroids (kind===0) have no shield.
    if (sw && sw.kind === 1 && sw.shieldDown !== true && sw.shipKind) {
      // The shared ship hit shape, as the server resolves it (#15).
      const d = shipRayHit(sw.shipKind, true, fromX, fromY, fwdX, fwdY, maxRange, sw.x, sw.y, sw.angle, halfWidth);
      if (d !== null) return d;
    }
    return hit.dist;
  }
  const ship = mirror.ships.get(hitId);
  if (ship && ship.shieldDown !== true) {
    // The same shape as a drone of that kind (`SectorRoom.playerHitscanDist`, #15).
    const d = shipRayHit(ship.kind ?? null, true, fromX, fromY, fwdX, fwdY, maxRange, ship.x, ship.y, ship.angle, halfWidth);
    if (d !== null) return d;
  }
  return hit.dist;
}

const rayScratch: MuzzleRay = { fromX: 0, fromY: 0, fwdX: 0, fwdY: 0 };

/**
 * Trace every styled remote beam in `mirror.remoteLasers` down its shooter's
 * live barrel and write the stop distance onto the entry (`dist`). The pose,
 * turret angle and muzzle are the ones the renderer draws the beam from
 * (PixiRenderer's remote-laser loop): a player's `mirror.ships` pose and
 * `mountAngles`, an NPC's `mirror.swarm` pose and `displayMountAngles`. The
 * shooter is skipped by its predWorld key (`swarm-<id>` or the ships key).
 */
export function updateRemoteBeamDists(mirror: RenderMirror, hitscan: DisplayPoseHitscan | null): void {
  const lasers = mirror.remoteLasers;
  if (!lasers || lasers.size === 0) return;
  for (const [shooterId, perShooter] of lasers) {
    const ship = mirror.ships.get(shooterId);
    let sw: SwarmRenderState | undefined;
    if (!ship && shooterId.startsWith('swarm-')) {
      const entityId = parseInt(shooterId.slice(6), 10);
      sw = Number.isNaN(entityId) ? undefined : mirror.swarm?.get(entityId);
      if (sw && sw.kind !== 1) sw = undefined;
    }
    const kindId = ship ? (ship.kind ?? null) : (sw?.shipKind ?? null);
    for (const [mountId, laser] of perShooter) {
      laser.dist = undefined;
      if (hitscan === null || (!ship && !sw) || kindId === null) continue;
      const kind = getShipKind(kindId);
      const mount = findMount(kind.mounts, mountId);
      if (!mount || remoteBeamStyleForMount(mount) === null) continue;
      const idx = kind.mounts?.indexOf(mount) ?? -1;
      const mountAngle = ship
        ? (ship.mountAngles?.[idx] ?? 0)
        : (sw!.displayMountAngles ?? sw!.mountAngles)?.[idx];
      if (mountAngle === undefined) continue;
      const pose = ship ?? sw!;
      const r = mountMuzzleRay(pose.x, pose.y, pose.angle, mount, mountAngle, shipShotMuzzle(kind, mount, !ship), rayScratch);
      const wdef = getWeapon(mount.weaponId);
      const maxDist = beamMaxDist(wdef);
      const halfWidth = beamHalfWidth(wdef);
      const hit = hitscan.hitscan(r.fromX, r.fromY, r.fwdX, r.fwdY, maxDist, shooterId, halfWidth);
      laser.dist = hit ? beamShieldEdgeDist(mirror, hit, r.fromX, r.fromY, r.fwdX, r.fwdY, maxDist, halfWidth) : maxDist;
    }
  }
}
