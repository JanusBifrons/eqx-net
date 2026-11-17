/**
 * Unit test for the phone lane's key gate + tunnel-address parsing
 * (`scripts/dev/phone-lane-core.mjs`, used by the `vite.config.ts` gate plugin
 * and the `pnpm phone` CLI). Guide: docs/ops/phone-link.md.
 * Locks: nothing reaches the game without the key (page, API, WS path), the
 * key in the URL sets the cookie, only the home-screen icons are public.
 */
import { describe, it, expect } from 'vitest';
import { gateDecision, keyCookie, newKey, parseTunnelUrl, readCookie, PHONE_COOKIE } from '../../scripts/dev/phone-lane-core.mjs';

const KEY = 'k3y_abc-DEF123';

describe('phone gate', () => {
  it('refuses the page, API, debug and WS paths without the key', () => {
    for (const url of ['/', '/index.html', '/healthz', '/dev/stats', '/diag/capture', '/auth/me', '/abcd/room?sessionId=x', '/manifest.webmanifest', '/sw.js']) {
      expect(gateDecision({ url }, KEY), url).toBe('deny');
    }
  });

  it('passes with the key cookie (among others)', () => {
    expect(gateDecision({ url: '/dev/stats', cookie: `a=1; ${PHONE_COOKIE}=${KEY}; b=2` }, KEY)).toBe('pass');
    expect(gateDecision({ url: '/', cookie: [`x=1`, `${PHONE_COOKIE}=${KEY}`] }, KEY)).toBe('pass');
  });

  it('refuses a wrong, partial or empty key', () => {
    expect(gateDecision({ url: '/', cookie: `${PHONE_COOKIE}=nope` }, KEY)).toBe('deny');
    expect(gateDecision({ url: '/', cookie: `${PHONE_COOKIE}=${KEY.slice(0, -1)}` }, KEY)).toBe('deny');
    expect(gateDecision({ url: `/?k=${KEY}x` }, KEY)).toBe('deny');
    expect(gateDecision({ url: '/?k=' }, KEY)).toBe('deny');
    expect(gateDecision({ url: '/', cookie: `not${PHONE_COOKIE}=${KEY}` }, KEY)).toBe('deny');
  });

  it('the key in the URL passes and asks for the cookie', () => {
    expect(gateDecision({ url: `/?k=${KEY}` }, KEY)).toBe('pass+cookie');
    expect(gateDecision({ url: `/?room=sector&k=${KEY}` }, KEY)).toBe('pass+cookie');
  });

  it('only the home-screen icons are public', () => {
    for (const url of ['/favicon.ico', '/pwa-192x192.png', '/pwa-512x512.png', '/maskable-icon-512x512.png', '/apple-touch-icon-180x180.png']) {
      expect(gateDecision({ url }, KEY), url).toBe('pass');
    }
    expect(gateDecision({ url: '/assets/pwa-192x192.png.js' }, KEY)).toBe('deny');
    expect(gateDecision({ url: '/favicon.ico/../dev/stats' }, KEY)).toBe('deny');
  });

  it('the cookie is secure, http-only and scoped to the whole site', () => {
    const c = keyCookie(KEY);
    expect(c.startsWith(`${PHONE_COOKIE}=${KEY};`)).toBe(true);
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(c).toContain(attr);
    expect(readCookie(`${PHONE_COOKIE}=${KEY}`, PHONE_COOKIE)).toBe(KEY);
  });

  it('keys are long, URL-safe and fresh', () => {
    const a = newKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newKey()).not.toBe(a);
  });
});

describe('tunnel address', () => {
  it('parses the quick-tunnel URL out of cloudflared output', () => {
    const out = [
      '2026-11-17T16:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-11-17T16:00:01Z INF |  https://brave-otter-sample-words.trycloudflare.com                    |',
    ].join('\n');
    expect(parseTunnelUrl(out)).toBe('https://brave-otter-sample-words.trycloudflare.com');
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined();
  });
});
