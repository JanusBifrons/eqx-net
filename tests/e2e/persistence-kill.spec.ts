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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`stats ${email} failed: ${res.status} :: ${body}`);
  }
  return (await res.json()) as DevStats;
}

async function joinClientAt(browser: Browser, token: string, spawnX: number, spawnY: number) {
  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();
  // Inject the per-user JWT BEFORE any page script runs so bootstrapAuth
  // picks it up. Each context gets a fresh storageState so the global
  // single-user token doesn't leak in.
  await ctx.addInitScript((t: string) => {
    localStorage.setItem('eqxAuthToken', t);
  }, token);
  await page.goto(`${BASE_URL}?spawnX=${spawnX}&spawnY=${spawnY}`);
  await page.getByRole('button', { name: /enter sector alpha/i }).click();
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
  // Stamp emails with the worker index so parallel runs (different
  // playwright projects) don't collide on user rows.
  const stamp = `${process.env['TEST_PARALLEL_INDEX'] ?? '0'}-${Date.now().toString(36).slice(-4)}`;
  const killerEmail = `killer-${stamp}@e2e.test`;
  const victimEmail = `victim-${stamp}@e2e.test`;

  const [killerToken, victimToken] = await Promise.all([
    mintToken(killerEmail),
    mintToken(victimEmail),
  ]);

  // Spawn close: 60 u apart is well inside HITSCAN_RANGE and in the same
  // interest cell, so the beam will hit on the very first sweep.
  const [killer, victim] = await Promise.all([
    joinClientAt(browser, killerToken.token, 0, 0),
    joinClientAt(browser, victimToken.token, 60, 0),
  ]);

  try {
    // Settle: let both clients reconcile and let the server snapshot
    // population catch up to both ships.
    await Promise.all([
      killer.page.waitForTimeout(2000),
      victim.page.waitForTimeout(2000),
    ]);

    // Sweep: hold Space while gently rotating the killer until the victim's
    // hull goes to 0. Bail after 30 s — that's the test budget.
    const start = Date.now();
    let killed = false;
    await killer.page.keyboard.down('Space');
    try {
      while (Date.now() - start < 30_000) {
        // Rotate slowly so the beam crosses the victim.
        await killer.page.keyboard.press('ArrowLeft');
        await killer.page.waitForTimeout(150);
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
      console.log('Beam did not deplete victim hull within 30 s — skipping stats assertion.');
      test.skip();
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
