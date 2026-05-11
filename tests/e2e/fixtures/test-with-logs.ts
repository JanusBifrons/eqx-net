/**
 * Shared Playwright fixture that:
 *   1. Creates a browser context and navigates to the game.
 *   2. Joins Sector Alpha, waiting until the ship is live.
 *   3. On test failure, dumps the __eqxLogs ring buffer to console for diagnosis.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/test-with-logs';
 *
 *   test('my test', async ({ eqxPage, getPredStats, clearEqxLogs, getEqxLogs }) => { ... });
 */
import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { PredictionStats } from '../../../src/client/net/ColyseusClient';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

export interface LogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    __eqxLogs?: LogEntry[];
    __eqxEpoch?: number;
    __eqxClearLogs?: () => void;
  }
}

interface EqxFixtures {
  eqxCtx: BrowserContext;
  eqxPage: Page;
  getPredStats: () => Promise<PredictionStats>;
  getEqxLogs: () => Promise<LogEntry[]>;
  clearEqxLogs: () => Promise<void>;
}

export const test = base.extend<EqxFixtures>({
  eqxCtx: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await use(ctx);
    await ctx.close();
  },

  eqxPage: async ({ eqxCtx }, use, testInfo) => {
    const page = await eqxCtx.newPage();

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('[ColyseusClient]')) console.log(`    ${text}`);
    });

    // The pre-2026-05-10 meta landing was a single "Enter Sector Alpha"
    // button; the current landing screen has a "Join the fight!" CTA that
    // routes through the Galaxy Overview before reaching the game. The
    // `?room=` URL param is the auto-join escape hatch used by every other
    // spec — bypass meta + auth and land directly in the game phase.
    await page.goto(`${BASE_URL}/?room=sector`);
    await page.waitForSelector('[data-testid="game-surface"]', { timeout: 10000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ship-count"]');
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      { timeout: 10000 },
    );

    await use(page);

    // Always dump logs on failure so the CI transcript shows what happened.
    if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
      try {
        const logs: LogEntry[] = await page.evaluate(() => window.__eqxLogs ?? []);
        const epoch: number = await page.evaluate(() => window.__eqxEpoch ?? 0);
        if (logs.length > 0) {
          const t0 = logs[0]?.ts ?? 0;
          console.log(`\n=== __eqxLogs dump (epoch=${epoch}, ${logs.length} entries) ===`);
          for (const e of logs) {
            const rel = (e.ts - t0).toFixed(0).padStart(7);
            console.log(`  t+${rel}ms  [${e.tag}]  ${JSON.stringify(e.data)}`);
          }
          console.log('=================================================\n');
        }
      } catch {
        // page may already be closed — ignore
      }
    }
  },

  getPredStats: async ({ eqxPage }, use) => {
    await use(() =>
      eqxPage.evaluate(() => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
        return JSON.parse(raw ?? '{}') as PredictionStats;
      }),
    );
  },

  getEqxLogs: async ({ eqxPage }, use) => {
    await use(() => eqxPage.evaluate(() => window.__eqxLogs ?? []));
  },

  clearEqxLogs: async ({ eqxPage }, use) => {
    await use(() => eqxPage.evaluate(() => { window.__eqxClearLogs?.(); }));
  },
});

export { expect };
