// @diag (manual-only): see docs/architecture/e2e-framework.md
// Run: pnpm e2e:diag tests/diag/modal-close-diagnostic.spec.ts
import { test, type Page } from '@playwright/test';

/**
 * Diagnostic probe for the drawer-galaxy-overview-spawn.spec.ts step-7
 * failure: the modal stays mounted after the Close click for >10 s.
 *
 * Reproduces the same flow, captures DOM state at each step. Always
 * passes; the result is in the printed log.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface StoreState {
  playerId: string | null;
  localShipInstanceId: string | null;
  setDrawerOpen: (v: boolean) => void;
  setDrawerTab: (id: string) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => StoreState };
}

async function dumpModalDom(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('[data-testid="ship-detail-modal"]'));
    const closeButtons = Array.from(document.querySelectorAll('[data-testid="ship-detail-close"]'));
    const rosterCards = Array.from(document.querySelectorAll('[data-testid^="ship-roster-card-"]'));
    // Look at openShipId via React-fibre is hard; instead capture DOM facts.
    return {
      modalCount: modals.length,
      modalDescriptors: modals.map((m) => {
        const cs = window.getComputedStyle(m as HTMLElement);
        return {
          tagName: m.tagName,
          ariaHidden: m.getAttribute('aria-hidden'),
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          pointerEvents: cs.pointerEvents,
          parentTagName: m.parentElement?.tagName ?? null,
          parentClass: m.parentElement?.className ?? null,
        };
      }),
      closeButtonCount: closeButtons.length,
      rosterCardCount: rosterCards.length,
      rosterCardIds: rosterCards.map((c) => c.getAttribute('data-testid')),
    };
  });
  // eslint-disable-next-line no-console
  console.log(`\n=== ${label} ===\n${JSON.stringify(result, null, 2)}`);
}

test('modal close diagnostic — DOM dump at each step', async ({ page }) => {
  test.setTimeout(120_000);

  page.on('console', (m) => {
    // eslint-disable-next-line no-console
    console.log(`[page-console:${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    // eslint-disable-next-line no-console
    console.log(`[page-error] ${e.message}`);
  });

  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.locator('[data-testid="ship-stats-card"]').waitFor({ timeout: 25_000 });
  // Wait for ship count > 0 + localShipInstanceId populated.
  await page.waitForFunction(
    () => {
      const win = window as unknown as StoreWindow;
      return win.__eqxStore?.getState().localShipInstanceId !== null;
    },
    { timeout: 15_000 },
  );

  // Open drawer + click show galaxy map (via Zustand for stability).
  await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    const s = win.__eqxStore!.getState();
    s.setDrawerTab('galaxy');
    s.setDrawerOpen(true);
  });
  await page.locator('[data-testid="galaxy-tab-show-map"]').waitFor({ timeout: 30_000 });
  await page
    .locator('[data-testid="galaxy-tab-show-map"]')
    .click({ force: true, timeout: 15_000 });
  await page.locator('[data-testid="galaxy-overview-select"]').waitFor({ timeout: 15_000 });

  const localShipInstanceId = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    return win.__eqxStore!.getState().localShipInstanceId;
  });

  await dumpModalDom(page, 'BEFORE roster-card click');

  await page
    .locator(`[data-testid="ship-roster-card-${localShipInstanceId}"]`)
    .first()
    .click({ force: true, timeout: 5_000, noWaitAfter: true });

  await page.waitForTimeout(500);
  await dumpModalDom(page, 'AFTER roster-card click (modal should be open)');

  // Approach 1: Playwright click.
  await page
    .locator('[data-testid="ship-detail-close"]')
    .click({ force: true, timeout: 3_000, noWaitAfter: true });

  await page.waitForTimeout(1000);
  await dumpModalDom(page, 'AFTER Playwright .click()');

  // Approach 2: JS-dispatched click directly on the element.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="ship-detail-close"]');
    if (btn) {
      (btn as HTMLElement).click();
    }
  });
  await page.waitForTimeout(1000);
  await dumpModalDom(page, 'AFTER JS .click()');

  // Approach 3: Synthesised MouseEvent.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="ship-detail-close"]');
    if (btn) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  });
  await page.waitForTimeout(1000);
  await dumpModalDom(page, 'AFTER dispatchEvent click');

  // Approach 4: pointerdown + pointerup — what MUI actually listens for.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="ship-detail-close"]');
    if (btn) {
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  });
  await page.waitForTimeout(1000);
  await dumpModalDom(page, 'AFTER pointerdown+up+click');
});
