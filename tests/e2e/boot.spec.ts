import { test, expect } from '@playwright/test';

// Phase 0 baseline: the Vite dev server renders the stub app.
// Phase 1 expands this suite with multi-tab SectorRoom scenarios.
test('client boots and renders the splash heading', async ({ page }) => {
  await page.goto('/');
  // MUI Typography variant="h2" renders as <h2>
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('EQX Peri');
});
