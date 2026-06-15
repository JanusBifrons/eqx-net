import { test, expect } from '@playwright/test';

// Phase 0 baseline: the Vite dev server renders the stub app.
// Phase 1 expands this suite with multi-tab SectorRoom scenarios.
test('client boots to the living galaxy map at the root URL', async ({ page }) => {
  await page.goto('/');
  // Living Galaxy P5 — the live galaxy map is the first screen on load; the
  // meta "Join the fight" landing is retired from the default path.
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
});
