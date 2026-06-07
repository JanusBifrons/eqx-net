/**
 * Render-level regression lock for the LASER BEAM DETACH bug (Invariant #13, cause #1).
 *
 * USER REPORT (on-device smoke 2026-06-04..06; reproduced locally 2026-06-07,
 * diag/laser-repro/): "the lasers disconnect when shooting — the beam stays
 * stuck then catches up when I turn / fly. Fly forward and hold fire in an
 * engineering room → detaches consistently. No enemy required."
 *
 * ROOT CAUSE: `PixiRenderer`'s live-beam block gated `BeamSpritePool.setBeams(...)`
 * behind a `dirty` flag that compared this frame's endpoints to the PREVIOUS
 * frame's — but the cache slot was overwritten with the current pose every frame,
 * so the test measured per-frame DELTA, not drift-since-the-last-DRAW. Coasting
 * under BEAM_EPSILON (4 u/frame) never tripped `dirty`, `setBeams` was skipped, and
 * the DRAWN beam froze in world space while the ship flew on.
 *
 * WHY A PROBE PAGE (not the full game): the bug lives in `PixiRenderer.update()`.
 * Driving `update()` SYNCHRONOUSLY (one explicit call per frame) reproduces the
 * sub-4-u/frame freeze deterministically and reads the REAL drawn sprite via
 * `getLiveBeamTransform()` — NOT the `data-beam-from` recompute (that tracks the
 * ship perfectly while the sprite is frozen — the green-but-broken trap that let
 * prior "fixes" ship; see src/client/CLAUDE.md +
 * MEMORY[feedback-test-observable-reads-actual-output]). A full-game worker=0 E2E
 * is NOT usable as a headless CI lock: under headless software-WebGL the RAF
 * render loop runs far slower than wall-clock physics, so the drawn beam desyncs
 * from the ship regardless of the fix (verified: 121 u drift even on the FIXED
 * build headless, 3.9 u headed). The probe's synchronous `update()` is immune to
 * that — it reads the sprite's JS transform, which `setBeams` writes regardless of
 * GPU paint. The real-game proof is the visual capture in diag/laser-repro/.
 *
 * ASSERTION: lock the muzzle→ship offset at frame 0 (beam attached), then coast
 * the ship 1 u/frame (well under the 4 u/frame BEAM_EPSILON, where the bug bites)
 * for 80 frames. The drawn origin must stay glued to the ship (offset preserved).
 * With the bug the drawn origin freezes while the ship drifts → drift ≈ distance
 * travelled → RED. Fixed: tracks exactly (same pose fed + read synchronously) →
 * drift ≈ 0 → GREEN.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface BeamProbeApi {
  setShip: (x: number, y: number, angle: number) => void;
  setBeamActive: (active: boolean) => void;
  postFrame: () => void;
  getDrawnOrigin: () => { count: number; fromX: number; fromY: number } | null;
  getShip: () => { x: number; y: number; angle: number };
}
type ProbeWindow = { __beamProbe?: BeamProbeApi };

test('live beam origin tracks a coasting ship — drawn sprite, sub-4u/frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

  await page.goto(`${BASE_URL}/__offscreen-spike__/beam-render-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForFunction(() => !!(window as unknown as ProbeWindow).__beamProbe, { timeout: 15_000 });

  // Frame 0 — ship at origin, twin beams on → drawn at the muzzle. Lock the
  // true muzzle→ship offset (captured while correctly attached).
  const base = await page.evaluate(() => {
    const p = (window as unknown as ProbeWindow).__beamProbe!;
    p.setShip(0, 0, 0);
    p.setBeamActive(true);
    p.postFrame();
    return { drawn: p.getDrawnOrigin(), ship: p.getShip() };
  });
  expect(base.drawn, 'getLiveBeamTransform() must be non-null at frame 0').not.toBeNull();
  expect(base.drawn!.count, 'two wing beams should be drawn').toBeGreaterThanOrEqual(1);
  const off0x = base.drawn!.fromX - base.ship.x;
  const off0y = base.drawn!.fromY - base.ship.y;

  // Coast +y at 1 u/frame (sub-4-u/frame BEAM_EPSILON → the bug freezes the
  // beam) for 80 frames, each a synchronous render. The drawn origin must
  // track the ship: |(drawn − ship) − offset0| stays ~0.
  const result = await page.evaluate(
    ({ off0x, off0y }) => {
      const p = (window as unknown as ProbeWindow).__beamProbe!;
      let maxDrift = 0;
      let worst = '';
      let lastShipY = 0;
      for (let i = 1; i <= 80; i++) {
        p.setShip(0, i, 0);
        p.postFrame();
        const d = p.getDrawnOrigin();
        const s = p.getShip();
        lastShipY = s.y;
        if (!d) continue;
        const drift = Math.hypot(d.fromX - s.x - off0x, d.fromY - s.y - off0y);
        if (drift > maxDrift) {
          maxDrift = drift;
          worst = `frame ${i}: drawnOrigin=(${d.fromX.toFixed(1)},${d.fromY.toFixed(1)}) ship=(0,${s.y}) drift=${drift.toFixed(1)}u`;
        }
      }
      return { maxDrift, worst, lastShipY };
    },
    { off0x, off0y },
  );

  expect(errors, `probe page errors: ${errors.join('; ')}`).toEqual([]);
  expect(result.lastShipY, 'ship should have coasted 80 u').toBeGreaterThan(70);

  // The drawn beam origin must stay glued to the ship. With the dirty-cache bug
  // the drawn origin freezes while the ship drifts, so this ≈ distance travelled.
  expect(
    result.maxDrift,
    `drawn beam origin detached from the ship by ${result.maxDrift.toFixed(1)}u (tol 1u). ` +
      `The rendered beam is NOT tracking the ship — the dirty-cache gate is back. ${result.worst}`,
  ).toBeLessThan(1.0);
});
