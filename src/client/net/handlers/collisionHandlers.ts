/**
 * Server → client `collision_resolved`: the server's post-collision
 * velocities go straight into predWorld, and a raised shield shows the
 * contact. zod-validated (#3). Allocates nothing new per message (#14).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { PhysicsWorld } from '@core/physics/World';
import { CollisionResolvedMessageSchema } from '@shared-types/messages';
import { applyCollisionResolved, type CollisionGuardState } from '../applyCollisionResolved';
import { pushCollisionShieldContacts } from '../collisionShieldContacts';
import type { PredictionStats } from '../predictionStats.js';

/** What the collision handler touches on the client. */
export interface CollisionHandlerCtx {
  readonly mirror: RenderMirror;
  /** The injected clock's `now()` (ms). */
  now(): number;
  predWorld(): PhysicsWorld | null;
  readonly collisionGuard: CollisionGuardState;
  readonly stats: Pick<PredictionStats, 'collisionEventsApplied'>;
  readonly shieldContactAt: Map<string, number>;
}

export function registerCollisionHandlers(room: Room, ctx: CollisionHandlerCtx): void {
  // Stage 2 of the network-feel roadmap — server-broadcast collision
  // events. Apply post-collision velocities to predWorld immediately;
  // eliminates the ~50 ms snapshot wait for the same correction.
  // Defensive zod parse on receive: malformed payloads dropped silently
  // (mirrors the server's invariant on inbound messages).
  room.onMessage('collision_resolved', (raw: unknown) => {
    const result = CollisionResolvedMessageSchema.safeParse(raw);
    if (!result.success) return;
    const predWorld = ctx.predWorld();
    if (!predWorld) return;
    const outcome = applyCollisionResolved(
      result.data,
      predWorld,
      ctx.collisionGuard,
      ctx.now(),
    );
    if (outcome.applied.length > 0) {
      ctx.stats.collisionEventsApplied++;
    }
    // A raised shield shows the contact, like a shot's hit (user 2026-11-07).
    if (ctx.mirror.pendingEffectTriggers) {
      pushCollisionShieldContacts(result.data, ctx.mirror, ctx.now(), ctx.shieldContactAt, ctx.mirror.pendingEffectTriggers);
    }
  });
}
