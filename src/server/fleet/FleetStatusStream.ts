/**
 * RTS command layer, slice 7 — the owner-only `fleet_status` stream.
 *
 * Runs on the room's ~5 Hz selection-stats timer and sends every OTHER fire
 * (~2 Hz). Each connected client gets the FULL status of the AI-flown ships
 * its player owns (`FleetCommandSubsystem.statusFor`) plus hull %, the
 * current morale roll, the move-order destination, the patrol route and the
 * escort target, as compact tuples (`shared-types/messages/fleetStatusMessages`).
 *
 * Why a per-owner message, not a snapshot field (root invariant #16): the
 * snapshot is shared by everyone in interest, while a wingman's mode, orders
 * and route are private to its owner. Each send is the whole owned list
 * (client applies it with `replace: true`) on a fixed cadence, so a late
 * joiner or a reconnect converges within one period. The only skipped sends
 * are repeat EMPTY ones (an owner with no wingmen gets one empty list, then
 * nothing until that changes).
 *
 * Off the physics tick (a UI timer), so the per-send tuple allocation is
 * tolerated: it is bounded by the owner's fleet and runs at 2 Hz.
 */
import type { FleetCommandSubsystem, FleetShipStatus } from './FleetCommandSubsystem.js';
import {
  FLEET_STATUS_ACTIVITIES,
  FLEET_STATUS_MODES,
  FLEET_STATUS_ORDERS,
  FLEET_STATUS_STANCES,
  type FleetStatusMessage,
  type FleetStatusTuple,
} from '../../shared-types/messages/fleetStatusMessages.js';

/** Send on every Nth timer fire (5 Hz timer ⇒ ~2.5 Hz). */
export const FLEET_STATUS_EVERY_N_FIRES = 2;

export interface FleetStatusStreamDeps {
  fleet: Pick<FleetCommandSubsystem, 'statusFor' | 'brainOf'>;
  /** Connected clients: call `cb(sessionId, playerId)` once per session. */
  forEachSession(cb: (sessionId: string, playerId: string) => void): void;
  /** Hull 0..100 of `shipId`, or null when unknown. */
  hullPct(shipId: string): number | null;
  send(sessionId: string, msg: FleetStatusMessage): void;
}

export class FleetStatusStream {
  private fires = 0;
  /** Sessions whose last send was an empty list. */
  private readonly lastEmpty = new Set<string>();

  constructor(private readonly deps: FleetStatusStreamDeps) {}

  /** The timer fire. Sends on every {@link FLEET_STATUS_EVERY_N_FIRES}th call. */
  tick(): void {
    this.fires++;
    if (this.fires % FLEET_STATUS_EVERY_N_FIRES !== 0) return;
    this.sendAll();
  }

  /** Send now to every session (tests; also the cadence body). */
  sendAll(): void {
    this.deps.forEachSession((sessionId, playerId) => this.sendTo(sessionId, playerId));
  }

  /** Forget a session (leave / transit). */
  clearSession(sessionId: string): void {
    this.lastEmpty.delete(sessionId);
  }

  private sendTo(sessionId: string, playerId: string): void {
    const rows = this.deps.fleet.statusFor(playerId);
    if (rows.length === 0) {
      if (this.lastEmpty.has(sessionId)) return;
      this.lastEmpty.add(sessionId);
      this.deps.send(sessionId, { type: 'fleet_status', s: [] });
      return;
    }
    this.lastEmpty.delete(sessionId);
    // TODO: alloc-debt — 2 Hz UI timer, bounded by the owner's fleet.
    const s: FleetStatusTuple[] = [];
    for (let i = 0; i < rows.length; i++) s.push(this.encode(rows[i]!));
    this.deps.send(sessionId, { type: 'fleet_status', s });
  }

  private encode(r: FleetShipStatus): FleetStatusTuple {
    const brain = this.deps.fleet.brainOf(r.id);
    const hull = this.deps.hullPct(r.id);
    const order = r.order;
    let route: number[] | null = null;
    if (brain !== null && brain.mode === 'patrol' && brain.patrolRouteLength > 0) {
      route = [];
      for (let i = 0; i < brain.patrolRouteLength; i++) route.push(brain.patrolRouteX(i), brain.patrolRouteY(i));
    }
    const morale = brain?.moraleOutcome ?? null;
    return [
      r.id,
      FLEET_STATUS_MODES.indexOf(r.mode),
      FLEET_STATUS_STANCES.indexOf(r.stance),
      FLEET_STATUS_ACTIVITIES.indexOf(r.activity),
      r.targetId,
      hull === null ? 0 : Math.max(0, Math.min(100, Math.round(hull))),
      morale === null ? -1 : morale,
      r.squadId,
      order === null ? -1 : FLEET_STATUS_ORDERS.indexOf(order.kind),
      order !== null && order.kind === 'move' ? order.x : null,
      order !== null && order.kind === 'move' ? order.y : null,
      brain?.escortId ?? null,
      route,
    ];
  }
}
