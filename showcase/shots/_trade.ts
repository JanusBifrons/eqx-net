/**
 * Shared steps for the trade shots (`trade-showcase` room — see
 * tests/showcase/trade-p2.spec.ts, which these mirror). The room stocks any
 * storage the pilot places and sends two robot raiders at each hauler.
 */
import type { ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';

export const TRADE_TARGET = {
  room: 'trade-showcase',
  params: { shipKind: 'heavy', newShip: 1, spawnX: 0, spawnY: -200, initialHull: 99_999, noselfdmg: 1 },
} as const;

/** Place a home Capital (retrying further south if the spot is taken). */
export async function placeHome(ctx: ShotContext): Promise<void> {
  const count = (): Promise<number> =>
    ctx.page.evaluate(
      () => (window as unknown as { __eqxClient?: { mirror?: { structures?: Map<number, unknown> } } }).__eqxClient?.mirror?.structures?.size ?? 0,
    );
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await count();
    // Trade rooms share one sector name, so earlier takes' Capitals are
    // restored into this room: try a ring of spots around the spawn.
    const a = (attempt * 2 * Math.PI) / 8 + Math.PI;
    await sendRoom(ctx, 'place_structure', { type: 'place_structure', kind: 'capital', x: Math.sin(a) * 650, y: -200 + Math.cos(a) * 650 });
    const placed = await ctx.page
      .waitForFunction(
        (n) => ((window as unknown as { __eqxClient?: { mirror?: { structures?: Map<number, unknown> } } }).__eqxClient?.mirror?.structures?.size ?? 0) > n,
        before,
        { timeout: 6000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (placed) return;
  }
  throw new Error('could not place the home Capital');
}

/** Open the Trade tab once and close it, so the recorded open is not its first (slow) render. */
export async function warmTradeTab(ctx: ShotContext): Promise<void> {
  const { page } = ctx;
  await page.getByTestId('drawer-toggle').click();
  await page.getByTestId('drawer-tab-trade').click();
  await page.locator('[data-testid="trade-offer"]').first().waitFor({ state: 'visible', timeout: 20_000 });
  // Also open the deal dialog once (its first mount is the long stall).
  await page.locator('[data-testid="trade-offer"]').first().getByTestId('trade-offer-deal').click();
  await page.getByTestId('trade-deal-dialog').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('trade-deal-dialog').getByRole('button', { name: 'Cancel' }).click();
  await ctx.sleep(800);
  await page.getByTestId('drawer-close').click();
  await ctx.sleep(1200);
}

/** Open the Trade tab and agree a one-off sale of 40 salvage. `pace` spaces the clicks for the camera. */
export async function agreeSalvageDeal(ctx: ShotContext, pace: number): Promise<void> {
  const { page } = ctx;
  await page.getByTestId('drawer-toggle').click();
  await page.getByTestId('drawer-tab-trade').click();
  await page.getByTestId('trade-base-picker').waitFor({ state: 'visible', timeout: 15_000 });
  const offer = page.locator('[data-testid="trade-offer"][data-offer-kind="sell"][data-offer-good="salvage"]');
  await offer.waitFor({ state: 'visible', timeout: 20_000 }).catch(async (e: unknown) => {
    // Say what the tab DID show, so a failed take is diagnosable from the log.
    const shown = await page.getByTestId('trade-tab').innerText().catch(() => '(no trade tab)');
    ctx.log(`trade tab: ${shown.replace(/\s+/g, ' ').slice(0, 400)}`);
    throw e;
  });
  await ctx.sleep(pace * 1.5);
  await offer.getByTestId('trade-offer-deal').click();
  await ctx.sleep(pace);
  await page.getByTestId('trade-deal-qty').fill('40');
  await ctx.sleep(pace);
  await page.getByTestId('trade-deal-confirm').click();
  await ctx.sleep(pace * 1.5);
  await page.getByTestId('drawer-close').click();
}

/** Swarm id of the trade hauler, once it has flown in. */
export async function haulerId(ctx: ShotContext, timeoutMs: number): Promise<number> {
  const handle = await ctx.page.waitForFunction(
    () => {
      const m = (window as unknown as {
        __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string }> } };
      }).__eqxClient?.mirror;
      for (const [id, e] of m?.swarm ?? []) if (e.kind === 1 && e.shipKind === 'trader-hauler') return id;
      return 0;
    },
    undefined,
    { timeout: timeoutMs, polling: 250 },
  );
  return (await handle.jsonValue()) as number;
}
