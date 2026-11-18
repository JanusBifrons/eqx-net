/**
 * Server → client missile events. The pose rides the snapshot's missiles[]
 * slice; these only drop a detonated missile and queue its explosion VFX.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { ServerMessageSchemas } from '@shared-types/messages';
import { removeMissile } from '../../combat/MissileMirror.js';

/** What the missile handlers touch: the render mirror. */
export interface MissileHandlerCtx {
  readonly mirror: RenderMirror;
}

export function registerMissileHandlers(room: Room, ctx: MissileHandlerCtx): void {
  const mirror = ctx.mirror;

  // Missile launched — pose arrives on the snapshot's missiles[]
  // slice (NOT this event), so we don't seed the mirror here.
  // Defensive zod parse on receive. The discrete event currently has
  // no client-side subscriber (SFX launch-whoosh is a future hookup);
  // the parse + drop keeps the wire safe and ready for that hookup.
  room.onMessage('missile_fired', (raw: unknown) => {
    ServerMessageSchemas.missile_fired.safeParse(raw);
  });

  // Missile detonated — remove from the mirror so the sprite stops
  // drawing the next frame, and push an explosion entry into the
  // mirror for the renderer to drain (VFX + camera shake).
  room.onMessage('missile_detonated', (raw: unknown) => {
    const result = ServerMessageSchemas.missile_detonated.safeParse(raw);
    if (!result.success) return;
    removeMissile(mirror, result.data.missileId);
    const list = (mirror.pendingMissileExplosions ??= []);
    list.push({
      x: result.data.x,
      y: result.data.y,
      splashRadius: result.data.splashRadius,
      missileId: result.data.missileId,
    });
  });
}
