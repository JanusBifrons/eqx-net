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
 * Resolved CORS policy. `reflectAny` echoes whatever `Origin` the browser sends
 * (dev/test convenience); otherwise only origins in `allowed` are echoed.
 */
export interface CorsPolicy {
  reflectAny: boolean;
  allowed: Set<string>;
}

/**
 * Resolve the CORS policy (plan squishy-canyon, S1).
 *
 * - `ALLOWED_ORIGINS` (comma-separated) is the explicit allowlist and always
 *   wins, in any environment.
 * - Otherwise, in **non-production** we reflect ANY origin. Dev/test is not a
 *   security boundary, and a hardcoded `localhost:5173` broke every non-5173
 *   dev origin — phones on the LAN (`serverUrl.ts`: `http://192.168.1.5:5173`),
 *   the netcode-health gate's per-arm ports, alternate dev ports. This restores
 *   the old `*` ergonomics for dev WITHOUT weakening production.
 * - In **production** with no list configured we deny all cross-origin browser
 *   reads (empty allowlist, no reflect) — the safe default; opt origins in via
 *   `ALLOWED_ORIGINS`.
 */
export function resolveCorsPolicy(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  const raw = env['ALLOWED_ORIGINS'];
  if (raw && raw.trim().length > 0) {
    return {
      reflectAny: false,
      allowed: new Set(
        raw
          .split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0),
      ),
    };
  }
  return { reflectAny: env['NODE_ENV'] !== 'production', allowed: new Set() };
}

/**
 * CORS middleware. Echoes the request `Origin` (plus `Vary: Origin`) when the
 * policy reflects-any (non-prod) OR the origin is in the explicit allowlist;
 * otherwise emits no `Access-Control-Allow-Origin`, so the browser blocks the
 * cross-origin read.
 *
 * Same-origin and non-browser requests (no `Origin` header) carry no ACAO under
 * the spec and pass through untouched — same-origin `/healthz` polling,
 * server-to-server, and the Playwright global-setup token mint are unaffected.
 */
export function corsMiddleware(policy: CorsPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && (policy.reflectAny || policy.allowed.has(origin))) {
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
