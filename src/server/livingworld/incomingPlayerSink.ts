/**
 * Phase-4 P0 — process-global accessor for the PLAYER side of the
 * `IncomingRegistry`. The `LivingWorldDirector` owns the registry; the per-room
 * `TransitOrchestrator` and the destination `SectorRoom` need to feed it inbound
 * PLAYERS (register on spool, clear on arrival/abort) WITHOUT a hard dependency on
 * the director or an `index.ts` import cycle. Mirrors the `getLimboStore()` /
 * `getPlayerShipStore()` singleton-accessor pattern.
 *
 * The sink is null when the Living World is disabled (`EQX_DISABLE_LIVING_WORLD`)
 * or in test harnesses that don't construct a director — every call site
 * null-guards, so a missing sink simply means no player-incoming banner (peaceful
 * building mode), never a crash.
 */
import type { WarpWarningEvent } from '../../shared-types/messages.js';

export interface IncomingPlayerSink {
  registerIncomingPlayer(spec: {
    playerId: string;
    destSectorKey: string;
    sourceSectorKey: string;
    label: string;
    etaMs: number;
  }): void;
  clearIncomingPlayer(playerId: string, destSectorKey: string): void;
  /** Send a pilot who just arrived in `destSectorKey` every warning still
   *  inbound there, with the countdown left (the broadcast only reached the
   *  occupants at the time). Called once per join from `handleClientReady`. */
  replayIncomingTo(destSectorKey: string, send: (msg: WarpWarningEvent) => void): void;
}

let sink: IncomingPlayerSink | null = null;

export function setIncomingPlayerSink(s: IncomingPlayerSink | null): void {
  sink = s;
}

export function getIncomingPlayerSink(): IncomingPlayerSink | null {
  return sink;
}
