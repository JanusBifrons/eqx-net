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
 * ship sprite uses. This test holds Space + D to fire while continuously
 * rotating, samples ship pose and beam-from across many frames, and asserts
 * the relationship `beam.from === ship + 20*forward(ship.angle)` holds at
 * every sample. If anyone reverts the beam to cache its origin, the
 * arithmetic relationship will start drifting during corrections and this
 * test will fail.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// Use the ?room= auto-join URL so this test bypasses the auth gate (LoginPage)
// the same way preserved E2E test compatibility was originally designed.
async function joinSector(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}?room=sector`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15000 },
  );
}

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
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await joinSector(page);

    // Let the connection stabilise so prediction has had a few snapshots to
    // settle into a steady-state lerp cadence.
    await page.waitForTimeout(1500);

    // Fire continuously while turning right — the rotation forces ship.angle
    // to change every frame, exercising the case where the beam's direction
    // must also update every frame.
    await page.keyboard.down('Space');
    await page.keyboard.down('d');

    // Sample over ~2 seconds (~40 samples at 50 ms cadence) to cover at least
    // a handful of snapshot intervals (~167 ms each).
    const samples: BeamSample[] = [];
    const SAMPLE_COUNT = 40;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      await page.waitForTimeout(50);
      samples.push(await sampleBeam(page));
    }

    await page.keyboard.up('d');
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
    await ctx.close();
  }
});
