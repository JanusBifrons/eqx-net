/**
 * Server → client diagnostic / session messages that only log or record:
 * `gc_pause` (server GC pauses into the health-stats ring + client diag) and
 * `session_replaced` (the account logged in elsewhere). No client state is
 * touched, so there is no ctx.
 */
import type { Room } from 'colyseus.js';
import type { GcPauseEventMessage } from '@shared-types/messages';
import { recordServerGcPause } from '../../debug/healthStats.js';
import { logEvent } from '../../debug/ClientLogger.js';

export function registerDiagnosticHandlers(room: Room): void {
  // Paradigm plan (quirky-rabbit) Phase 6 — server `gc_pause` events
  // feed the rolling 30 s health stats ring; the publisher pushes
  // the aggregate to Zustand at 1 Hz for the DevOverlay.
  //
  // plan: imperative-taco-r2 — also log to client diag so phone-smoke
  // captures can correlate server gc_pause events with client
  // recv_gap_long events. Without this, the phone capture saw 6
  // recv_gap_long events with ZERO local longtask overlap and we
  // had no direct evidence of the server-side root cause.
  room.onMessage('gc_pause', (evt: GcPauseEventMessage) => {
    recordServerGcPause(evt.durationMs);
    logEvent('gc_pause', { durationMs: evt.durationMs, kind: evt.kind });
  });

  // PR 3a — the same account logged in from another device/tab; the server
  // is about to disconnect this session (it took over the account's
  // playerId). Logged so a capture explains the disconnect; there is no
  // auto-reconnect, so this session simply ends.
  room.onMessage('session_replaced', () => {
    logEvent('session_replaced', {});
  });
}
