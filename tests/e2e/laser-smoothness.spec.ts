/**
 * Laser smoothness regression test.
 *
 * Background: the local hitscan beam used to be cached as absolute world
 * coords (`fromX/fromY/toX/toY`) at fixed-tick rate, while the local ship
 * sprite was drawn from the lerp-corrected mirror pose. During reconciler
 * lerp windows (especially on jittery mobile networks) the beam visibly
 * detached from the ship's nose for a few frames.
 *
 * Fix: the beam mirror now stores only `dist`, and the renderer derives the
 * geometry per frame from `mirror.ships[localId]` — the same source the
 * ship sprite uses. This test holds fire on a locked target while
 * wiggling the hull, samples ship pose and beam-from across many frames, and asserts
 * the relationship `beam.from === ship + 20*forward(ship.angle)` holds at
 * every sample. If anyone reverts the beam to cache its origin, the
 * arithmetic relationship will start drifting during corrections and this
 * test will fail.
 */

import { launchTestClient } from './helpers/gameScenario';
import { lockOn, toManual } from './helpers/fireControl';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

interface BeamSample {
  shipX: number;
  shipY: number;
  shipAngle: number;
  beamFromX: number | null;
  beamFromY: number | null;
  beamActive: boolean;
}

async function sampleBeam(page: Page): Promise<BeamSample> {
  return page.evaluate<BeamSample>(() => {
    const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
    if (!el) {
      return { shipX: NaN, shipY: NaN, shipAngle: NaN, beamFromX: null, beamFromY: null, beamActive: false };
    }
    const ds = el.dataset;
    const beamActive = ds['beamActive'] === '1';
    return {
      shipX:     parseFloat(ds['shipX']     ?? 'NaN'),
      shipY:     parseFloat(ds['shipY']     ?? 'NaN'),
      shipAngle: parseFloat(ds['shipAngle'] ?? 'NaN'),
      beamFromX: ds['beamFromX'] !== undefined ? parseFloat(ds['beamFromX']) : null,
      beamFromY: ds['beamFromY'] !== undefined ? parseFloat(ds['beamFromY']) : null,
      beamActive,
    };
  });
}

test('local laser beam stays attached to ship pose during fire+rotation', async ({ browser }) => {
  // Lock-to-fire (2026-11-09): the beam fires only at a locked target, so a
  // second pilot (huge hull) sits 150 u dead ahead and the interceptor locks
  // it (instantLock) on its MAN group. The interceptor's beams are ±30°
  // turrets, so the ship WIGGLES (alternating short D / A holds, ≈ ±0.2 rad)
  // instead of spinning: ship.angle still changes every frame, and the
  // target stays inside the arc so the beam keeps firing.
  const testId = randomUUID();
  const [{ ctx, page }, victim] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: 0, initialAngle: 0, shipKind: 'interceptor', testId, instantLock: true }),
    launchTestClient(browser, { spawnX: 0, spawnY: 150, shipKind: 'fighter', testId, initialHull: 100_000 }),
  ]);
  try {
    const victimId = (await victim.page.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id')) ?? '';
    await toManual(page);
    await lockOn(page, { kind: 'ship', playerId: victimId });

    // Let the connection stabilise so prediction has had a few snapshots to
    // settle into a steady-state lerp cadence.
    await page.waitForTimeout(1500);

    await page.keyboard.down('Space');

    // Sample over ~2 seconds (~40 samples at 50 ms cadence) to cover at least
    // a handful of snapshot intervals (~167 ms each), turning every sample.
    const samples: BeamSample[] = [];
    const SAMPLE_COUNT = 40;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      // 3 samples (~150 ms) per direction, starting with half a swing.
      const key = Math.floor((i + 1.5) / 3) % 2 === 0 ? 'd' : 'a';
      await page.keyboard.down(key);
      await page.waitForTimeout(50);
      await page.keyboard.up(key);
      samples.push(await sampleBeam(page));
    }

    await page.keyboard.up('Space');

    // Filter to samples where the beam was active and the ship pose was valid.
    const active = samples.filter(
      (s) =>
        s.beamActive &&
        s.beamFromX !== null &&
        s.beamFromY !== null &&
        Number.isFinite(s.shipX) &&
        Number.isFinite(s.shipY) &&
        Number.isFinite(s.shipAngle),
    );
    expect(active.length).toBeGreaterThan(20);

    // For every active frame the renderer's beam-from MUST equal
    // ship + 20*forward(ship.angle) where forward = (-sin θ, cos θ).
    // 0.01 unit tolerance covers the 3-decimal toFixed rounding only — any
    // looser would mask a real bug.
    for (const s of active) {
      const expectedFromX = s.shipX + -Math.sin(s.shipAngle) * 20;
      const expectedFromY = s.shipY +  Math.cos(s.shipAngle) * 20;
      expect(Math.abs(s.beamFromX! - expectedFromX)).toBeLessThan(0.01);
      expect(Math.abs(s.beamFromY! - expectedFromY)).toBeLessThan(0.01);
    }

    // Sanity: the ship was actually rotating during the test (not stuck).
    const angles = active.map((s) => s.shipAngle);
    const minA = Math.min(...angles);
    const maxA = Math.max(...angles);
    expect(maxA - minA).toBeGreaterThan(0.1);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await Promise.all([ctx.close(), victim.ctx.close()]);
  }
});
