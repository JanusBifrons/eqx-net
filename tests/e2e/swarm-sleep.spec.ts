/**
 * Phase 5e sleep-handshake acceptance gate.
 *
 * Spawns a single stationary asteroid via `?room=test-sector&singleAsteroid=1`,
 * waits for the worker's 12-tick sleep hysteresis to trip, then verifies that
 * once `sleeping=true` the encoder stops shipping per-entity packets — the
 * client only sees the every-60th-tick full-snapshot keyframe (~1 packet/sec).
 *
 * Why a packet count instead of a per-entity byte counter: the latter would
 * require per-(client, entity) tracking on the server. Counting *packets*
 * received per second after sleep is the same signal at this granularity —
 * if sleep weren't honoured, every tick would ship the asteroid and the
 * count would be ~60/s instead of ~1/s.
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/swarm-sleep.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface BwSnapshot {
  swarmPackets: number;
}

async function readBw(page: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newPage']>>): Promise<BwSnapshot> {
  return await page.evaluate((): BwSnapshot => {
    const w = window as unknown as { __EQX_BW_STATS?: { swarmPackets: number; reset: () => void } };
    const s = w.__EQX_BW_STATS!;
    const out: BwSnapshot = { swarmPackets: s.swarmPackets };
    s.reset();
    return out;
  });
}

test.describe('Phase 5e — sleep handshake', () => {
  test.setTimeout(45_000);

  test('stationary asteroid stops generating per-tick traffic once asleep', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}?room=test-sector&singleAsteroid=1`);

      // Wait for the asteroid's sleeping flag to become true. Worker hysteresis
      // is 12 ticks at v ≈ 0, so this should fire within ~250 ms of spawn.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="game-surface"]');
          if (!el) return false;
          const raw = el.getAttribute('data-swarm-sleeping');
          if (!raw) return false;
          const map = JSON.parse(raw) as Record<string, boolean>;
          return Object.values(map).some((b) => b === true);
        },
        { timeout: 10_000 },
      );

      // Reset bandwidth tally and sample for 3 s while asleep.
      await readBw(page);
      await page.waitForTimeout(3_000);
      const after = await readBw(page);

      // While asleep, the encoder ships at most the 60-tick full-snapshot
      // cadence (= 1 Hz). 3 seconds × 1 Hz = 3 expected packets; allow up
      // to 6 for jitter / tick alignment / one stray sleep transition.
      console.log(`\nPhase 5e sleep: swarmPackets received in 3 s after sleep = ${after.swarmPackets}\n`);
      expect(after.swarmPackets).toBeLessThanOrEqual(6);
      expect(after.swarmPackets).toBeGreaterThanOrEqual(1); // at least one full-snapshot keyframe should arrive
    } finally {
      await ctx.close();
    }
  });
});
