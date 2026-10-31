/**
 * PR 3a — server-issued, single-use proof of identity for an inter-sector
 * transit join.
 *
 * A transit arrives at the destination room via a server-side
 * `matchMaker.reserveSeatFor(...)`, so the destination's `onJoin` receives the
 * reservation options (`{ playerId, transitToken, shipId }`) — NOT the client's
 * auth token. Without this registry the destination could not tell a genuine
 * transit from a client that simply joined claiming somebody's playerId, and
 * the "an unauthenticated join may not claim an account-bound id" guard would
 * break every transit of a logged-in player.
 *
 * The source room's `TransitOrchestrator` issues the token at commit; the
 * destination consumes it exactly once. A token is only honoured for the
 * playerId it was issued to, and expires after the seat-reservation window.
 */
const TOKEN_TTL_MS = 30_000;

interface Entry {
  playerId: string;
  expiresAt: number;
}

const tokens = new Map<string, Entry>();

/** Record that `token` authorises a transit join as `playerId`. */
export function issueTransitIdentity(token: string, playerId: string, now: number = Date.now()): void {
  // Opportunistic sweep — transits are rare, so this stays tiny.
  for (const [t, e] of tokens) if (e.expiresAt <= now) tokens.delete(t);
  tokens.set(token, { playerId, expiresAt: now + TOKEN_TTL_MS });
}

/** Consume `token` for `playerId`. True exactly once, only for the issued
 *  player, only before expiry. */
export function consumeTransitIdentity(token: unknown, playerId: unknown, now: number = Date.now()): boolean {
  if (typeof token !== 'string' || typeof playerId !== 'string') return false;
  const e = tokens.get(token);
  if (e === undefined) return false;
  tokens.delete(token);
  return e.playerId === playerId && e.expiresAt > now;
}

/** Test seam. */
export function _clearTransitIdentities(): void {
  tokens.clear();
}
