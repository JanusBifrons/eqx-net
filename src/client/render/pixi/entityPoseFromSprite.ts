/**
 * Pure pose-from-sprite helper — the renderer↔effects seam.
 *
 * Extracted from the inline `getEntityPose` closure in `PixiRenderer.init`
 * (Phase A3 "pure decision/derivation module, Pixi calls stay in the
 * renderer" pattern — sibling of `spriteUpdateDecisions.ts`). The effects
 * subsystem (`EngineEmitter`, `ShieldAura`) polls this each frame to glue
 * trails / auras to the moving entity.
 *
 * CONTRACT: returns a GAME-SPACE pose (Y-up). The Pixi sprite stores
 * `sprite.x = ship.x`, `sprite.y = -ship.y`, `sprite.rotation = -ship.angle`
 * (see `shipSpriteUpdater.ts`), so converting BACK to game space negates BOTH
 * y and rotation. The previous inline closure negated y but NOT rotation —
 * handing the emitter a Pixi-space (negated) angle while its math assumes
 * game space. `sin` is odd, so that flipped the X of the stern offset AND the
 * ejection velocity → exhaust mirrored to the wrong side (the smoke-reported
 * bug). Locked by `entityPoseFromSprite.test.ts`.
 *
 * Mutates + returns the caller's `out` object (reused scratch) so the
 * per-frame poll allocates nothing (Invariant #14). The pose is read
 * synchronously inside the same effects tick and never stored between
 * frames, so a single shared scratch per renderer is safe.
 */

/** The minimal sprite surface this helper reads (decoupled from Pixi for tests). */
export interface SpriteLikePose {
  x: number;
  y: number;
  rotation: number;
}

/** Game-space pose the effects subsystem consumes. `vx`/`vy` are filled by
 *  the renderer from the render mirror (the sprite carries no velocity) and
 *  are left untouched here. */
export interface EntityPose {
  x: number;
  y: number;
  angle: number;
  vx?: number;
  vy?: number;
}

export function entityPoseFromSprite(sprite: SpriteLikePose, out: EntityPose): EntityPose {
  out.x = sprite.x;
  out.y = -sprite.y;
  out.angle = -sprite.rotation;
  return out;
}
