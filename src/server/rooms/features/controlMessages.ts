/**
 * Flight-control client messages — `input`, `fire`, `respawn` and
 * `client_ready`. Moved verbatim out of `SectorRoom.onCreate`. `input` keeps
 * its own rate cap and parse (`makeInputHandler`); `fire` and `respawn` parse
 * inside the room's handlers, so they register directly.
 */
import type { Client } from 'colyseus';
import type pino from 'pino';
import type { ShipState } from '../schema/SectorState.js';
import { makeInputHandler } from '../InputHandler.js';
import type { MalformedMessageTracker } from '../MalformedMessageTracker.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { ClientReadyMessageSchema } from '../../../shared-types/messages.js';

const MAX_INPUTS_PER_TICK = 3;

/** What the handlers need from the room; getters read the live field. */
export interface ControlMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  inputCountThisTick: Map<string, number>;
  playerToSlot: ReadonlyMap<string, number>;
  boostingPlayers: Set<string>;
  thrustingPlayers: Set<string>;
  postToWorker(cmd: WorkerCmd): void;
  serverTick(): number;
  noteInputMargin(playerId: string, margin: number): void;
  getActiveShip(playerId: string): ShipState | undefined;
  isPilotDisabled(playerId: string): boolean;
  noteWarpRequest(playerId: string, x: number, y: number): void;
  /** The warp route check (`WarpRouteCheck.valid`). */
  validWarpPoint(playerId: string, x: number, y: number): boolean;
  logger: pino.Logger;
  malformed: MalformedMessageTracker;
  handleFire(client: Client, raw: unknown): void;
  handleRespawn(client: Client): void;
  handleClientReady(client: Client): void;
}

export function registerControlMessages(h: ControlMessageHost): RoomFeature {
  h.onMessage('input', makeInputHandler({
    sessionToPlayer: h.sessionToPlayer(),
    inputCountThisTick: h.inputCountThisTick,
    maxInputsPerTick: MAX_INPUTS_PER_TICK,
    playerToSlot: h.playerToSlot,
    boostingPlayers: h.boostingPlayers,
    thrustingPlayers: h.thrustingPlayers,
    postToWorker: (cmd) => h.postToWorker(cmd),
    serverTick: () => h.serverTick(),
    noteInputMargin: (playerId, margin) => h.noteInputMargin(playerId, margin),
    shipEnergyOf: (playerId) => h.getActiveShip(playerId)?.energy,
    isDisabled: (playerId) => h.isPilotDisabled(playerId),
    onWarpRequest: (playerId, x, y) => h.noteWarpRequest(playerId, x, y),
    validWarpPoint: (playerId, x, y) => h.validWarpPoint(playerId, x, y),
    logger: h.logger,
    malformed: h.malformed,
  }));

  h.onMessage('fire', (client: Client, raw: unknown) => {
    h.handleFire(client, raw);
  });

  h.onMessage('respawn', (client: Client) => {
    h.handleRespawn(client);
  });

  // Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
  // Client signals it has finished bootstrapping; server picks an
  // `arrivalTick` and broadcasts `warp_in` to ALL clients (including
  // the joiner) so the curtain drop + warp-in animation fires in
  // sync everywhere. Idempotent — duplicate sends are dropped.
  parsedMessage(h, 'client_ready', ClientReadyMessageSchema, (_msg, client) => {
    h.handleClientReady(client);
  });
  return {};
}
