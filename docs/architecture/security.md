# EQX Peri — Security Architecture

This document is the threat-model + control reference for the HTTP / bootstrap /
auth layer. It accompanies the security-hardening workstream of the
`squishy-canyon` remediation plan
([docs/plans/health-security-remediation-squishy-canyon.md](../plans/health-security-remediation-squishy-canyon.md)).
The netcode boundary (zod-strict `onMessage`, parameterized SQL, fixed-timestep)
is covered by the Cross-Phase Invariants in the root `CLAUDE.md`; this file
covers what the netcode-focused apparatus never did.

## The zod-strict boundary (pre-existing, healthy)

Every inbound Colyseus message has a `.strict()` zod schema in
`src/shared-types/`; malformed packets are `safeParse`-dropped before reaching
game logic (root invariant #3). All SQL is parameterized via `db.prepare()`
with `?` placeholders — there is no template-literal SQL anywhere. These are
load-bearing and must not regress.

## Controls added by the `squishy-canyon` Workstream A

| ID | Control | Where |
|----|---------|-------|
| S1 | **CORS origin allowlist.** `Access-Control-Allow-Origin: *` replaced by an allowlist driven by `ALLOWED_ORIGINS` (comma-separated). Non-production defaults to `http://localhost:5173`; production defaults to **closed** (no cross-origin browser access) unless configured. | `src/server/net/httpCors.ts` |
| S2 | **Auth rate limiting.** Per-IP fixed-window limiter on the bcrypt endpoints: login+register **10/min/IP** (combined), `/auth/google*` + `/auth/exchange` **30/min/IP**. 429 + `Retry-After`. Cheap routes (`/healthz`, `/diag`) are not limited. | `src/server/net/HttpRateLimit.ts`, applied in `authRouter` |
| S3 | **OAuth one-time code exchange.** The callback no longer puts the JWT in the redirect URL. It stashes `{ token, user }` under a single-use 60 s code and redirects `/?authCode=<code>`; the SPA POSTs the code to `/auth/exchange` to pick up the token. | `src/server/auth/authCodeStore.ts`, `src/client/auth/authApi.ts` |
| S4 | **Stateless HMAC CSRF state.** The in-memory `oauthStates` Map (raced, lost on restart, broke multi-instance) replaced by a signed token `nonce.timestamp.HMAC(secret, payload)` verified by signature + 10-min TTL with no server storage. | `src/server/auth/oauthState.ts` |
| S5 | **Inbound payload bounds.** All inbound wire string ids (`clientShotId`, `targetSectorKey`, `slotId`, `shipId`, `remove_structure.id`, `select_entity.id`, `hit_ack.clientShotId`) bounded `.min(1).max(64)`. The testMode seed arrays (`dronePoses`, `scenarioDrones`, …) — which ride **onCreate** options, not join options — are bounded to ≤ 64 entries at room creation. | `src/shared-types/messages/*`, `src/server/rooms/roomSeedBounds.ts` |
| S6 | **Test/engineering rooms gated out of production.** The 20 non-galaxy rooms (testMode overrides, load/burn knobs) register only when `NODE_ENV !== 'production'` or `EQX_ENABLE_TEST_ROOMS=1`. Galaxy rooms stay unconditional. | `src/server/rooms/testRoomGating.ts`, `src/server/index.ts` |
| S7 | **Security headers.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` on all routes; HSTS in production only. | `src/server/net/httpCors.ts` |
| S8 | **LimboStore entry cap.** Bounded at `LIMBO_MAX_ENTRIES` (10 000); on overflow the earliest-expiring entry is evicted with a sampled warn — an adversarial disconnect burst can't grow the map unbounded. | `src/server/limbo/LimboStore.ts` |
| S9 | **Fail-closed JWT secret.** In production a missing or literal-placeholder `JWT_SECRET` throws at boot — a server that would mint forgeable sessions does not start. Dev keeps the zero-config fallback. | `src/server/auth/jwt.ts` |

## Recorded non-goals / trade-offs

- **WS-upgrade origin check.** The CORS allowlist covers HTTP routes; origin-
  checking the Colyseus WebSocket upgrade lives at the transport seam and is
  deferred (a future hardening, not closed here).
- **CSP.** The express server is API/WS-only (no `express.static`), so a Content-
  Security-Policy belongs to the client-hosting layer, not here.
- **OAuth state single-use.** The HMAC state (S4) is not strictly single-use
  within its 10-min TTL. Acceptable for a short-lived CSRF nonce an attacker
  cannot forge; the alternative (a TTL-pruned replay set) reintroduces the
  per-instance state S4 removed.
- **Auth-code / Limbo stores are per-process.** Single-use codes (S3) are
  redeemed within ms on the same instance; a multi-VM deployment would swap
  both for a shared store keyed identically.

## Environment variables (security-relevant)

See `.env.example` for the full list. Security-relevant:

- `JWT_SECRET` — **production-required** (S9). `openssl rand -hex 32`.
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist (S1). Production is closed
  without it.
- `EQX_ENABLE_TEST_ROOMS=1` — re-register the test/engineering rooms in a
  production-mode build for a controlled load test (S6). Never in real prod.
- `EQX_ALLOW_DEV_OVERRIDES=1` — E2E-only bypass of testMode JoinOption gating;
  the server warns loudly if it is set in production. Never in real prod.
