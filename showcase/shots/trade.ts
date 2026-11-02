import type { Shot } from '../types.js';
import { TRADE_TARGET, agreeSalvageDeal, haulerId, placeHome, warmTradeTab } from './_trade.js';
import { flyTo } from './_pilot.js';

/**
 * Trade deals (Living World P2, economy v2) — the Trade tab: standing with each
 * side, the offers board, agree a sale. Signed-in (default auth): trade needs
 * an account. The home Capital is placed before recording.
 */
export const tradeDeal: Shot = {
  id: 'trade-deal',
  section: 'mechanics',
  title: 'Trade deals',
  caption: 'Strike a deal from the Trade tab: sell your goods to a faction and a hauler flies out to collect them.',
  features: ['M41'],
  docs: ['trade-deals', 'economy-and-trade', 'economy-wallet'],
  reel: true,
  server: 'lean',
  target: TRADE_TARGET,
  hud: 'clean',
  durationMs: 11_000,
  async prepare(ctx) {
    await ctx.sleep(3000);
    await placeHome(ctx);
    await warmTradeTab(ctx);
  },
  camera: [{ atMs: 0, smoothMs: 300, shot: { kind: 'track', target: 'local', zoom: 0.75, leadMs: 250 } }],
  async run(ctx) {
    await ctx.sleep(1200);
    await agreeSalvageDeal(ctx, 1100);
  },
};

/**
 * The hauler run — after a deal, the trade hauler flies in from the sector
 * edge and robot raiders jump it (the red "under fire" escort prompt). The
 * take starts once the raid begins and follows the hauler.
 */
let raidedHauler = 0;
export const tradeRaid: Shot = {
  id: 'trade-raid',
  section: 'mechanics',
  title: 'Haulers & raiders',
  caption: 'Every deal is a real hauler crossing the sector. Raiders hunt it — fly out and escort it home.',
  features: ['M41'],
  docs: [],
  reel: true,
  server: 'lean',
  target: TRADE_TARGET,
  hud: 'minimal',
  durationMs: 12_000,
  async prepare(ctx) {
    await ctx.sleep(3000);
    await placeHome(ctx);
    await agreeSalvageDeal(ctx, 300);
    raidedHauler = await haulerId(ctx, 30_000);
  },
  async startWhen(ctx) {
    // The raiders reach the hauler partway along its route.
    await ctx.page
      .locator('[data-testid="trade-toast"][data-tone="danger"]')
      .first()
      .waitFor({ state: 'visible', timeout: 120_000 });
  },
  camera: [{ atMs: 0, smoothMs: 300, shot: { kind: 'track', target: 'local', zoom: 0.9, leadMs: 250 } }],
  async run(ctx) {
    // Fly out to the hauler; auto-fire takes on the raiders around it.
    const end = Date.now() + 11_000;
    while (Date.now() < end) {
      const h = await ctx.page.evaluate((id) => {
        const m = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { x: number; y: number }> } } }).__eqxClient?.mirror;
        const e = m?.swarm?.get(id);
        return e ? { x: e.x, y: e.y } : null;
      }, raidedHauler);
      if (!h) break;
      await flyTo(ctx, h.x, h.y - 150, { arrive: 200, cruise: 300, maxMs: 1500, passThrough: true });
    }
  },
};
