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
 * 2026-11-08: the check is now MOUNT-aware. `data-beam-from-x/y` is the
 * ship NOSE (centre + 20 u), but the drawn beam starts at the first live
 * mount's barrel (wing mount pivot + 20 u along the slewing turret angle),
 * so comparing to the nose read a constant ~16 u "detach" on a correct
 * build. We now check the drawn origin lies 20 u from that mount's pivot,
 * using the ship pose from the SAME dataset write (a pose read from the live
 * mirror is a frame or two newer and read up to ~13 u off while coasting).
 * And the spec joined the live `sector` room, whose drones killed the
 * 120-hull interceptor mid-coast (respawn at 0,0, beam off): it now uses the
 * drone-free `test-sector`.
 *
 * Lock-to-fire (2026-11-09): fire needs a completed lock, so the old
 * "no enemy present" hold no longer fires at all. The spec now joins
 * `combat-drone-test` (one peaceful heavy parked at (0,200)) 300 u south of
 * the drone, facing it, WITHOUT `instantLock` (with it, AUTO targets anything
 * and destroys the hull-exposed drone within a second of joining); the group
 * goes MAN (so the beam
 * follows Space) and locks the drone, then the ship thrusts toward it and
 * coasts. The freeze mechanism under test is unchanged: the coast is still
 * sub-epsilon motion with the beam held.
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
import { waitForInPlay } from '../helpers/gameScenario';
import { lockOn, toManual } from '../helpers/fireControl';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getShipKind } from '../../../src/shared-types/shipKinds';
import { DEFAULT_BASE_URL } from '../helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

// `?worker=0` forces the main-thread PixiRenderer (the touch default), whose
// BeamSpritePool transform the feedback reads directly. `interceptor` mounts
// the twin hitscan beams the user reported.
// The join waits for the loading curtain (infrastructural), so 30 s is tight.
test.describe.configure({ timeout: 90_000 });

async function joinSector(page: Page): Promise<void> {
  await page.goto(
    `${BASE_URL}?room=combat-drone-test&spawnX=0&spawnY=-100&initialAngle=0&testId=${randomUUID()}&shipKind=interceptor&worker=0`,
  );
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    }, undefined,
    { timeout: 15000 },
  );
  // Input only counts once the loading curtain lifts.
  await waitForInPlay(page);
}

interface Sample {
  /** | |drawn origin − first live mount's pivot| − 20 |, from ONE frame's dataset. */
  detach: number | null;
  shipX: number;
  shipY: number;
  beamActive: boolean;
}

type MountGeom = { id: string; localX: number; localY: number };
const INTERCEPTOR_MOUNTS: MountGeom[] = getShipKind('interceptor').mounts.map((m) => ({
  id: m.id, localX: m.localX, localY: m.localY,
}));

/** Take `n` samples `everyMs` apart INSIDE the page: one round-trip, not two
 *  per sample. On a CPU-starved host (CI's small runners, the laptop with
 *  software WebGL) each driver round-trip took ~1 s, so 40 samples overran the
 *  90 s budget before any assertion ran. */
async function sampleMany(page: Page, n: number, everyMs: number): Promise<Sample[]> {
  return page.evaluate<Promise<Sample[]>, { mounts: MountGeom[]; n: number; everyMs: number }>(async ({ mounts, n, everyMs }) => {
  const one = (): Sample => {
    const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
    const ds = el?.dataset ?? ({} as DOMStringMap);
    const num = (v: string | undefined): number | null => (v !== undefined ? parseFloat(v) : null);
    const shipX = parseFloat(ds['shipX'] ?? 'NaN');
    const shipY = parseFloat(ds['shipY'] ?? 'NaN');
    const shipAngle = parseFloat(ds['shipAngle'] ?? 'NaN');
    const drawnX = num(ds['beamRenderedFromX']);
    const drawnY = num(ds['beamRenderedFromY']);
    // The renderer draws a live beam from its MOUNT pivot + 20 u along the
    // mount's (slewing) fire angle; the pool's rendered origin is slot 0 =
    // the first live beam. So the drawn origin sits exactly 20 u from that
    // mount's pivot whatever the turret angle. Every pose here comes from the
    // SAME dataset write as the drawn origin (one frame, no publish lag).
    type C = { mirror: { liveBeams?: Map<string, unknown> } };
    const firstMountId = (window as unknown as { __eqxClient?: C }).__eqxClient?.mirror.liveBeams?.keys().next().value as string | undefined;
    const m = mounts.find((mm) => mm.id === firstMountId);
    let detach: number | null = null;
    if (m && drawnX !== null && drawnY !== null && Number.isFinite(shipAngle)) {
      const cosA = Math.cos(shipAngle);
      const sinA = Math.sin(shipAngle);
      const px = shipX + (m.localX * cosA - m.localY * sinA);
      const py = shipY + (m.localX * sinA + m.localY * cosA);
      detach = Math.abs(Math.hypot(drawnX - px, drawnY - py) - 20);
    }
    return { detach, shipX, shipY, beamActive: ds['beamActive'] === '1' };
  };
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    await new Promise((res) => setTimeout(res, everyMs));
    out.push(one());
  }
  return out;
  }, { mounts: INTERCEPTOR_MOUNTS, n, everyMs });
}

test('drawn beam origin tracks the ship while coasting (no render-cache freeze)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await joinSector(page);
    // MAN so the beam follows Space, then lock the parked drone ahead.
    await toManual(page);
    await page.waitForTimeout(1500); // let prediction settle into steady-state cadence
    await lockOn(page, 'first-drone');

    // Hold manual fire on the locked drone. Tap thrust (toward the drone) then
    // RELEASE so the ship COASTS:
    // linear damping decays speed below 4 u/frame, which is exactly the
    // sub-epsilon motion the old dirty-cache froze the drawn beam through.
    await page.keyboard.down('Space');
    await page.keyboard.down('w');
    await page.waitForTimeout(250);
    await page.keyboard.up('w');

    const samples = await sampleMany(page, 40, 50);
    await page.keyboard.up('Space');

    const active = samples.filter(
      (s) =>
        s.beamActive &&
        s.detach !== null &&
        Number.isFinite(s.shipX) && Number.isFinite(s.shipY),
    );
    // The beam destroys the parked drone after ~0.85 s (2026-11-12: 17 of 40
    // samples active, then `mirror.swarm` held no drone), and with no target
    // it rightly stops. The freeze under test shows in the coasting frames
    // the beam IS drawn, so judge those: enough of them to exercise it.
    expect(active.length, 'beam should be active for a stretch of the coast').toBeGreaterThanOrEqual(10);

    // The DRAWN beam origin must sit on its mount's 20 u muzzle circle every
    // frame. A few units of tolerance covers the toFixed rounding; the bug
    // detaches by tens of units as the ship glides away from the frozen
    // drawn beam.
    let maxDetach = 0;
    for (const s of active) maxDetach = Math.max(maxDetach, s.detach!);
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
