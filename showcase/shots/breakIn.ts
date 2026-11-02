import type { Shot } from '../types.js';
import { selectAt } from './_helpers.js';

/**
 * Cargo + break-ins (C1–C3, plan soft-leaping-truffle v3) — `break-in-test`
 * room: a Capital at (0,0) owned by someone else, holding 7 alloy, with a
 * short `breakInMs`. Select it → open its cargo → locked → break in → the hold
 * opens → take the alloy aboard. Signed-in (default auth): cargo needs a
 * roster row.
 *
 * NOT in the reel yet: the cargo panel opens (the DOM has it, a page
 * screenshot shows it) but the CDP screencast frames never include it, so the
 * clip shows only the inspector. Unexplained as of 2026-11-02.
 */
export const breakIn: Shot = {
  id: 'break-in',
  section: 'mechanics',
  title: 'Cargo & break-ins',
  caption: "Open any hold you're allowed into and move goods by hand — or break into one that isn't yours.",
  features: ['M24'],
  docs: ['loot-and-cargo'],
  reel: false,
  server: 'lean',
  target: { room: 'break-in-test', params: { shipKind: 'heavy', spawnX: 0, spawnY: 650 } },
  hud: 'clean',
  durationMs: 12_000,
  async prepare(ctx) {
    await ctx.page.waitForFunction(
      () => {
        const m = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number }> } } })
          .__eqxClient?.mirror;
        for (const [, s] of m?.swarm ?? []) if (s.kind === 2) return true;
        return false;
      },
      undefined,
      { timeout: 15_000 },
    );
  },
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 360, zoom: 0.7 } },
    { atMs: 2000, smoothMs: 3000, shot: { kind: 'hold', x: 0, y: 200, zoom: 0.85 } },
  ],
  async run(ctx) {
    const { page } = ctx;
    await ctx.sleep(1200);
    await selectAt(ctx, 0, 0);
    await page.getByTestId('entity-stats-panel').waitFor({ state: 'visible', timeout: 5000 });
    await ctx.sleep(1200);
    await page.getByTestId('cargo-open-toggle').click();
    await page.getByTestId('cargo-locked').waitFor({ state: 'visible', timeout: 5000 });
    await ctx.sleep(1800);
    await page.getByTestId('cargo-break-in').click();
    await page.locator('[data-testid="cargo-panel"][data-open="1"]').waitFor({ timeout: 8000 });
    await ctx.sleep(1500);
    await page.locator('[data-testid="cargo-here-row"][data-key="g:alloy"]').getByTestId('cargo-take-all').click();
    await ctx.sleep(1500);
  },
};
