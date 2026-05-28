/**
 * Server → client (broadcast): a major GC pause occurred on the server.
 *
 * Mirror of the `GcMonitor.ts` server-side `gc_pause` log event.
 * Echoed to all clients in the room so the on-device dev overlay can
 * surface server GC health alongside its own browser longtask stats
 * (paradigm plan: quirky-rabbit, Phase 6).
 *
 * Discrete + low-frequency (only fires on GCs above the
 * `GC_PAUSE_THRESHOLD_MS = 5` ms threshold — typically 0-10/minute in
 * production). Interface-only (no zod) — server→client events are not
 * in the inbound `ClientMessageSchema`.
 *
 * Wire shape mirrors the `GcMonitor.serverLogEvent('gc_pause', ...)`
 * payload so a server-side log analyser and a client-side overlay
 * agree on field names.
 */
export interface GcPauseEventMessage {
  type: 'gc_pause';
  /** Pause duration in ms, rounded to 3 decimals. */
  durationMs: number;
  /** V8 GC kind label — 'scavenge', 'mark-sweep-compact', 'incremental',
   *  'weakcb', or 'mixed:<bits>'. The DevOverlay typically filters on
   *  MSC because Scavenge pauses are <1 ms and not interesting. */
  kind: string;
}
