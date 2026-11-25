/**
 * Player capitals: a pilot flies a battleship in a real galaxy room.
 *
 * A fresh player asks for a battleship (a free starter hull, like the
 * scout and fighter) in the linger-capable `galaxy-test` room. The server's
 * hull gate lets it through: the roster row is a battleship, not the
 * fallback fighter. In Fly the capital is flown by hand (owner, 2026-11-21:
 * Fly is manual only, no helm panel): W moves it (server pose moves).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchGalaxyTestClient } from './helpers/gameScenario';
import { SERVER_URL } from './helpers/ports';

async function rosterKinds(playerId: string): Promise<string[]> {
  const res = await fetch(`${SERVER_URL}/dev/player-ships?playerId=${encodeURIComponent(playerId)}`);
  return ((await res.json()) as { ships: Array<{ kind: string }> }).ships.map((s) => s.kind);
}

async function shipPos(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-ship-x]') as HTMLElement | null;
    return { x: Number(el?.dataset['shipX'] ?? NaN), y: Number(el?.dataset['shipY'] ?? NaN) };
  });
}

test('a fresh player spawns a battleship in a galaxy sector and flies it by hand', async ({ browser }) => {
  // Infrastructure: a lazily-created galaxy room + worker and capital art on a cold page.
  test.setTimeout(120_000);
  const { ctx, page, playerId } = await launchGalaxyTestClient(browser, {
    testId: randomUUID(), shipKind: 'battleship', spawnX: 0, spawnY: 0,
  });
  try {
    expect(await rosterKinds(playerId), 'the hull gate let the free battleship through').toEqual(['battleship']);

    await page.waitForFunction(
      () => !Number.isNaN(Number((document.querySelector('[data-ship-x]') as HTMLElement | null)?.dataset['shipX'])),
      undefined,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('helm-speed'), 'Fly shows no speed telegraph').toHaveCount(0);
    const start = await shipPos(page);
    await page.keyboard.down('w');
    try {
      await expect.poll(async () => {
        const p = await shipPos(page);
        return Math.hypot(p.x - start.x, p.y - start.y);
      }, { timeout: 20_000 }).toBeGreaterThan(30);
    } finally {
      await page.keyboard.up('w');
    }
  } finally {
    await ctx.close();
  }
});
