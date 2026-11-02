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
  for (let attempt = 0; attempt < 4; attempt++) {
    await sendRoom(ctx, 'place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: -520 - attempt * 300 });
    const placed = await ctx.page
      .waitForFunction(
        () => {
          const m = (window as unknown as {
            __eqxClient?: { mirror?: { localPlayerId?: string; structures?: Map<number, { owner?: string }> } };
          }).__eqxClient?.mirror;
          for (const s of m?.structures?.values() ?? []) if (s.owner && s.owner === m?.localPlayerId) return true;
          return false;
        },
        undefined,
        { timeout: 3000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (placed) return;
  }
  throw new Error('could not place the home Capital');
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
