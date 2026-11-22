/**
 * Server → client one-shot impact effects. Accelerators only: each pushes a
 * visual into a render-mirror drain queue; nothing persistent depends on them.
 * Those whose partner is drawn in the past wait for it (off-pilot event
 * timing, slice 4b; docs/architecture/shell-events.md).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { MineDetonatedSchema } from '@shared-types/mines';
import { ServerMessageSchemas } from '@shared-types/messages';
import { holdMissileWallHit } from '../../combat/MissileMirror.js';
import { pushWallHit } from '../../combat/missileWallHits.js';
import { pushBlastExplosion } from './shellHandlers.js';

/** What the impact-effect handlers touch: the render mirror's drain queues,
 *  the clock and the held-hit list. */
export interface ImpactFxHandlerCtx {
  readonly mirror: RenderMirror;
  /** The injected clock's `now()` (ms). */
  now(): number;
  /** Hold a blast with the stamped hit held at its point
   *  (`NavalHitHold.holdBlastWithHit`); false: draw it now. */
  readonly holdBlastWithHit: (x: number, y: number, radius: number) => boolean;
}

export function registerImpactFxHandlers(room: Room, ctx: ImpactFxHandlerCtx): void {
  const mirror = ctx.mirror;

  // A shield fence stopped a bolt or missile: draw the impact on the wall
  // (fence-hit fix). An accelerator only — nothing persistent depends on it.
  // A bolt is drawn at the present (snapshot-synced): now. A missile is drawn
  // on the missile delay: the flash waits with its detonation.
  room.onMessage('wall_hit', (raw: unknown) => {
    const result = ServerMessageSchemas.wall_hit.safeParse(raw);
    if (!result.success) return;
    const { x, y, kind } = result.data;
    if (kind === 'missile') holdMissileWallHit(mirror, x, y, ctx.now());
    else pushWallHit(mirror, x, y);
  });

  // Mine Layer — a mine went off: the same explosion visual as a missile
  // (an accelerator; the mine leaving room state is the truth). It waits
  // with its damage hit when that hit waits for a drone-timeline target.
  room.onMessage('mine_detonated', (raw: unknown) => {
    const result = MineDetonatedSchema.safeParse(raw);
    if (!result.success) return;
    const { x, y, radius } = result.data;
    if (!ctx.holdBlastWithHit(x, y, radius)) pushBlastExplosion(mirror, x, y, radius);
  });
}
