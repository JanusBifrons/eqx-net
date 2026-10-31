/**
 * PR 3a — process-global "which session is currently piloting this playerId".
 *
 * Once a playerId belongs to an ACCOUNT, two devices logged into the same
 * account resolve to the SAME playerId. Before, a second session claiming a
 * held id was silently given a brand-new random identity (a stranger with no
 * ships). Now the newest session TAKES OVER: the previous session — in any
 * sector room on this server — is told `session_replaced` and disconnected,
 * then the new join proceeds and rebinds to the player's hull like a normal
 * reconnect.
 *
 * Each room registers the sessions it hosts with an `evict` callback; the
 * callback resolves once the room's `onLeave` for that session has finished,
 * so the new join never races the old session's teardown.
 */
export interface RegisteredSession {
  roomId: string;
  sessionId: string;
  /** Disconnect this session and resolve when its onLeave has completed. */
  evict: () => Promise<void>;
}

const sessions = new Map<string, RegisteredSession>();

/** Upper bound on how long a takeover waits for the old session to leave. */
export const TAKEOVER_TIMEOUT_MS = 3_000;

export function registerPlayerSession(playerId: string, session: RegisteredSession): void {
  sessions.set(playerId, session);
}

/** Remove the registration IF it still belongs to `sessionId` (a takeover may
 *  already have replaced it with the new session). */
export function unregisterPlayerSession(playerId: string, sessionId: string): void {
  const cur = sessions.get(playerId);
  if (cur !== undefined && cur.sessionId === sessionId) sessions.delete(playerId);
}

export function getPlayerSession(playerId: string): RegisteredSession | undefined {
  return sessions.get(playerId);
}

/**
 * Evict whichever session currently holds `playerId` (if any) and wait for it
 * to finish leaving. Bounded by `TAKEOVER_TIMEOUT_MS` so a wedged session can
 * never block a join forever. Returns true when a session was evicted.
 */
export async function takeOverPlayerSession(playerId: string): Promise<boolean> {
  const cur = sessions.get(playerId);
  if (cur === undefined) return false;
  sessions.delete(playerId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cur.evict(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, TAKEOVER_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return true;
}

/** Test seam. */
export function _clearPlayerSessions(): void {
  sessions.clear();
}
