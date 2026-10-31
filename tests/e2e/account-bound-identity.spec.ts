/**
 * PR 3a (plan sparkling-wondering-rose) — logging into the same account on a
 * different browser finds the SAME player (and therefore the same ships).
 *
 * User report (2026-10-31): "we have accounts and logins and stuff already,
 * that's not linked to ships??" — ships were owned by a per-browser random
 * `eqxPlayerId`, so a second device/browser logged into the same account was
 * a brand-new player with an empty roster.
 *
 * Flow (two fully separate browser profiles, one REAL account — registered via
 * the real /auth/register, NOT the shared e2e fixture login, which is exempt
 * from account binding by design):
 *   1. Browser A (anonymous id A) logs in and joins a galaxy room → its ship is
 *      created for the account.
 *   2. Browser B (a different anonymous id B) logs into the same account → the
 *      app learns the account's player id from /auth/me, and its join lands as
 *      the SAME player: the new ship joins A's roster, nothing is created for B.
 *
 * Run: pnpm e2e --project=chromium tests/e2e/account-bound-identity.spec.ts --reporter=line
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

async function registerAccount(): Promise<string> {
  const email = `acct-${randomUUID().slice(0, 8)}@e2e.test`;
  const res = await fetch(`${SERVER_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123' }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function rosterCount(playerId: string): Promise<number> {
  const res = await fetch(`${SERVER_URL}/dev/player-ships?playerId=${encodeURIComponent(playerId)}`);
  return ((await res.json()) as { ships: unknown[] }).ships.length;
}

async function openLoggedIn(browser: Browser, token: string, anonId: string, testId: string) {
  // Explicit empty storageState — do NOT inherit the shared e2e fixture login.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await ctx.addInitScript(([t, pid]) => {
    localStorage.setItem('eqxAuthToken', t as string);
    localStorage.setItem('eqxPlayerId', pid as string);
  }, [token, anonId]);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=galaxy-test&worker=0&testId=${testId}`);
  await page.waitForFunction(
    () => parseInt(
      document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0',
      10,
    ) > 0,
    { timeout: 20_000 },
  );
  return { ctx, page };
}

async function rosterShipIds(playerId: string): Promise<string[]> {
  const res = await fetch(`${SERVER_URL}/dev/player-ships?playerId=${encodeURIComponent(playerId)}`);
  return ((await res.json()) as { ships: Array<{ shipId: string }> }).ships.map((s) => s.shipId);
}

test('the same account on a second browser is the same player', async ({ browser }) => {
  // Infrastructure cost only (two browser boots + a lazily-created galaxy-test
  // room + physics worker on a cold server) — no game-time waits.
  test.setTimeout(60_000);
  const token = await registerAccount();
  const anonA = randomUUID();
  const anonB = randomUUID();
  const testId = randomUUID(); // both browsers visit the SAME sector

  const a = await openLoggedIn(browser, token, anonA, testId);
  // First login adopts browser A's id as the account's player id.
  await expect.poll(() => a.page.evaluate(() => localStorage.getItem('eqxAccountPlayerId'))).toBe(anonA);
  await expect.poll(() => rosterCount(anonA)).toBeGreaterThan(0);
  const shipsA = await rosterShipIds(anonA);
  await a.ctx.close();

  const b = await openLoggedIn(browser, token, anonB, testId);
  try {
    // Browser B learns the ACCOUNT's player id (not its own anonymous one)…
    await expect.poll(() => b.page.evaluate(() => localStorage.getItem('eqxAccountPlayerId'))).toBe(anonA);
    // …and resumes the account's ship: same roster, no new ship anywhere, and
    // nothing at all exists under browser B's own anonymous id. (Before the
    // fix B joined as `anonB` — a stranger with a brand-new ship.)
    expect(await rosterShipIds(anonA)).toEqual(shipsA);
    expect(await rosterCount(anonB)).toBe(0);
  } finally {
    await b.ctx.close();
  }
});
