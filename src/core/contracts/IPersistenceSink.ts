/**
 * Persistence surface (Phase 7). The core zone declares this contract; the
 * server zone supplies the concretion. Two priority lanes:
 *   - CRITICAL: durable, ordered, drained on graceful shutdown.
 *   - VOLATILE: telemetry, may be dropped under memory pressure.
 *
 * `enqueueCriticalAwaitable` exists for the rare caller that must observe the
 * row landing before responding (auth `register` returning a userId).
 *
 * Pure types only — no runtime imports — so `src/core` keeps the boundary
 * invariant against `node:sqlite` and any persistence concretion.
 */
export type PersistOp =
  | { type: 'KILL'; killerUserId: string | null; victimUserId: string | null; weapon: string; sectorId: string; ts: number }
  | { type: 'GAME_JOIN'; userId: string | null; playId: string; sectorId: string; ts: number }
  | { type: 'GAME_LEAVE'; playId: string; ts: number }
  | { type: 'LOGIN_EVENT'; email: string; userId: string | null; success: boolean; provider: 'local' | 'google'; ip: string | null; ts: number }
  | { type: 'SNAPSHOT'; sectorId: string; payloadJson: string; ts: number }
  | { type: 'USER_REGISTER'; userId: string; email: string; passwordHash: string | null; displayName: string | null; ts: number }
  | { type: 'USER_PROVIDER'; providerRowId: string; userId: string; provider: 'local' | 'google' | 'e2e'; providerId: string; ignoreConflict?: boolean }
  | { type: 'USER_UPDATE_DISPLAY_NAME'; userId: string; displayName: string; ts: number }
  | { type: 'TELEMETRY_SHED'; entityId: string; sectorId: string; ts: number }
  | { type: 'TELEMETRY_SLEEP'; entityId: string; sleeping: boolean; sectorId: string; ts: number }
  // Phase 2 multi-ship roster. Hot path is the in-memory `PlayerShipStore`;
  // every mutation also enqueues here so a server crash doesn't lose the
  // roster. `PLAYER_SHIP_PUT` is an UPSERT keyed on `shipId` — fields cover
  // the full `player_ships` row so the worker doesn't need to read-modify.
  | {
      type: 'PLAYER_SHIP_PUT';
      shipId: string;
      playerId: string;
      userId: string | null;
      kind: string;
      kindVersion: number;
      health: number;
      lastSectorKey: string;
      lastX: number;
      lastY: number;
      lastVx: number;
      lastVy: number;
      lastAngle: number;
      lastAngvel: number;
      lastFireClientTick: number;
      isActive: boolean;
      activeRoomId: string | null;
      expiresAt: number;
      ts: number;
    }
  | { type: 'PLAYER_SHIP_DELETE'; shipId: string; ts: number }
  // Director-state persistence (Phase 5). The process-global LivingWorldDirector
  // shadows its abstract squad continuity (per-squad {sectorKey,target,state} +
  // wave bookkeeping) here so a server restart resumes the living world where it
  // left off instead of re-seeding from scratch. Single UPSERT row (id=1).
  // `payloadJson` is JSON.stringify'd DirectorStatePayload. Boot hydration reads
  // via the read-only main-thread connection, never through the worker.
  | { type: 'DIRECTOR_STATE_PUT'; payloadJson: string; ts: number }
  // Web Push subscriptions (PWA notifications). `PUT` is an UPSERT keyed on the
  // unique `endpoint`; `DELETE` prunes an endpoint the push service reported as
  // gone (HTTP 404/410). The hot path is a per-user read via the read-only
  // main-thread connection; only mutations go through the worker writer.
  | { type: 'PUSH_SUBSCRIPTION_PUT'; subscriptionId: string; userId: string; endpoint: string; p256dh: string; auth: string; ts: number }
  | { type: 'PUSH_SUBSCRIPTION_DELETE'; endpoint: string; ts: number };

export type PersistOpType = PersistOp['type'];

export interface IPersistenceSink {
  enqueueCritical(op: PersistOp): void;
  enqueueVolatile(op: PersistOp): void;
  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }>;
  shutdown(opts: { timeoutMs: number }): Promise<{ drained: number }>;
}
