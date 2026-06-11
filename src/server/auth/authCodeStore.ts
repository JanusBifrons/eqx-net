import { randomUUID } from 'node:crypto';
import type { AuthUser } from './AuthService.js';

/**
 * One-time auth-code exchange store (plan squishy-canyon, finding S3).
 *
 * The OAuth callback no longer puts the session JWT in the redirect URL (where
 * it leaks into browser history, server logs, and Referer headers). Instead it
 * stashes the `{ token, user }` under a short-lived, single-use random code and
 * redirects `/?authCode=<code>`; the SPA immediately POSTs the code to
 * `/auth/exchange` to swap it for the token over a normal fetch body.
 *
 * In-memory + per-process is sufficient: the redeem happens within ms of issue,
 * same instance (the SPA that received the redirect calls straight back). A
 * 60-s TTL covers handshake jitter. Multi-VM would swap this for a shared store
 * keyed the same way (recorded as a future seam in docs/architecture/security.md).
 */

export const AUTH_CODE_TTL_MS = 60_000;
const DEFAULT_MAX_CODES = 10_000;

export interface AuthCodePayload {
  token: string;
  user: AuthUser;
}

interface CodeEntry {
  payload: AuthCodePayload;
  expiresAt: number;
}

export interface AuthCodeStoreOpts {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
}

export class AuthCodeStore {
  private readonly map = new Map<string, CodeEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(opts: AuthCodeStoreOpts = {}) {
    this.ttlMs = opts.ttlMs ?? AUTH_CODE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_CODES;
  }

  /** Stash a payload, returning a fresh single-use code. */
  issue(payload: AuthCodePayload): string {
    const t = this.now();
    if (this.map.size >= this.maxEntries) this.pruneExpired(t);
    const code = randomUUID();
    this.map.set(code, { payload, expiresAt: t + this.ttlMs });
    return code;
  }

  /** Redeem a code: returns the payload once, then it's gone. `null` for an
   *  unknown, already-redeemed, or expired code. Expired entries are cleared. */
  redeem(code: string): AuthCodePayload | null {
    const entry = this.map.get(code);
    if (!entry) return null;
    this.map.delete(code); // single-use: remove on read regardless of expiry
    if (entry.expiresAt <= this.now()) return null;
    return entry.payload;
  }

  private pruneExpired(t: number): void {
    for (const [code, entry] of this.map) {
      if (entry.expiresAt <= t) this.map.delete(code);
    }
  }
}
