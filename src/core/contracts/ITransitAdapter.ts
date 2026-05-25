/**
 * Inter-sector transit adapter surface. The existing pure transit
 * orchestrator lives at `src/server/transit/TransitOrchestrator.ts`
 * (server-only state machine for player warp). This contract is the
 * THIN ADAPTER layer that both the server `SectorRoom` and the client
 * `WarpClientOrchestrator` implement to bind transit lifecycle into
 * their respective zones.
 *
 * Naming: the server-side concretion is `SectorTransitAdapter` (NOT
 * `TransitOrchestrator` — that name is already taken by the existing
 * pure module under `src/server/transit/`). The client-side concretion
 * is `WarpClientOrchestrator`.
 *
 * Both impls delegate the real transit state-machine work to the
 * existing `src/core/transit/TransitStateMachine.ts` + (server-side)
 * the existing `src/server/transit/TransitOrchestrator.ts`.
 *
 * Today (pre-refactor) the transit hooks are inline in `SectorRoom.ts`
 * (server) and `ColyseusClient.ts` (client). Commit 23 (server) and
 * commit 19 (client) of the god-file refactor extract them.
 */

export type TransitState =
  | 'DOCKED'
  | 'SPOOLING'
  | 'IN_TRANSIT'
  | 'ARRIVED';

export interface BeginTransitRequest {
  readonly playerId: string;
  readonly targetSectorKey: string;
  /** Optional seat reservation token from a prior galaxy-map pick. */
  readonly seatReservationToken?: string;
}

export interface ITransitAdapter {
  /** Begin a transit; transitions DOCKED → SPOOLING for the player. */
  beginTransit(req: BeginTransitRequest): void;
  /**
   * Notify the adapter that the player has arrived in the target sector
   * (server: post-`onJoin` of the new room; client: post-seat-reservation
   * consumption). Transitions IN_TRANSIT → ARRIVED.
   */
  onArrival(playerId: string): void;
  /** Read the current transit state for a player. */
  state(playerId: string): TransitState;
}
