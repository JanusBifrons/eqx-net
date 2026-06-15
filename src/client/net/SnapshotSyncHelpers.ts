/**
 * Per-snapshot mirror sync helper — projectiles.
 *
 * Runs inside `handleSnapshot` per server snapshot (~20 Hz). Mutates the
 * mirror in place (no allocation per-frame on steady state) and
 * preserves client-integrated x/y for projectile bolts (replacing them
 * would snap each bolt ~50 ms backward against its travel direction).
 *
 * Extracted from ColyseusClient (commit 16 partial).
 */

import type { SnapshotMessage } from '@shared-types/messages';
import type { RenderMirror, ProjectileRenderState } from '@core/contracts/IRenderer';

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
 *
 * Phase 4 (plan: quirky-rabbit) — `seenScratch` is caller-injected so
 * this pure helper doesn't allocate per snapshot. ColyseusClient owns
 * the field; this function clears it at the head, populates, and reads
 * back for the cleanup loop. Pure-function-preservation: same inputs →
 * same return value (void); only the injected scratch is mutated.
 */
export function syncProjectiles(
  mirror: RenderMirror,
  projectiles: SnapshotMessage['projectiles'],
  seenScratch: Set<string>,
): void {
  if (!mirror.projectiles) return;
  const seen = seenScratch;
  seen.clear();
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
