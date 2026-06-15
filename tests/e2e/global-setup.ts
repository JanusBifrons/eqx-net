/**
 * Playwright globalSetup — runs once before any test, after Playwright has
 * started the `webServer` instances. Mints a real JWT for a deterministic test
 * user via the dev-only `/auth/dev/test-token` endpoint and writes it as a
 * Playwright storageState file.
 *
 * `playwright.config.ts` then references that file via `use.storageState`,
 * which Playwright applies to every browser context (including those created
 * explicitly with `browser.newContext()` in multi-client specs). On boot,
 * `main.tsx#bootstrapAuth` reads `localStorage.eqxAuthToken`, validates with
 * `/auth/me`, and `App.tsx` falls into the `splash` phase — the real auth
 * machinery, just primed with a real token.
 *
 * The dev endpoint is NODE_ENV-gated server-side. This setup is only invoked
 * by Playwright (which always runs in dev), so production cannot be affected.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';
const STORAGE_STATE_PATH = path.resolve('tests/e2e/.auth/storage-state.json');

interface TestTokenResponse {
  token: string;
  user: { id: string; email: string };
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

  let payload: TestTokenResponse;
  try {
    const res = await fetch(`${SERVER_URL}/auth/dev/test-token`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`dev test-token endpoint returned ${res.status} ${res.statusText}`);
    }
    payload = (await res.json()) as TestTokenResponse;
  } catch (err) {
    const hint =
      'Is the dev server running on port 2567? Playwright should start it automatically via the `webServer` config; ' +
      'if you set CI_SKIP_WEBSERVER, also set PLAYWRIGHT_SERVER_URL to point at the deployed dev server.';
    throw new Error(`[e2e/global-setup] failed to mint test JWT: ${(err as Error).message}\n${hint}`);
  }

  const origin = new URL(baseURL).origin;
  const storageState = {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: 'eqxAuthToken', value: payload.token },
        ],
      },
    ],
  };

  await mkdir(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  await writeFile(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), 'utf8');
  console.log(`[e2e/global-setup] wrote auth storageState for ${origin} (user ${payload.user.email})`);

  // ── Vite warm-up (de-flake) ────────────────────────────────────────────────
  // The dev `vite` server compiles the app's module graph ON FIRST REQUEST, and
  // a cold compile of this app takes far longer than a single test's boot wait.
  // Under sharding each shard runs its own Playwright invocation (own globalSetup
  // + own vite), so WHICHEVER test boots first in a shard pays the cold compile
  // and blows its `ship-stats-card` wait — the recurring `layout-slots` flake.
  // Boot the app ONCE here (in untimed setup) so the compile + the `test-sector`
  // room are warm before any test runs; every test then boots in a few seconds.
  // Skipped when Playwright is not managing the servers (CI_SKIP_WEBSERVER — the
  // netgate driver, whose arms live on other ports). Non-fatal by design.
  if (!process.env['CI_SKIP_WEBSERVER']) {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ storageState: STORAGE_STATE_PATH });
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/?room=test-sector`, { waitUntil: 'domcontentloaded' });
      // 90 s covers a cold module-graph compile on a contended CI runner.
      await page.waitForSelector('[data-testid="game-surface"]', { timeout: 90_000 });
      // Best-effort: also reach in-game so the test-sector room is warm too.
      await page
        .locator('[data-testid="ship-stats-card"]')
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
      console.log('[e2e/global-setup] warmed Vite + test-sector room');
    } catch (err) {
      console.log(`[e2e/global-setup] warm-up skipped/failed (non-fatal): ${(err as Error).message}`);
    } finally {
      await browser.close();
    }
  }
}
