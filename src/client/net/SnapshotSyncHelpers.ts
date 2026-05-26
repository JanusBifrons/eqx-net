/**
 * Per-snapshot mirror sync helpers — projectiles + wrecks.
 *
 * Both run inside `handleSnapshot` per server snapshot (~20 Hz). They
 * mutate the mirror in place (no allocation per-frame on steady state),
 * preserve client-integrated x/y for projectile bolts (replacing them
 * would snap each bolt ~50 ms backward against its travel direction),
 * and lazily spawn predWorld bodies for wrecks so the local player's
 * predicted ship collides with them.
 *
 * Extracted from ColyseusClient (commit 16 partial).
 */

import type { SnapshotMessage } from '@shared-types/messages';
import type { RenderMirror, ProjectileRenderState } from '@core/contracts/IRenderer';
import type { PhysicsWorld } from '@core/physics/World';

// Use RenderMirror directly — `projectiles` is optional on the
// contract, and the function early-returns when missing.

/**
 * Stage 3 projectile sync. Existing projectile entries keep their
 * client-integrated x/y (avoids the 20 Hz stutter); vx/vy + identity
 * fields refresh authoritatively. Ghost-marked entries are preserved
 * (the GhostManager owns their lifecycle). Server-side projectiles
 * that disappear from the snapshot are deleted from the mirror.
 *
 * Probe 8 (2026-05-24) — mutate-in-place pattern: new entries get a
 * fresh ProjectileRenderState once, subsequent updates mutate the
 * existing object. Saves allocations during sustained projectile flight.
 */
export function syncProjectiles(
  mirror: RenderMirror,
  projectiles: SnapshotMessage['projectiles'],
): void {
  if (!mirror.projectiles) return;
  const seen = new Set<string>();
  if (projectiles) {
    for (const p of projectiles) {
      seen.add(p.id);
      const prev = mirror.projectiles.get(p.id);
      const isNew = !prev || prev.isGhost;
      if (isNew) {
        mirror.projectiles.set(p.id, {
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          ownerId: p.ownerId,
          isGhost: false,
          weaponId: p.weaponId,
        } satisfies ProjectileRenderState);
      } else {
        prev.vx = p.vx;
        prev.vy = p.vy;
        prev.ownerId = p.ownerId;
        prev.isGhost = false;
        prev.weaponId = p.weaponId;
      }
    }
  }
  for (const [id, entry] of mirror.projectiles) {
    if (entry.isGhost) continue;
    if (!seen.has(id)) mirror.projectiles.delete(id);
  }
}

/**
 * Phase 4 wreck pose sync. Identity (kind, health) flows over the
 * Colyseus schema diff (see `syncMirror`); this keeps x/y/vx/vy/angle
 * fresh per frame so the renderer can draw the drifting hull, AND
 * mirrors that pose into a `wreck-${shipInstanceId}` predWorld body
 * so the local player's predicted ship collides with the wreck.
 */
export function syncWreckPoses(
  mirror: RenderMirror,
  wrecks: SnapshotMessage['wrecks'],
  predWorld: PhysicsWorld | null,
  predWreckIds: Set<string>,
): void {
  if (!mirror.wrecks) return;
  if (!wrecks) return;
  for (const w of wrecks) {
    const entry = mirror.wrecks.get(w.id);
    if (!entry) continue;
    entry.x = w.x;
    entry.y = w.y;
    entry.vx = w.vx;
    entry.vy = w.vy;
    entry.angle = w.angle;
    entry.angvel = w.angvel;

    if (predWorld) {
      const bodyId = `wreck-${w.id}`;
      if (!predWorld.hasShip(bodyId)) {
        predWorld.spawnShip(bodyId, w.x, w.y, entry.kind);
        predWreckIds.add(bodyId);
      }
      predWorld.setShipState(bodyId, {
        x: w.x, y: w.y, angle: w.angle,
        vx: w.vx, vy: w.vy,
        angvel: w.angvel,
      });
    }
  }
}
