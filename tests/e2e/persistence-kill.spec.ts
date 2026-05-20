/**
 * Phase 7 acceptance E2E: a kill recorded in combat lands in `player_kills`,
 * queryable via the dev `/dev/stats` endpoint.
 *
 * Flow:
 *   1. Mint two distinct test users via `/auth/dev/test-token?email=...`.
 *   2. Open two browser contexts, inject each user's JWT into localStorage.
 *   3. Spawn the killer at (0,0) and the victim at (60,0) — within hitscan
 *      range and inside each other's interest grid window.
 *   4. Killer holds Space while sweeping rotation; victim takes hits until
 *      hull <= 0 and ship is destroyed.
 *   5. Wait ~250 ms (covers the 50 ms WAB flush + worker IPC latency).
 *   6. GET /dev/stats?email=victim → assert deaths >= 1.
 *      GET /dev/stats?email=killer → assert kills >= 1.
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/persistence-kill.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

interface TestTokenResponse {
  token: string;
  user: { id: string; email: string };
}

async function mintToken(email: string): Promise<TestTokenResponse> {
  const url = `${SERVER_URL}/auth/dev/test-token?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`mint ${email} failed: ${res.status}`);
  return (await res.json()) as TestTokenResponse;
}

interface DevStats {
  id: string;
  email: string;
  kills: number;
  deaths: number;
}

async function devStats(email: string): Promise<DevStats> {
  const url = `${SERVER_URL}/dev/stats?email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stats ${email} failed: ${res.status}`);
  return (await res.json()) as DevStats;
}

async function joinClientAt(browser: Browser, token: string, spawnX: number, spawnY: number) {
  // CRITICAL: pass an EXPLICIT empty storageState. `undefined` falls back to
  // the project-level default in playwright.config.ts (the globalSetup file),
  // which would inject the e2e@test.local token instead of our per-user one.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await ctx.addInitScript((t: string) => {
    localStorage.setItem('eqxAuthToken', t);
  }, token);
  // Join the drone-free `test-sector` room: the default `sector` definition
  // seeds 30 hostile drones in a 350u ring around origin, which were landing
  // the killing blow on the victim before the human killer's beam could —
  // producing rows with `killer_user_id` NULL and `victim_user_id` set.
  // `test-sector` (testMode: true, asteroidConfig: []) is the deterministic
  // alternative defined in src/server/index.ts for exactly this case.
  // Note: `?room=` triggers `autoJoin` in App.tsx (skips the splash entirely),
  // so we do NOT click the "Enter Sector Alpha" button — there isn't one.
  await page.goto(`${BASE_URL}?room=test-sector&spawnX=${spawnX}&spawnY=${spawnY}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 12_000 },
  );
  return { ctx, page };
}

test('kill is recorded in player_kills and queryable via /dev/stats', async ({ browser }) => {
  // Cold server boot + 2x context create + 2 s settle + ~10-15 s of firing
  // + DB flush + stats query. Pre-2026-05-17, the budget assumed ~5 s of
  // fire to kill at 500 HP. The slow-down-gameplay PR raised shield + hull
  // each +50 %, so effective HP-to-kill is roughly 1.5x and fire-to-kill
  // is closer to 7-10 s; under shared-server load it can climb above 15 s.
  // 90 s test budget + 30 s fire window (below) absorbs both.
  test.setTimeout(90_000);

  // Stamp emails with the worker index so parallel runs (different
  // playwright projects) don't collide on user rows.
  const stamp = `${process.env['TEST_PARALLEL_INDEX'] ?? '0'}-${Date.now().toString(36).slice(-4)}`;
  const killerEmail = `killer-${stamp}@e2e.test`;
  const victimEmail = `victim-${stamp}@e2e.test`;

  const [killerToken, victimToken] = await Promise.all([
    mintToken(killerEmail),
    mintToken(victimEmail),
  ]);

  // Align ships on +Y so no rotation is needed: ships spawn at angle 0, and
  // the forward direction is `(-sin(0), cos(0)) = (0, 1)`. Putting the victim
  // 100 u directly forward of the killer means the beam holds on target from
  // the moment Space goes down. 25 hits × 167 ms = ~4.2 s to deplete 500 HP.
  const [killer, victim] = await Promise.all([
    joinClientAt(browser, killerToken.token, 0, 0),
    joinClientAt(browser, victimToken.token, 0, 100),
  ]);

  try {
    // Settle: let both clients reconcile and let the server snapshot
    // population catch up to both ships.
    await Promise.all([
      killer.page.waitForTimeout(2000),
      victim.page.waitForTimeout(2000),
    ]);

    // Hold Space — the beam fires straight forward (+Y) and stays locked on
    // the victim until hull reaches 0. Fire window 30 s (was 15 s pre-
    // slow-down-gameplay; shield + hull each +50 % doubled the effective
    // HP-to-kill, plus shared-server load adds variance).
    const start = Date.now();
    let killed = false;
    await killer.page.keyboard.down('Space');
    try {
      while (Date.now() - start < 30_000) {
        await killer.page.waitForTimeout(200);
        const hullStr = await victim.page
          .locator('[data-testid="game-surface"]')
          .getAttribute('data-hull-pct');
        const hull = parseInt(hullStr ?? '100', 10);
        if (hull <= 0) {
          killed = true;
          break;
        }
      }
    } finally {
      await killer.page.keyboard.up('Space').catch(() => undefined);
    }

    if (!killed) {
      throw new Error('Beam did not deplete victim hull within 30 s — geometry or fire path is broken');
    }

    // Allow the WAB flush window (50 ms) + worker IPC + DB write to settle.
    await killer.page.waitForTimeout(300);

    const [killerStats, victimStats] = await Promise.all([
      devStats(killerEmail),
      devStats(victimEmail),
    ]);

    console.log(`killer=${killerEmail} kills=${killerStats.kills} | victim=${victimEmail} deaths=${victimStats.deaths}`);
    expect(victimStats.deaths).toBeGreaterThanOrEqual(1);
    expect(killerStats.kills).toBeGreaterThanOrEqual(1);
  } finally {
    await Promise.all([killer.ctx.close(), victim.ctx.close()]);
  }
});
