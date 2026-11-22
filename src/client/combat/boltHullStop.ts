/**
 * Bolts end at the first hull they cross ON SCREEN (capital fixes S14, owner:
 * "most lasers tunnel very badly").
 *
 * The server sweeps every bolt step and hits thin hulls fine
 * (`ProjectilePipeline.noTunnel.test.ts`). The tunnelling was the drawing: a
 * bolt (`mirror.projectiles`) is extrapolated every frame and only removed
 * when a later snapshot stops listing it, so after the server's hit it kept
 * flying through the drawn hull for one snapshot gap plus latency (a Bolt at
 * 1600 u/s covers 53–80 u per 30/20 Hz snapshot gap, more with latency,
 * against fighter hulls ~20–40 u across); a local ghost bolt flew on through
 * the target until its `hit_ack`.
 *
 * Each frame every moving bolt (authoritative or ghost, never a beam or an
 * event shell) casts its frame step through the SAME ray the local beam uses
 * (`DisplayPoseHitscan`: predWorld bodies, drones / scrap / wrecks at their
 * drawn pose), skipping its shooter. On contact the bolt is dropped from the
 * mirror there; an authoritative id is remembered (`GhostManager.stoppedBolts`) so the next
 * snapshot does not draw it again (`syncProjectiles` skips it and forgets it
 * once the server drops it). Presentation only: the server still decides the
 * hit and the damage.
 *
 * Allocation-free per frame (#14).
 */
import type { ProjectileRenderState } from '@core/contracts/IRenderer';
import type { DisplayPoseHitscan } from './displayPoseHitscan.js';
import type { GhostManager } from './GhostProjectile.js';

/**
 * Advance the authoritative bolts by `dtSec` (ghosts were already advanced by
 * `GhostManager.update`) and end every bolt whose step meets a hull.
 * `hitscan` null (no predWorld yet): the plain straight-line advance.
 */
export function advanceBoltsToHulls(
  projectiles: Map<string, ProjectileRenderState>,
  dtSec: number,
  hitscan: DisplayPoseHitscan | null,
  ghosts: GhostManager,
): void {
  let frameReady = false;
  for (const [id, entry] of projectiles) {
    if (entry.event === true) continue;
    const ghost = entry.isGhost === true;
    const stepX = entry.vx * dtSec;
    const stepY = entry.vy * dtSec;
    // Authoritative bolts step from here; a ghost already moved this frame.
    const fromX = ghost ? entry.x - stepX : entry.x;
    const fromY = ghost ? entry.y - stepY : entry.y;
    const len = Math.hypot(stepX, stepY);
    if (hitscan !== null && entry.beam === undefined && len > 1e-6) {
      if (!frameReady) {
        hitscan.beginBoltFrame();
        frameReady = true;
      }
      const hit = hitscan.boltHit(fromX, fromY, stepX / len, stepY / len, len, entry.ownerId);
      if (hit !== null) {
        projectiles.delete(id);
        if (ghost) ghosts.stop(id);
        else ghosts.stoppedBolts.add(id);
        continue;
      }
    }
    if (!ghost) {
      entry.x += stepX;
      entry.y += stepY;
    }
  }
}
