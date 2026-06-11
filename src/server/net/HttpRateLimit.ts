import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Hand-rolled fixed-window per-key HTTP rate limiter (plan squishy-canyon,
 * finding S2), in the house style of Backpressure.ts / httpCors.ts — no new
 * dependency. Applied per-route in authRouter so the bcrypt login/register
 * endpoints can't be used as a CPU brute-force surface, without throttling
 * cheap routes like /healthz or /diag.
 */

/**
 * Extract a best-effort client IP. Honours the first `x-forwarded-for` hop
 * (the proxy/CDN sets it), falling back to the socket address. Shared with
 * authRouter (was a private helper there, S2 reuse).
 */
export function clientIp(req: Request): string {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

export interface RateLimitOpts {
  /** Window length in ms. */
  windowMs: number;
  /** Max requests permitted per key per window. */
  max: number;
  /** Key extractor; defaults to client IP. */
  keyFn?: (req: Request) => string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Bounded key map — on overflow the soonest-resetting bucket is evicted so
   *  an IP-spoofing flood can't grow the map unbounded. */
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * Create a rate-limit middleware. On overflow it responds `429` with a
 * `Retry-After` header (seconds until the window resets) and does NOT call
 * `next()`. Within budget it calls `next()` untouched.
 */
export function createRateLimiter(opts: RateLimitOpts): RequestHandler {
  const { windowMs, max } = opts;
  const keyFn = opts.keyFn ?? clientIp;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const buckets = new Map<string, Bucket>();

  function evictForRoom(t: number): void {
    // First drop any naturally-expired buckets.
    for (const [k, b] of buckets) {
      if (b.resetAt <= t) buckets.delete(k);
    }
    if (buckets.size < maxKeys) return;
    // Still full of live buckets — evict the soonest-resetting one.
    let victim: string | null = null;
    let soonest = Infinity;
    for (const [k, b] of buckets) {
      if (b.resetAt < soonest) {
        soonest = b.resetAt;
        victim = k;
      }
    }
    if (victim !== null) buckets.delete(victim);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const t = now();
    const key = keyFn(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      if (buckets.size >= maxKeys) evictForRoom(t);
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
      res.header('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}
