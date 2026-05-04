/**
 * Process-global registry of active Colyseus sessions.
 *
 * Phase 8 sub-phase B records each `(sessionId → { roomId, playerId, sectorKey })`
 * tuple in `SectorRoom.onJoin` and clears it in `onLeave`. The dev-only
 * `/dev/limbo?playerId=` route uses it for E2E inspection, and a future
 * multi-VM Phase will swap this for a Redis-backed equivalent. It is NOT
 * the source of truth for transit eligibility — the message handler does
 * the `isNeighbour` check locally — it's just a mapping aid.
 *
 * Single-VM by design. Single-process Map; no atomicity guarantees beyond
 * what the V8 event loop already provides (no preemption mid-statement).
 */

export interface SessionInfo {
  roomId: string;
  playerId: string;
  sectorKey: string | null;
}

const sessions = new Map<string, SessionInfo>();

export function setSession(sessionId: string, info: SessionInfo): void {
  sessions.set(sessionId, info);
}

export function getSession(sessionId: string): SessionInfo | undefined {
  return sessions.get(sessionId);
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Test seam — wipe all entries between cases. */
export function _resetForTest(): void {
  sessions.clear();
}
