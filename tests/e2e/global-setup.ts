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
}
