import { test, expect } from '@playwright/test';

// Phase 0 baseline: the Vite dev server renders the stub app.
// Phase 1 expands this suite with multi-tab SectorRoom scenarios.
test('client boots and renders the Phase 0 stub heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('EQX Peri');
});
