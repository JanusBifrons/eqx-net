/**
 * Server → client one-shot impact effects. Accelerators only: each pushes a
 * visual into a render-mirror drain queue; nothing persistent depends on them.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { MineDetonatedSchema } from '@shared-types/mines';
import { ServerMessageSchemas } from '@shared-types/messages';

/** What the impact-effect handlers touch: the render mirror's drain queues. */
export interface ImpactFxHandlerCtx {
  readonly mirror: RenderMirror;
}

export function registerImpactFxHandlers(room: Room, ctx: ImpactFxHandlerCtx): void {
  const mirror = ctx.mirror;

  // A shield fence stopped a bolt or missile: draw the impact on the wall
  // (fence-hit fix). An accelerator only — nothing persistent depends on it.
  room.onMessage('wall_hit', (raw: unknown) => {
    const result = ServerMessageSchemas.wall_hit.safeParse(raw);
    if (!result.success) return;
    mirror.pendingEffectTriggers?.push({ kind: 'wall-hit', worldX: result.data.x, worldY: result.data.y });
  });

  // Mine Layer — a mine went off: the same explosion visual as a missile
  // (an accelerator; the mine leaving room state is the truth).
  room.onMessage('mine_detonated', (raw: unknown) => {
    const result = MineDetonatedSchema.safeParse(raw);
    if (!result.success) return;
    (mirror.pendingMissileExplosions ??= []).push({
      x: result.data.x,
      y: result.data.y,
      splashRadius: result.data.radius,
      missileId: -1,
    });
  });
}
