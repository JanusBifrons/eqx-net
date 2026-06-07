import { describe, it, expect } from 'vitest';
import { entityPoseFromSprite, type EntityPose } from './entityPoseFromSprite';

/**
 * Failing-first regression lock at the renderer↔effects SEAM (Invariant #13).
 *
 * The X-mirror smoke bug lives HERE — the pose handed to the engine emitter —
 * NOT inside `EngineEmitter` (its math is correct for whatever angle it is
 * fed; a unit test on the emitter alone PASSES today = the "wrong-level
 * trap"). The Pixi sprite stores `rotation = -gameAngle`, so the game-space
 * pose must NEGATE it back. The buggy inline closure returned `sprite.rotation`
 * (still Pixi-space), which `sin`'s odd symmetry turned into a left/right
 * mirror of the exhaust.
 */
describe('entityPoseFromSprite', () => {
  const fresh = (): EntityPose => ({ x: 0, y: 0, angle: 0 });

  it('negates Pixi sprite.rotation back to a game-space angle', () => {
    // Ship facing game-space +π/4 → sprite.rotation = -π/4.
    const out = entityPoseFromSprite({ x: 5, y: 7, rotation: -Math.PI / 4 }, fresh());
    expect(out.angle).toBeCloseTo(Math.PI / 4, 10);
  });

  it('un-flips Y (game space is Y-up; Pixi sprite.y = -gameY)', () => {
    const out = entityPoseFromSprite({ x: 5, y: 7, rotation: 0 }, fresh());
    expect(out.x).toBe(5);
    expect(out.y).toBe(-7);
  });

  it('round-trips an arbitrary game pose through the sprite convention', () => {
    // Emulate shipSpriteUpdater: gameAngle θ, gameY h → sprite{rotation:-θ, y:-h}.
    const gameAngle = 1.2;
    const gameY = 42;
    const out = entityPoseFromSprite({ x: -3, y: -gameY, rotation: -gameAngle }, fresh());
    expect(out.x).toBe(-3);
    expect(out.y).toBe(gameY);
    expect(out.angle).toBeCloseTo(gameAngle, 10);
  });

  it('mutates and returns the SAME out object (reused scratch, no per-call alloc)', () => {
    const out = fresh();
    const ret = entityPoseFromSprite({ x: 1, y: 2, rotation: 3 }, out);
    expect(ret).toBe(out);
  });
});
