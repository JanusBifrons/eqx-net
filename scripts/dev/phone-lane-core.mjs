/**
 * Phone lane — pure pieces shared by the `vite.config.ts` gate plugin, the
 * `pnpm phone` CLI (scripts/dev/phone-lane.ts) and their unit test
 * (tests/unit/phone-lane.test.ts). Guide: docs/ops/phone-link.md.
 *
 * The phone lane serves a production build through a public Cloudflare quick
 * tunnel. The gate is a shared-secret lock: `?k=<key>` sets a cookie, and every
 * request (page, API, WebSocket upgrade) without that cookie or key is refused
 * before it reaches the game. Only the home-screen icons stay public (an
 * Android install fetches them without cookies).
 * No shebang on purpose (CRLF checkouts break vitest imports).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveSharedClaudeDir } from './heavy-queue-core.mjs';

export const PHONE_COOKIE = 'eqx_phone';
/** Fixed local ports the tunnel points at; owned by the phone lane only. */
export const PHONE_PORTS = Object.freeze({ server: 2590, vite: 8090 });
/** cloudflared's local readiness endpoint (`/ready` → 200 once connected). */
export const TUNNEL_METRICS = '127.0.0.1:20590';

const PUBLIC_PATHS = [/^\/favicon\.ico$/, /^\/(pwa|maskable-icon)-[\w-]+\.png$/, /^\/apple-touch-icon[\w-]*\.png$/];

/** A fresh random key (URL-safe, 144 bits). */
export function newKey() {
  return crypto.randomBytes(18).toString('base64url');
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Value of `name` in a `Cookie:` header, or undefined. */
export function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function keyCookie(key) {
  return `${PHONE_COOKIE}=${key}; Path=/; Max-Age=172800; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Decide one request. Returns `'pass'`, `'pass+cookie'` (carries the key in
 * the URL: set the cookie) or `'deny'`.
 * @param {{ url?: string, cookie?: string | string[] }} req
 * @param {string} key
 */
export function gateDecision(req, key) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (PUBLIC_PATHS.some((re) => re.test(url.pathname))) return 'pass';
  if (same(url.searchParams.get('k') ?? undefined, key)) return 'pass+cookie';
  const header = Array.isArray(req.cookie) ? req.cookie.join('; ') : req.cookie;
  return same(readCookie(header, PHONE_COOKIE), key) ? 'pass' : 'deny';
}

/** The `https://<name>.trycloudflare.com` URL cloudflared prints, or undefined. */
export function parseTunnelUrl(log) {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(log))?.[0];
}

/**
 * The owner's named tunnel (`<phone dir>/named-tunnel.json`, written once when
 * the tunnel was created with `cloudflared tunnel create` + `route dns`), or
 * undefined when the file is absent: the lane then uses a quick tunnel.
 * Throws on a file that is present but incomplete, so a typo never silently
 * falls back to a random address.
 * @param {string | undefined} text the file's contents
 */
export function parseNamedTunnel(text) {
  if (text === undefined) return undefined;
  const cfg = JSON.parse(text);
  for (const k of ['hostname', 'tunnelId', 'credentialsFile']) {
    if (typeof cfg?.[k] !== 'string' || !cfg[k]) throw new Error(`named-tunnel.json: missing "${k}"`);
  }
  if (!/^[a-z0-9.-]+$/i.test(cfg.hostname)) throw new Error(`named-tunnel.json: bad hostname "${cfg.hostname}"`);
  return { hostname: cfg.hostname, tunnelId: cfg.tunnelId, credentialsFile: cfg.credentialsFile };
}

/**
 * cloudflared arguments: a named tunnel (fixed address) when `named` is given,
 * else a quick tunnel (random trycloudflare.com address). Both point at the
 * lane's preview port and expose `/ready` on the metrics address.
 * @param {{ tunnelId: string; credentialsFile: string } | undefined} named
 */
export function tunnelArgs(named) {
  const common = ['tunnel', '--no-autoupdate', '--metrics', TUNNEL_METRICS];
  const origin = `http://localhost:${PHONE_PORTS.vite}`;
  if (!named) return [...common, '--url', origin];
  return [...common, 'run', '--credentials-file', named.credentialsFile, '--url', origin, named.tunnelId];
}

/**
 * Server env for a lane build. `EQX_DIAG_DIR` sends the diagnostic captures
 * (every lane session streams one, with its frame-time `perf_summary` lines)
 * to `<run>/captures/` instead of the served checkout's `diag/captures/`, so a
 * play session's evidence sits next to `server.log` and survives the
 * checkout's worktree being removed.
 * @param {string} runDir
 */
export function laneServerEnv(runDir) {
  return { EQX_ENABLE_TEST_ROOMS: '0', EQX_TEST_SIGNIN: '1', EQX_DIAG_DIR: path.join(runDir, 'captures') };
}

/** `<main checkout>/.claude/phone-lane`, shared by every worktree.
 *  `EQX_PHONE_DIR` overrides. */
export function resolvePhoneDir(cwd = process.cwd(), env = process.env) {
  if (env.EQX_PHONE_DIR) return path.resolve(env.EQX_PHONE_DIR);
  return resolveSharedClaudeDir('phone-lane', cwd);
}
