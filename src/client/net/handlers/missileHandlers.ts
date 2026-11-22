/**
 * Server → client missile events. The pose rides the snapshot's missiles[]
 * slice; these only end a detonated missile and queue its explosion VFX.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { ServerMessageSchemas } from '@shared-types/messages';
import { holdMissileDetonation } from '../../combat/MissileMirror.js';

/** What the missile handlers touch: the render mirror and the clock. */
export interface MissileHandlerCtx {
  readonly mirror: RenderMirror;
  /** The injected clock's `now()` (ms). */
  now(): number;
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

  // Missile detonated — the drawn missile keeps flying until the missile
  // read point reaches the detonation, then it is removed and its
  // explosion queued for the renderer to drain (VFX + camera shake). With
  // no drone timeline yet, or an unknown missile, that happens at once.
  room.onMessage('missile_detonated', (raw: unknown) => {
    const result = ServerMessageSchemas.missile_detonated.safeParse(raw);
    if (!result.success) return;
    const d = result.data;
    holdMissileDetonation(mirror, d.missileId, d.x, d.y, d.splashRadius, ctx.now());
  });
}
