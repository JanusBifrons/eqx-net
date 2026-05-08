/**
 * Client-side application of the server's `collision_resolved` message —
 * Stage 2 of the network-feel roadmap.
 *
 * The server broadcasts post-collision velocities to AOI-filtered clients
 * the instant Rapier resolves a contact above the impulse floor. This
 * function is the client's response: it mirrors `vPost` to the matching
 * bodies in the prediction world, eliminating the ~50 ms wait for the
 * next snapshot's reconciliation to deliver the same correction.
 *
 * Pure function. Two guards prevent misbehaviour:
 *
 * 1. **Stale-event guard.** A snapshot is the authoritative source for a
 *    given server tick. If a `collision_resolved` arrives with a tick
 *    older than the last-applied snapshot's `serverTick`, the snapshot
 *    has already corrected predWorld with the post-collision state — a
 *    late collision event would *un*-correct it. Drop.
 *
 * 2. **Rate limit.** Rapier emits one contact-force event per step that a
 *    contact remains active above the engine threshold. A sustained
 *    grinding contact would generate 60 events/sec; we cap at 4 events
 *    per ship per second on the client side to avoid event-flood-driven
 *    velocity churn. The server applies an impulse-floor filter that
 *    catches most of this; the client rate-limit is belt-and-braces.
 *
 * The actual `setShipState` is mediated by a `MinimalPredWorld` interface
 * so the function can be unit-tested without instantiating Rapier.
 */
import type { CollisionResolvedMessage } from '@shared-types/messages';
import type { ShipPhysicsState } from '@core/physics/World';

/** Subset of `PhysicsWorld` needed to apply collision events. */
export interface MinimalPredWorld {
  hasShip(id: string): boolean;
  getShipState(id: string): ShipPhysicsState | null;
  setShipState(id: string, state: ShipPhysicsState): void;
}

/** Per-client mutable state that lives across `collision_resolved` calls. */
export interface CollisionGuardState {
  /** Latest server tick observed in a snapshot. Updated by the snapshot
   *  handler on every snapshot arrival. Events older than this are dropped. */
  lastSnapshotServerTick: number;
  /** Per-ship-id sliding window of recent event timestamps (ms).
   *  Trimmed lazily as new events come in. */
  recentByShip: Map<string, number[]>;
  /** Window length in milliseconds. */
  rateLimitWindowMs: number;
  /** Max events per ship within the window. */
  rateLimitCount: number;
}

export interface ApplyCollisionResult {
  /** IDs whose state was mutated this call. */
  applied: string[];
  /** Drop reason, or null if the event was processed (even if `applied` is empty
   *  because no participant was in predWorld). */
  dropped: 'stale' | 'rate-limited' | null;
}

export function createCollisionGuard(opts?: {
  rateLimitWindowMs?: number;
  rateLimitCount?: number;
}): CollisionGuardState {
  return {
    lastSnapshotServerTick: 0,
    recentByShip: new Map(),
    rateLimitWindowMs: opts?.rateLimitWindowMs ?? 1000,
    rateLimitCount: opts?.rateLimitCount ?? 4,
  };
}

/**
 * Apply (or drop) a `collision_resolved` message. Mutates `predWorld` and
 * `guard` in place; returns a result describing the outcome for the caller's
 * telemetry / logging.
 */
export function applyCollisionResolved(
  msg: CollisionResolvedMessage,
  predWorld: MinimalPredWorld,
  guard: CollisionGuardState,
  nowMs: number,
): ApplyCollisionResult {
  // Guard 1: stale events.
  if (msg.tick < guard.lastSnapshotServerTick) {
    return { applied: [], dropped: 'stale' };
  }

  // Guard 2: rate limit. Trim each ship's window before the count check, so
  // entries older than the window age out naturally.
  const cutoff = nowMs - guard.rateLimitWindowMs;
  for (const id of [msg.aId, msg.bId]) {
    const recent = guard.recentByShip.get(id) ?? [];
    const fresh = recent.filter((t) => t > cutoff);
    guard.recentByShip.set(id, fresh);
    if (fresh.length >= guard.rateLimitCount) {
      return { applied: [], dropped: 'rate-limited' };
    }
  }

  // Apply.
  const applied: string[] = [];
  for (const [id, vNew] of [
    [msg.aId, msg.vA] as const,
    [msg.bId, msg.vB] as const,
  ]) {
    if (!predWorld.hasShip(id)) continue;
    const cur = predWorld.getShipState(id);
    if (!cur) continue;
    predWorld.setShipState(id, { ...cur, vx: vNew.x, vy: vNew.y });
    applied.push(id);
    const recent = guard.recentByShip.get(id) ?? [];
    recent.push(nowMs);
    guard.recentByShip.set(id, recent);
  }

  return { applied, dropped: null };
}
