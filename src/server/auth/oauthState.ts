import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Stateless, signed OAuth CSRF state (plan squishy-canyon, finding S4).
 *
 * Replaces the in-memory `oauthStates` Map (which raced, was lost on restart,
 * and broke under multi-instance) with a self-validating token:
 *   `nonce.timestamp.HMAC_sha256(secret, "nonce.timestamp")`
 * The callback verifies the signature + TTL with no server-side storage, so it
 * survives restarts and works across instances.
 *
 * Trade-off (recorded in docs/architecture/security.md): a signed nonce is not
 * strictly single-use within its TTL. Acceptable for a 10-minute CSRF nonce —
 * the secret is server-only so an attacker cannot forge one, and the short TTL
 * bounds any replay window.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Tolerance for clock skew on the future-dated guard. */
const FUTURE_SKEW_MS = 60_000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Mint a signed state token bound to `now`. */
export function createOAuthState(secret: string, now: number = Date.now()): string {
  const payload = `${randomUUID()}.${now.toString()}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Verify signature + TTL. Returns true only for an untampered, unexpired token. */
export function verifyOAuthState(
  state: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  const lastDot = state.lastIndexOf('.');
  if (lastDot <= 0) return false;
  const payload = state.slice(0, lastDot);
  const sig = state.slice(lastDot + 1);
  const expected = sign(payload, secret);

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return false;

  const ts = Number(payload.slice(payload.indexOf('.') + 1));
  if (!Number.isFinite(ts)) return false;
  if (now - ts > OAUTH_STATE_TTL_MS) return false; // expired
  if (ts > now + FUTURE_SKEW_MS) return false; // implausibly future-dated
  return true;
}
