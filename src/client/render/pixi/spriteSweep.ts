/**
 * The renderer's per-frame sweep of ship / swarm sprites whose entity left the
 * mirror this frame (lifted out of `PixiRenderer.update`).
 */
import type { Container } from 'pixi.js';
import type { DyingHullHold } from './dyingHullHold.js';

/**
 * Remove every sprite in `sprites` whose key is not in `seen`. A capital that
 * died leaving a wreck is handed to `hold` (drawn at its last pose until its
 * wreck pieces are, see `dyingHullHold.ts`); every other sprite is destroyed.
 * `forget(id, held)` drops the renderer's other per-id state (mount cluster,
 * slew, build signature, art handle); `held` says the sprite lives on, so its
 * children (the turret cluster) must stay attached. Alloc-free (#14):
 * deleting the current key while iterating a Map is safe.
 */
export function sweepUnseenSprites(
  sprites: Map<string, Container>,
  seen: ReadonlySet<string>,
  forget: (id: string, held: boolean) => void,
  hold: DyingHullHold | null,
  nowMs: number,
): void {
  for (const [id, sprite] of sprites) {
    if (seen.has(id)) continue;
    sprites.delete(id);
    const held = hold !== null && hold.tryHold(id, sprite, nowMs);
    if (held) {
      forget(id, true);
      continue;
    }
    sprite.parent?.removeChild(sprite);
    forget(id, false);
    sprite.destroy({ children: true });
  }
}
