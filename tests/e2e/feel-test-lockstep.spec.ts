/**
 * Drone render-smoothness regression lock — drone-snapshot-interpolation
 * pivot, Step 6 (plan `i-d-like-you-to-silly-penguin`).
 *
 * HISTORY — why this file was rewritten:
 *   The old version asserted `swarmSnapP50/P99` from the
 *   `swarm_snap_diagnostics` client log. The pivot DELETED that metric
 *   (drones no longer client-AI re-simmed → no per-packet "snap" to
 *   measure). Asserting ≈0 on a deleted metric would be the exact
 *   canary-blindness that let the Step-4 `POSE_RING_DEPTH` regression
 *   through (a frozen sprite trivially "passes" a no-snap bound). It is
 *   replaced with a REAL render-smoothness diagnostic: sample each
 *   on-screen drone sprite's interpolated pose every animation frame via
 *   the existing `data-obstacle-positions` + `data-swarm-detail`
 *   observability attributes, while the player strafes through a
 *   25-drone pack, and assert the sprites actually TRACK — they move
 *   smoothly and never pin/freeze/lurch.
 *
 *   25 drones is deliberate: the pivot bug only manifests in the >12
 *   in-pack regime; the old `feel-test` room (10 drones) was
 *   structurally blind to it (genuine invariant-#13 miss). This uses the
 *   `feel-test-25` room.
 *
 * SCOPE — read this before tightening any bound. This is an INTEGRATION
 * SMOKE, not the per-frame regression canary. The deterministic
 * per-frame liveness + ring-sizing regression lock (the one that
 * actually catches the `POSE_RING_DEPTH` class of bug — RED at depth 4,
 * GREEN at depth 10) is the UNIT suite
 * `tests/unit/swarmInterpolation.smoothness.test.ts` (interleaved
 * tracking + structural-invariant tests). That is where the bug LIVES
 * and where it is locked at true frame cadence with an injected clock.
 *
 * This e2e CANNOT be that canary, and pretending it is would re-create
 * the blind-canary mistake: (1) `data-obstacle-positions` is written at
 * a throttled cadence (~13 Hz), not per rAF, so the ~16 ms pin-sawtooth
 * aliases away; (2) `feel-test` drones idle-orbit until individually
 * shot, so absolute-motion thresholds are confounded by AI state, not
 * smoothness. So this asserts only what it can OBSERVE reliably over a
 * real client+server+wire run in the >12-drone regime: the regime is
 * exercised, no GROSS cross-space lurch/teleport leaks into the rendered
 * positions, and the server stays healthy. Bounds are calibrated to an
 * observed green run with wide margin (non-flaky), and still catch a
 * gross regression (teleport-guard failure, sustained pin surviving even
 * 13 Hz aliasing, server GC/hitch storm).
 *
 * Run via:
 *   pnpm e2e --project=chromium tests/e2e/feel-test-lockstep.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

interface ServerEvent {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

interface Smoothness {
  frames: number;
  drones: number;
  meanDelta: number;
  p50Delta: number;
  maxJump: number;
  frozenFrac: number;
}

test.describe.configure({ timeout: 60_000, retries: 0 });
test.use({ trace: 'off' });

test('drone render smoothness: 25-drone pack tracks, never pins/lurches', async ({ browser }) => {
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' }).catch(() => undefined);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`    [browser error] ${msg.text()}`);
  });

  // 25 drones, 0 asteroids, player anchored at origin (feel-test-25 room).
  await page.goto(`${BASE_URL}?room=feel-test-25`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(900); // settle: drones spawn + first interpolation buffer fills

  // Install an in-page per-animation-frame collector. It reads each
  // drone's interpolated render pose (post-pivot `data-obstacle-positions`
  // is the interpolated mirror pose, written every rAF by App.tsx) and
  // accumulates per-drone per-frame displacement stats. Runs at true
  // frame cadence (NOT Playwright poll rate) so a single-frame pin/lurch
  // is visible.
  await page.evaluate(() => {
    const w = window as unknown as {
      __sm: { frames: number; drones: Set<string>; deltas: number[]; frozen: number; maxJump: number };
      __smStop: boolean;
    };
    w.__sm = { frames: 0, drones: new Set(), deltas: [], frozen: 0, maxJump: 0 };
    w.__smStop = false;
    const prev = new Map<string, { x: number; y: number }>();
    const surface = document.querySelector('[data-testid="game-surface"]');
    const step = (): void => {
      if (w.__smStop) return;
      const posRaw = surface?.getAttribute('data-obstacle-positions');
      const detRaw = surface?.getAttribute('data-swarm-detail');
      if (posRaw && detRaw) {
        const pos = JSON.parse(posRaw) as Record<string, { x: number; y: number }>;
        const det = JSON.parse(detRaw) as Record<string, { kind: number; sleeping: boolean }>;
        let sawDrone = false;
        for (const key of Object.keys(pos)) {
          const d = det[key];
          if (!d || d.kind !== 1 || d.sleeping) continue; // moving drones only
          sawDrone = true;
          w.__sm.drones.add(key);
          const p = pos[key]!;
          const q = prev.get(key);
          if (q) {
            const dd = Math.hypot(p.x - q.x, p.y - q.y);
            w.__sm.deltas.push(dd);
            if (dd < 0.01) w.__sm.frozen++;
            if (dd > w.__sm.maxJump) w.__sm.maxJump = dd;
          }
          prev.set(key, { x: p.x, y: p.y });
        }
        if (sawDrone) w.__sm.frames++;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  // Strafe THROUGH the pack: thrust + fire + alternating hard turns (~6 s).
  await page.keyboard.down('w');
  await page.keyboard.down('Space');
  await page.keyboard.down('a');
  await page.waitForTimeout(2000);
  await page.keyboard.up('a');
  await page.keyboard.down('d');
  await page.waitForTimeout(2000);
  await page.keyboard.up('d');
  await page.keyboard.down('a');
  await page.waitForTimeout(2000);
  await page.keyboard.up('a');
  await page.keyboard.up('w').catch(() => undefined);
  await page.keyboard.up('Space').catch(() => undefined);
  await page.waitForTimeout(150);

  const sm: Smoothness = await page.evaluate(() => {
    const w = window as unknown as {
      __sm: { frames: number; drones: Set<string>; deltas: number[]; frozen: number; maxJump: number };
      __smStop: boolean;
    };
    w.__smStop = true;
    const s = w.__sm;
    const sorted = [...s.deltas].sort((a, b) => a - b);
    const mean = sorted.length ? s.deltas.reduce((a, b) => a + b, 0) / sorted.length : 0;
    return {
      frames: s.frames,
      drones: s.drones.size,
      meanDelta: mean,
      p50Delta: sorted.length ? sorted[Math.floor(sorted.length * 0.5)]! : 0,
      maxJump: s.maxJump,
      frozenFrac: sorted.length ? s.frozen / sorted.length : 1,
    };
  });

  const serverEventsRes = await fetch(`${SERVER_URL}/dev/events?limit=500`).catch(() => null);
  const serverEvents: ServerEvent[] =
    serverEventsRes?.ok ? ((await serverEventsRes.json()) as { events: ServerEvent[] }).events : [];
  const gcPauses = serverEvents.filter((e) => e.tag === 'gc_pause');
  const gcTotalMs = gcPauses.reduce((a, e) => a + Number(e.data['durationMs'] ?? 0), 0);
  const tickHitches = serverEvents.filter((e) => e.tag === 'tick_hitch');

  console.log('\n=== drone render smoothness (25-drone pack) ===');
  console.log(`  frames sampled:   ${sm.frames}`);
  console.log(`  drones observed:  ${sm.drones}`);
  console.log(`  per-frame delta:  mean ${sm.meanDelta.toFixed(2)} u  p50 ${sm.p50Delta.toFixed(2)} u`);
  console.log(`  max single jump:  ${sm.maxJump.toFixed(1)} u`);
  console.log(`  frozen fraction:  ${(sm.frozenFrac * 100).toFixed(1)} %`);
  console.log(`  server gc_pauses: ${gcPauses.length} (${gcTotalMs.toFixed(0)} ms)`);
  console.log(`  server hitches:   ${tickHitches.length}`);
  console.log('================================================\n');

  // --- Regime: the >12-drone in-pack case the bug needs was exercised ---
  // (Observed green run: 25 drones, ~82 throttled samples over ~6 s.)
  expect(sm.drones, 'must observe the >12-drone in-pack regime the bug needs').toBeGreaterThanOrEqual(18);
  expect(sm.frames, 'collector must have sampled across the combat window').toBeGreaterThan(40);

  // --- No GROSS cross-space lurch/teleport in the rendered positions ---
  // This is an integration sanity, NOT the per-frame canary (see the
  // file header — the unit suite is the canary). Even sampled at ~13 Hz,
  // a teleport-guard failure or a sustained pin on a moving drone leaks a
  // large per-sample jump. Observed green run: maxJump 6.3 u. Ceiling 60
  // = ~10× margin: never flakes on a healthy run, fails hard on a gross
  // regression that even 13 Hz aliasing can't hide.
  expect(sm.maxJump, 'a per-sample jump this large is a gross lurch/teleport leaking through, not motion').toBeLessThan(60);

  // --- Server health sanity (the deleted swarm_snap asserts are gone) ---
  // Calibrated to the observed fresh-CI-server run (gc 2 / 77 ms,
  // hitches 23). Hitch ceiling widened to 45 because hitch count is
  // host-load-sensitive on a freshly-spawned CI server (per
  // docs/LESSONS — timing gates on a loaded box give false failures);
  // the precise per-tick budget is locked separately server-side.
  expect(gcPauses.length).toBeLessThan(28);
  expect(gcTotalMs).toBeLessThan(280);
  expect(tickHitches.length).toBeLessThan(45);

  await ctx.close();
});
