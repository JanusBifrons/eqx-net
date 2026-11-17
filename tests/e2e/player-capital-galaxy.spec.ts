/**
 * Player capitals: a pilot flies a battleship in a real galaxy room.
 *
 * A fresh player asks for a battleship (a free starter hull, like the
 * scout and fighter) in the linger-capable `galaxy-test` room. The server's
 * hull gate lets it through: the roster row is a battleship, not the
 * fallback fighter. The capital helm comes up, and a tap sets a course that
 * the helm flies (server pose moves).
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

test('a fresh player spawns a battleship in a galaxy sector and the helm flies it', async ({ browser }) => {
  // Infrastructure: a lazily-created galaxy room + worker and capital art on a cold page.
  test.setTimeout(120_000);
  const { ctx, page, playerId } = await launchGalaxyTestClient(browser, {
    testId: randomUUID(), shipKind: 'battleship', spawnX: 0, spawnY: 0,
  });
  try {
    expect(await rosterKinds(playerId), 'the hull gate let the free battleship through').toEqual(['battleship']);

    const panel = page.getByTestId('helm-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => !Number.isNaN(Number((document.querySelector('[data-ship-x]') as HTMLElement | null)?.dataset['shipX'])));
    const start = await shipPos(page);
    const box = (await page.locator('canvas').first().boundingBox())!;
    // Re-tap until it takes (a busy cold frame can stretch a tap into a drag).
    await expect.poll(async () => {
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);
      return panel.getAttribute('data-helm-active');
    }, { timeout: 10_000, intervals: [300] }).toBe('1');

    await expect.poll(async () => {
      const p = await shipPos(page);
      return Math.hypot(p.x - start.x, p.y - start.y);
    }, { timeout: 20_000 }).toBeGreaterThan(30);
  } finally {
    await ctx.close();
  }
});
