import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** Committed screenshot output root (diag/ is tracked; test-results/ is gitignored). */
const SCREENSHOT_ROOT = join(process.cwd(), 'diag', 'e2e-screenshots');

/**
 * Capture the rendered game scene for visual verification of entity
 * placement (lingering hulls where they should be).
 *
 * REQUIRES the client to have been launched with `?worker=0` — the default
 * OffscreenCanvas-in-worker renderer composites to a transferred canvas that
 * Playwright captures as BLACK; the main-thread Pixi renderer composites
 * normally. `launchGalaxyTestClient` sets `worker=0` for exactly this reason.
 *
 * Waits for the join-handshake load curtain to drop
 * (`data-loading-active=0`) plus a short settle so the warp-in fade has
 * cleared before the capture, then writes `<subdir>/<name>.png` and returns
 * its path. `subdir` defaults to `linger` for the existing lingering-hull
 * specs; the engine-particle flight spec passes `engine-particles`.
 */
export async function captureGameScene(page: Page, name: string, subdir = 'linger'): Promise<string> {
  const dir = join(SCREENSHOT_ROOT, subdir);
  mkdirSync(dir, { recursive: true });
  // Best-effort wait for the curtain to drop so we don't snap the warp veil.
  try {
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="hud-test-attributes"]')
          ?.getAttribute('data-loading-active') === '0',
      { timeout: 10_000 },
    );
  } catch {
    /* capture anyway — a missing/late signal shouldn't lose the artefact */
  }
  // Let the warp-curtain fade clear (visual artefact, not a game-time wait).
  await page.waitForTimeout(300);
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}
