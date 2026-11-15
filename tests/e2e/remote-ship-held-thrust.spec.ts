/**
 * RTS Part A S1 — a remote pilot holding thrust and a turn is forward-
 * predicted on every snapshot by another player's client.
 *
 * Bug: the server left a ship's input bits out of the snapshot whenever they
 * had not changed since the last send to that viewer, and the client dropped
 * its copy when the bits were absent. So the observer predicted the held keys
 * for one snapshot, then let the ship coast: every 50 ms the server pose
 * landed well ahead of the coasting body and the drawn ship was pulled
 * forward (a correction on every snapshot of a turning, thrusting ship).
 *
 * Now held bits ride every snapshot (absent = idle), so the observer's body
 * follows the held keys and each snapshot's reset correction stays small.
 *
 * Measured on the observer: `remoteCorrTotalUnits / remoteCorrSamples`
 * (pred stats, print-only) over the window the pilot holds W + A. We wait on
 * the sample count (game state), never a paced sleep.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchTestClient, getLocalPlayerId, getShipPositions } from './helpers/gameScenario';

interface RemoteCorr { total: number; samples: number }

/** Mean per-snapshot reset correction allowed while the keys are held.
 *  Measured 2026-11-14 (laptop, local lane, fighter, W + A): 0.000 u with the
 *  fix; 0.187 u with the old dedupe (bits dropped once unchanged). */
const MAX_MEAN_CORRECTION_U = 0.06;

async function remoteCorr(page: Page): Promise<RemoteCorr> {
  return page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats') ?? '{}';
    const s = JSON.parse(raw) as { remoteCorrTotalUnits?: number; remoteCorrSamples?: number };
    return { total: s.remoteCorrTotalUnits ?? 0, samples: s.remoteCorrSamples ?? 0 };
  });
}

test('an observer forward-predicts a remote pilot holding thrust + turn on every snapshot', async ({ browser }) => {
  test.setTimeout(60_000);
  const testId = randomUUID();
  const pilot = await launchTestClient(browser, { spawnX: 0, spawnY: 0, initialAngle: 0, shipKind: 'fighter', testId });
  const observer = await launchTestClient(browser, { spawnX: 400, spawnY: 0, shipKind: 'fighter', testId });
  try {
    const pilotId = await getLocalPlayerId(pilot.page);
    expect(pilotId).not.toBe('');
    // The observer must see the pilot before we measure.
    await observer.page.waitForFunction(
      (id) => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions') ?? '{}';
        return (JSON.parse(raw) as Record<string, unknown>)[id as string] !== undefined;
      }, pilotId, { timeout: 15_000 },
    );
    const start = await getShipPositions(observer.page);

    await pilot.page.keyboard.down('w');
    await pilot.page.keyboard.down('a');
    // Let the turn settle in (first snapshots carry the press itself).
    const warm = await remoteCorr(observer.page);
    await observer.page.waitForFunction(
      (n) => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats') ?? '{}';
        return ((JSON.parse(raw) as { remoteCorrSamples?: number }).remoteCorrSamples ?? 0) >= (n as number);
      }, warm.samples + 10, { timeout: 15_000 },
    );
    const before = await remoteCorr(observer.page);
    await observer.page.waitForFunction(
      (n) => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats') ?? '{}';
        return ((JSON.parse(raw) as { remoteCorrSamples?: number }).remoteCorrSamples ?? 0) >= (n as number);
      }, before.samples + 40, { timeout: 20_000 },
    );
    const after = await remoteCorr(observer.page);
    await pilot.page.keyboard.up('a');
    await pilot.page.keyboard.up('w');

    const end = await getShipPositions(observer.page);
    const moved = Math.hypot(end[pilotId]!.x - start[pilotId]!.x, end[pilotId]!.y - start[pilotId]!.y);
    const mean = (after.total - before.total) / (after.samples - before.samples);
    console.log(`remote reset correction while held: mean ${mean.toFixed(3)} u over ${after.samples - before.samples} snapshots; pilot moved ${moved.toFixed(0)} u on the observer`);
    expect(moved, 'the pilot never moved on the observer').toBeGreaterThan(50);
    expect(mean, 'the observer stopped forward-predicting the held keys (corrections every snapshot)').toBeLessThan(MAX_MEAN_CORRECTION_U);
  } finally {
    await pilot.ctx.close();
    await observer.ctx.close();
  }
});
