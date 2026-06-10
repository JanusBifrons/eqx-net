import type { Request, Response, NextFunction } from 'express';

/**
 * HTTP CORS + security-header middleware, hand-rolled in the house style of
 * `src/server/net/Backpressure.ts` (typed, unit-tested, no new dependency).
 *
 * Replaces the former blanket `Access-Control-Allow-Origin: *` (plan
 * squishy-canyon, finding S1) with an origin allowlist, and adds the baseline
 * security response headers (finding S7). See docs/architecture/security.md.
 *
 * Explicit non-goal: origin-checking the Colyseus WS upgrade — that lives at
 * the transport seam and is recorded as deferred in the security doc.
 */

const CORS_ALLOW_HEADERS = 'Origin, X-Requested-With, Content-Type, Accept, Authorization';
const CORS_ALLOW_METHODS = 'GET, POST, PATCH, OPTIONS';
/** One year, the conventional HSTS max-age once the policy is trusted. */
const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * Resolve the set of browser origins permitted to read cross-origin responses.
 *
 * - `ALLOWED_ORIGINS` (comma-separated) is the explicit allowlist and always
 *   wins when present.
 * - Otherwise, in non-production we default to the Vite dev origin so the local
 *   dev loop works with zero config.
 * - In production with no list configured we return an EMPTY set — the safe
 *   default is "no cross-origin browser access"; an operator opts specific
 *   origins in via `ALLOWED_ORIGINS`.
 */
export function resolveAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const raw = env['ALLOWED_ORIGINS'];
  if (raw && raw.trim().length > 0) {
    return new Set(
      raw
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    );
  }
  if (env['NODE_ENV'] !== 'production') {
    return new Set(['http://localhost:5173']);
  }
  return new Set();
}

/**
 * CORS middleware with an origin allowlist. Echoes the request `Origin` (plus
 * `Vary: Origin`) only when it is in `allowedOrigins`; otherwise emits no
 * `Access-Control-Allow-Origin`, so the browser blocks the cross-origin read.
 *
 * Same-origin and non-browser requests (no `Origin` header) carry no ACAO under
 * the spec and pass through untouched — `/healthz` polling, server-to-server,
 * and the Playwright global-setup token mint are unaffected.
 */
export function corsMiddleware(allowedOrigins: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
      res.header('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    }
    next();
  };
}

/**
 * Baseline security headers (finding S7). `nosniff` + `DENY` framing +
 * `no-referrer` (the last also mitigates residual referrer leakage from the
 * OAuth round-trip, finding S3). HSTS is emitted ONLY in production — sending
 * it over plaintext dev HTTP would pin the browser to https for localhost.
 *
 * CSP is deliberately omitted: this express server is API/WS-only (no
 * `express.static`), so CSP belongs to the client-hosting layer. Recorded as a
 * non-goal in docs/architecture/security.md.
 */
export function securityHeadersMiddleware(
  env: NodeJS.ProcessEnv = process.env,
) {
  const isProd = env['NODE_ENV'] === 'production';
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('Referrer-Policy', 'no-referrer');
    if (isProd) {
      res.header('Strict-Transport-Security', HSTS_VALUE);
    }
    next();
  };
}
