import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Engine-exhaust VISUAL probe (screenshot-first). Drives the
 * `engine-particles-probe.html` page — a real main-thread `PixiRenderer`
 * fed a single ship at a controllable heading + velocity — and captures the
 * plume at fixed scenarios into `diag/e2e-screenshots/engine-particles/`.
 *
 * This is NOT a pixel-assertion test; it's the casual-verification artifact
 * the user asked for. An agent reads the PNGs back to judge each fix step:
 *   - mirror: exhaust on the correct side for a diagonal ship (Step 1)
 *   - nozzle: plume hugs the stern with width (Step 2)
 *   - speed:  no arc/circle when fast; plume thickens with speed (Step 3)
 *   - polish: additive hot-core + colour-over-life (Step 5)
 *
 * The screenshot NAME PREFIX is parameterised by `STEP` so re-running after
 * each fix produces `baseline-*`, `step1-*`, ... side by side for comparison.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
/** Screenshot name prefix. Override per fix-step for side-by-side comparison:
 *  `ENGINE_FX_STEP=baseline pnpm exec playwright test …`. The neutral default
 *  keeps the committed/CI artifact name stable. */
const STEP = process.env['ENGINE_FX_STEP'] ?? 'current';
/** Camera zoom for the probe (higher = closer). Tune so stern detail is legible. */
const ZOOM = 3;
const OUT_DIR = join(process.cwd(), 'diag', 'e2e-screenshots', 'engine-particles');

interface EngineProbeApi {
  setShip: (x: number, y: number, angle: number, kind?: string) => void;
  setVelocity: (vx: number, vy: number) => void;
  setThrust: (on: boolean) => void;
  setBoost: (on: boolean) => void;
  runFor: (ms: number) => Promise<void>;
  reset: () => void;
  debug: () => { ship: { x: number; y: number; vx: number; vy: number }; particles: number[] } | null;
}
interface ProbeWindow extends Window {
  __engineProbe?: EngineProbeApi;
}

async function captureProbe(page: Page, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUT_DIR, `${STEP}-${name}.png`), fullPage: false });
}

test('engine exhaust visual matrix', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

  await page.goto(`${BASE_URL}/__offscreen-spike__/engine-particles-probe.html?zoom=${ZOOM}`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__engineProbe !== undefined,
    { timeout: 15_000 },
  );

  // Diagonal heading (π/4). Forward = (-sin, cos); the exhaust must emerge
  // ASTERN = (+sin, -cos) = down-right. With the X-mirror bug the plume
  // appears on the wrong (up-left-ish) side instead.
  const DIAG = Math.PI / 4;
  // Velocity along the forward heading at ~600 u/s (well above the legacy
  // 60-100 u/s ejection → exposes the "arc/circle when fast" deposit).
  const FWD_VX = -Math.SQRT1_2 * 600;
  const FWD_VY = Math.SQRT1_2 * 600;

  // 1) Diagonal, stationary, thrust — isolates the MIRROR (which side).
  await page.evaluate(
    async ({ a }) => {
      const p = (window as unknown as ProbeWindow).__engineProbe!;
      p.reset();
      p.setShip(0, 0, a, 'fighter');
      p.setVelocity(0, 0);
      p.setThrust(true);
      await p.runFor(700);
    },
    { a: DIAG },
  );
  await captureProbe(page, 'diag-still');

  // 2) Diagonal, fast — isolates the "circle/arc when moving fast".
  await page.evaluate(
    async ({ a, vx, vy }) => {
      const p = (window as unknown as ProbeWindow).__engineProbe!;
      p.reset();
      p.setShip(0, 0, a, 'fighter');
      p.setVelocity(vx, vy);
      p.setThrust(true);
      await p.runFor(900);
    },
    { a: DIAG, vx: FWD_VX, vy: FWD_VY },
  );
  await captureProbe(page, 'diag-fast');

  // 3) Diagonal, fast, boost — the boost plume.
  await page.evaluate(
    async ({ a, vx, vy }) => {
      const p = (window as unknown as ProbeWindow).__engineProbe!;
      p.reset();
      p.setShip(0, 0, a, 'fighter');
      p.setVelocity(vx, vy);
      p.setThrust(true);
      p.setBoost(true);
      await p.runFor(900);
    },
    { a: DIAG, vx: FWD_VX, vy: FWD_VY },
  );
  await captureProbe(page, 'diag-boost');

  // 4) Axis-aligned control (angle 0) — the mirror is INVISIBLE here (sin 0),
  //    so this frame should look the same before AND after the mirror fix.
  await page.evaluate(async () => {
    const p = (window as unknown as ProbeWindow).__engineProbe!;
    p.reset();
    p.setShip(0, 0, 0, 'fighter');
    p.setVelocity(0, 0);
    p.setThrust(true);
    await p.runFor(700);
  });
  await captureProbe(page, 'axis-still');

  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * Regression lock for the wrong-side-at-speed bug (smoke-reported 2026-06-07,
 * Invariant #13). The Step-3 velocity-inheritance "streaming" rendered the
 * exhaust on the FORWARD side at high ship speed (probe + real-game 472 u/s).
 * This reads the particles' WORLD positions (camera-independent ground truth)
 * and asserts EVERY particle is astern of a fast-moving ship. RED on the
 * inheritance code, GREEN after it's removed (pure astern ejection).
 */
test('exhaust stays astern at high ship speed (no forward bug)', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto(`${BASE_URL}/__offscreen-spike__/engine-particles-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__engineProbe !== undefined,
    { timeout: 15_000 },
  );
  const result = await page.evaluate(async () => {
    const p = (window as unknown as ProbeWindow).__engineProbe!;
    p.reset();
    p.setShip(0, 0, 0, 'fighter'); // angle 0 = facing +y (up); astern = -y (down)
    p.setVelocity(0, 600); // fast forward (up) — the regime that rendered wrong
    p.setThrust(true);
    await p.runFor(700);
    const d = p.debug();
    if (!d) return { n: 0, astern: 0, forward: 0 };
    // particles = [gfxX, gfxY, vx, vy, ...]. gfx.y = -gameY. For an up-facing
    // ship, ASTERN = gameY < shipGameY = gfx.y > ship.gfx.y.
    let astern = 0;
    let forward = 0;
    for (let i = 0; i < d.particles.length; i += 4) {
      if (d.particles[i + 1]! > d.ship.y) astern++;
      else forward++;
    }
    return { n: d.particles.length / 4, astern, forward };
  });
  // eslint-disable-next-line no-console
  console.log('EXHAUST-SIDE', JSON.stringify(result));
  expect(result.n, 'expected some particles to exist').toBeGreaterThan(0);
  expect(result.forward, 'every exhaust particle must be ASTERN of a fast ship').toBe(0);
});
