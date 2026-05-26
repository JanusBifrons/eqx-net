/**
 * Per-frame computation of the sets of ships hit by any active beam.
 *
 * The ship-sprite damage-flash tint is driven by membership in these
 * sets. The multi-mount/turret refactor (Phase 2c) made
 * `mirror.remoteLasers` and `mirror.liveBeams` per-mount maps, so we
 * flatten across all mounts to derive the per-target hit flags.
 *
 *   - `remoteHitTargets` — targets currently hit by OTHER shooters'
 *     beams (read from `mirror.remoteLasers`).
 *   - `localHitTargets`  — targets currently hit by ANY mount on the
 *     local player's ship (read from `mirror.liveBeams`).
 *
 * Both Sets are persistent scratches reused across frames; the
 * caller passes them in via `clearAndFill`.
 */

import type { RenderMirror } from '@core/contracts/IRenderer';

export function fillHitTargetSets(
  mirror: RenderMirror,
  remoteHitTargets: Set<string>,
  localHitTargets: Set<string>,
): void {
  remoteHitTargets.clear();
  if (mirror.remoteLasers) {
    for (const perShooter of mirror.remoteLasers.values()) {
      for (const laser of perShooter.values()) {
        if (laser.targetId) remoteHitTargets.add(laser.targetId);
      }
    }
  }
  localHitTargets.clear();
  if (mirror.liveBeams) {
    for (const beam of mirror.liveBeams.values()) {
      if (beam.hitId) localHitTargets.add(beam.hitId);
    }
  }
}
