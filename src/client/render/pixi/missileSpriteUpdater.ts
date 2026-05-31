/**
 * Per-frame missile sprite update. Mirrors `projectileSpriteUpdater.ts`
 * but reads from `mirror.missiles` and applies the **single-pose seam**
 * `resolveMissileDisplayPose` from MissileMirror.ts (one-pose-per-frame
 * rule — see src/client/CLAUDE.md "drone snapshot interpolation" for
 * the canonical pattern this mirrors).
 *
 * Each missile in `mirror.missiles` gets a sprite the first time we see
 * its id; sprites missing from this frame's map are destroyed.
 *
 * Also drains `mirror.pendingMissileExplosions` and spawns short-lived
 * explosion sprites at each detonation point.
 */

import type { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { resolveMissileDisplayPose } from '../../combat/MissileMirror.js';
import { buildMissileGfx, buildMissileExplosionGfx } from './spriteBuilders.js';

export interface MissileSpriteCtx {
  shipContainer: Container;
  missileSprites: Map<number, Graphics>;
  /** Reused per-frame seen set — avoids per-frame allocation. */
  missileSeenScratch: Set<number>;
  /** Active explosion sprites with their spawn-time + max-life. */
  activeExplosions: Array<{ g: Graphics; spawnMs: number; lifeMs: number }>;
}

const EXPLOSION_LIFE_MS = 400;

export function updateMissileSprites(
  mirror: RenderMirror,
  ctx: MissileSpriteCtx,
  nowMs: number,
): void {
  // 1. Update existing missile sprites + spawn new ones.
  if (mirror.missiles) {
    const seen = ctx.missileSeenScratch;
    seen.clear();
    for (const [id] of mirror.missiles) {
      seen.add(id);
      // Single-pose-per-frame resolution — every consumer reads through
      // resolveMissileDisplayPose at this frame's `nowMs`.
      const pose = resolveMissileDisplayPose(mirror, id, nowMs);
      if (!pose) continue;
      let g = ctx.missileSprites.get(id);
      if (!g) {
        g = buildMissileGfx();
        ctx.shipContainer.addChild(g);
        ctx.missileSprites.set(id, g);
      }
      g.x = pose.x;
      g.y = -pose.y; // Pixi Y-flip (game space is Y-up)
      // Pixi-up: angle 0 → forward (-y). Sprite is drawn pointing up
      // (-y) at rotation 0, so we map game-angle directly with sign-flip
      // for the Y axis.
      g.rotation = -pose.angle;
      // Fade slightly near end-of-life (lifePct < 0.15) so a missile
      // about to expire reads as fading rather than disappearing.
      g.alpha = pose.lifePct < 0.15 ? Math.max(0.3, pose.lifePct / 0.15) : 1;
    }
    // Reap sprites for missiles that left the mirror.
    for (const [id, g] of ctx.missileSprites) {
      if (!seen.has(id)) {
        ctx.shipContainer.removeChild(g);
        g.destroy();
        ctx.missileSprites.delete(id);
      }
    }
  }

  // 2. Drain pending explosions — one sprite per detonation.
  // Plan combat-fx-hunt (2026-05-31): clearing the array here was
  // INSUFFICIENT in worker-renderer mode. Each RENDER message clones
  // the mirror via structured-clone; clearing the clone's array left
  // the MAIN THREAD's `pendingMissileExplosions` populated, so the
  // next frame re-shipped + re-spawned the same explosion sprites,
  // stacking forever. Clearing now lives in `consumeOneFrameTriggers`
  // (called on the main-thread mirror per gameRafLoop frame, gated on
  // `shouldRender` for the worker-skip-frame contract). This loop
  // ONLY reads the events; clearing is the caller's job.
  const explosions = mirror.pendingMissileExplosions;
  if (explosions && explosions.length > 0) {
    for (const evt of explosions) {
      const g = buildMissileExplosionGfx();
      g.x = evt.x;
      g.y = -evt.y;
      // Scale to splash radius. The base sprite reads as ~36u outer; we
      // scale so the visible explosion roughly matches the damage zone.
      g.scale.set(evt.splashRadius / 36);
      ctx.shipContainer.addChild(g);
      ctx.activeExplosions.push({ g, spawnMs: nowMs, lifeMs: EXPLOSION_LIFE_MS });
    }
    // DELIBERATELY NOT clearing `explosions.length = 0` here — that was
    // the worker-mode bug. Caller (gameRafLoop via consumeOneFrameTriggers)
    // owns the clear on the main-thread mirror.
  }

  // 3. Advance + reap active explosions (fade out over EXPLOSION_LIFE_MS).
  let writeIdx = 0;
  for (let i = 0; i < ctx.activeExplosions.length; i++) {
    const e = ctx.activeExplosions[i]!;
    const t = (nowMs - e.spawnMs) / e.lifeMs;
    if (t >= 1) {
      ctx.shipContainer.removeChild(e.g);
      e.g.destroy();
      continue;
    }
    e.g.alpha = 1 - t;
    // Gentle scale-up so the explosion expands as it fades.
    const baseScale = e.g.scale.x; // captured at spawn
    void baseScale;
    if (i !== writeIdx) ctx.activeExplosions[writeIdx] = e;
    writeIdx++;
  }
  ctx.activeExplosions.length = writeIdx;
}
