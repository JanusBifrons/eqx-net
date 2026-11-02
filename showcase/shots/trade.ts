import type { Shot } from '../types.js';
import { TRADE_TARGET, agreeSalvageDeal, haulerId, placeHome } from './_trade.js';

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
  hud: 'full',
  durationMs: 11_000,
  async prepare(ctx) {
    await ctx.sleep(3000);
    await placeHome(ctx);
  },
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: -450, zoom: 0.55 } }],
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
  caption: 'Every deal is a real hauler crossing the sector — raiders hunt it, and you can fly out to escort it home.',
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
  async run(ctx) {
    await ctx.cinema.play([
      { atMs: 0, smoothMs: 0, shot: { kind: 'track', target: `swarm-${raidedHauler}`, zoom: 0.8 } },
      { atMs: 5000, smoothMs: 1500, shot: { kind: 'track', target: `swarm-${raidedHauler}`, zoom: 0.55 } },
    ]);
  },
};
