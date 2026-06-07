/**
 * Laser-beam render-cache detach regression (smoke handoff 2026-06-06,
 * Issue 1 Bug #1).
 *
 * User report: "Interceptor laser appears stuck/detached — the beam stays
 * put then catches up when I turn or fly, and it happens with NO enemy
 * present." Repro: fly/coast while holding fire in an engineering room.
 *
 * Root cause: `PixiRenderer`'s live-beam block gated `setBeams(...)` behind
 * a per-frame `BEAM_EPSILON = 4.0` dirty-cache that compared the CURRENT
 * frame's pose to the PREVIOUS frame (the cache was overwritten every
 * frame), NOT to the last DRAWN frame. Coasting under 4 u/frame never
 * tripped `dirty`, so `setBeams` was never called and the DRAWN beam froze
 * in place while the ship glided on. Fix: always call `setBeams`.
 *
 * ── Why this observable (Invariant #13: read where the bug LIVES) ──
 * `data-beam-from-x/y` RECOMPUTES the origin from the live ship pose in
 * `gameRafLoop`, so it tracks the ship perfectly and PASSES EVEN WHEN THE
 * DRAWN BEAM IS FROZEN — using it is the green-but-broken trap. The real
 * artifact is `data-beam-rendered-from-x/y`, published from
 * `RendererFeedback.liveBeamRenderedFromX/Y` ← the actual `BeamSpritePool`
 * sprite transform. We assert the DRAWN origin tracks the recompute within
 * a small tolerance across a coast. Under the bug the drawn origin freezes
 * while the recompute glides away → large divergence → FAIL.
 *
 * ── Proving RED (next agent, on a browser host) ──
 * Temporarily restore the `if (dirty)` gate in PixiRenderer's live-beam
 * block → this spec must fail with a CLEAN assertion ("drawn beam origin
 * detached by N u"), NOT a 30 s timeout. If it times out under `worker=0`
 * software-WebGL, the new feedback field is threaded through the worker
 * FEEDBACK message (renderer.worker.ts + WorkerRendererClient), so dropping
 * the `?worker=0` override and using the default worker renderer is the
 * faster fallback.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// `?worker=0` forces the main-thread PixiRenderer (the touch default), whose
// BeamSpritePool transform the feedback reads directly. `interceptor` mounts
// the twin hitscan beams the user reported.
async function joinSector(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}?room=sector&shipKind=interceptor&worker=0`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15000 },
  );
}

interface Sample {
  recomputeX: number | null;
  recomputeY: number | null;
  drawnX: number | null;
  drawnY: number | null;
  shipX: number;
  shipY: number;
  beamActive: boolean;
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate<Sample>(() => {
    const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
    const ds = el?.dataset ?? ({} as DOMStringMap);
    const num = (v: string | undefined): number | null => (v !== undefined ? parseFloat(v) : null);
    return {
      recomputeX: num(ds['beamFromX']),
      recomputeY: num(ds['beamFromY']),
      drawnX: num(ds['beamRenderedFromX']),
      drawnY: num(ds['beamRenderedFromY']),
      shipX: parseFloat(ds['shipX'] ?? 'NaN'),
      shipY: parseFloat(ds['shipY'] ?? 'NaN'),
      beamActive: ds['beamActive'] === '1',
    };
  });
}

test('drawn beam origin tracks the ship while coasting (no render-cache freeze)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await joinSector(page);
    await page.waitForTimeout(1500); // let prediction settle into steady-state cadence

    // Hold manual fire (override — engages even with no hostile in range, the
    // user's no-enemy repro). Tap thrust then RELEASE so the ship COASTS:
    // linear damping decays speed below 4 u/frame, which is exactly the
    // sub-epsilon motion the old dirty-cache froze the drawn beam through.
    await page.keyboard.down('Space');
    await page.keyboard.down('w');
    await page.waitForTimeout(250);
    await page.keyboard.up('w');

    const samples: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(50);
      samples.push(await sample(page));
    }
    await page.keyboard.up('Space');

    const active = samples.filter(
      (s) =>
        s.beamActive &&
        s.drawnX !== null && s.drawnY !== null &&
        s.recomputeX !== null && s.recomputeY !== null &&
        Number.isFinite(s.shipX) && Number.isFinite(s.shipY),
    );
    expect(active.length, 'beam should be active for most coast frames').toBeGreaterThan(20);

    // The DRAWN beam origin must equal the live recompute every frame. A few
    // units of tolerance covers the ≤1-frame publish/draw ordering lag and
    // the toFixed(3) rounding; the bug detaches by tens of units as the ship
    // glides away from the frozen drawn beam.
    let maxDetach = 0;
    for (const s of active) {
      const dx = s.drawnX! - s.recomputeX!;
      const dy = s.drawnY! - s.recomputeY!;
      maxDetach = Math.max(maxDetach, Math.hypot(dx, dy));
    }
    expect(maxDetach, `drawn beam origin detached from the live ship by ${maxDetach.toFixed(1)} u`).toBeLessThan(6);

    // Sanity: the ship actually MOVED during the coast (else the test would
    // pass trivially — a frozen beam on a stationary ship can't detach).
    const xs = active.map((s) => s.shipX);
    const ys = active.map((s) => s.shipY);
    const travelled = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    expect(travelled, 'ship must coast a meaningful distance to exercise the freeze').toBeGreaterThan(30);
  } finally {
    await ctx.close();
  }
});
