/**
 * Ramming probe — ball-vs-polygon steady-state penetration regression lock
 * (2026-05-28).
 *
 * User report (smoke 2026-05-28): "I was persistently shield inside the
 * drone... I flew like half way (if my ship) into it." Capture
 * `2026-05-28T15-13-11Z-vqm6y1` confirms the diagnosis: with the L spawned
 * at math (0, 0) angle π/4, hull exposed (8-triangle compound from the
 * 6-vertex polygon decomposition), the player flies thrust-forward into
 * the armpit and the ball collider settles 50-160 u INSIDE the polygon's
 * solid mass in steady-state contact. visVsPhys is small (median 0.34 u)
 * — the visual matches the physics, so the user is seeing the BALL
 * ACTUALLY DEEP IN THE POLYGON, not a render offset.
 *
 * Root cause: Rapier 2D default `contact_erp = 0.2` + `numSolverIterations
 * = 4` are too soft to overcome continuous player thrust pressing the ball
 * into a flat polygon edge. Per-tick thrust force ≈ thrustImpulse / dt
 * (~9000 N for a fighter) vs the constraint's spring-pull, which is gentle
 * by default to avoid instability in general gameplay.
 *
 * Scenario:
 *   - L-shape drone at math (0, 0), angle π/4, mass 50, hull exposed.
 *     Polygon decomposes into 2 convex parts (vertical arm rectangle +
 *     horizontal arm rectangle) — each fan-triangulates into triangle
 *     colliders inside `setHullExposed`. After the Y-flip + π/4 rotation,
 *     the armpit's reflex sits at math ≈ (0, -85); the vertical arm
 *     extends toward world (-Y, -Y); the horizontal arm toward world
 *     (+Y, -Y).
 *   - Local player spawns at math (0, 500), facing math -Y (`initialAngle
 *     = π`). Thrust + boost forward → flies straight into the armpit.
 *
 * Regression-lock metric: BODY-LOCAL penetration depth into the L's two
 * polygon arms. The vertical arm's right edge is at body-local x = -600;
 * the horizontal arm's top edge is at body-local y = -600. Ball radius is
 * 22 u, so the deepest valid contact point is body_x = -578 (vertical
 * arm) or body_y = -578 (horizontal arm). Anything past that is real
 * solver penetration.
 *
 * On current HEAD this test FAILS — median penetration is 58 u, max 159 u.
 * After the integration-parameters tuning (see `PhysicsWorld.create`) the
 * median should drop to a few u and max to < 30 u.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['EQX_SERVER_URL'] ?? 'http://localhost:2567';

interface ProbeEntry {
  ts: number;
  tag: string;
  data: {
    inputTick: number;
    physPos: { x: number; y: number };
    physVel: { x: number; y: number };
    physSpd: number;
    visPos: { x: number; y: number };
    drOffset: { x: number; y: number };
    lerpOffset: { x: number; y: number };
    droneId: number;
    dronePos: { x: number; y: number };
    droneShieldDown: boolean;
    droneKind: string | null;
    physDist: number;
    visDist: number;
    visVsPhys: number;
  };
}

test.setTimeout(60_000);

test('@diag ramming probe — fly into L-shape armpit at full thrust', async ({ browser }) => {
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });

  const testId = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // initialAngle = π → forward is math -Y → thrust takes the player
  // straight down (in math) into the armpit at (400, -600).
  // `autocapture=1` streams the diag NDJSON to disk so we can post-mortem
  // any future regression from the server-side trail too.
  await page.goto(
    `${BASE_URL}?room=ramming-probe-test&testId=${testId}&initialAngle=${Math.PI}&autocapture=1`,
  );

  // Wait for the L to be live and for the player to be on the map.
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="ship-count"]')?.textContent?.replace(/[^0-9]/g, '') ?? '0',
        10,
      ) >= 1
      && parseInt(
        document.querySelector('[data-testid="swarm-count"]')?.textContent?.replace(/[^0-9]/g, '') ?? '0',
        10,
      ) >= 1,
    { timeout: 15_000 },
  );

  // Let the initial-spawn lerp finish so the visual is at predWorld
  // before we start ramming (otherwise the early lerp dominates the
  // visVsPhys signal we're trying to measure).
  await page.waitForFunction(
    () => {
      const raw = document
        .querySelector('[data-testid="game-surface"]')
        ?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        const stats = JSON.parse(raw) as { snapshotCount?: number };
        return (stats.snapshotCount ?? 0) >= 30;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  );

  // Clear any noise events from the spawn window — we want only probe
  // entries from the actual ramming phase.
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });

  // Tap into the canvas so keyboard input is routed to the game (some
  // browsers need a click to attach keyboard focus to the page).
  await page.locator('[data-testid="game-surface"]').click();

  // Hold W (thrust) + Shift (boost) for 8 seconds. From spawn at
  // math (500, 500) with initialAngle=π, full thrust covers the
  // ~1100-unit gap to the L's horizontal arm top (at math y = -600)
  // in ~5-6 seconds. The remaining 2-3 seconds capture STEADY-STATE
  // CONTACT — the player pressed against the L's edge with thrust
  // still applied. That's the regime where visual-vs-physics
  // divergence matters most (and where the user reported "fly far
  // inside").
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await page.waitForTimeout(8000);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');

  // Brief settle.
  await page.waitForTimeout(500);

  // `logEvent` writes to the CLIENT-side ring buffer (`window.__eqxLogs`),
  // not the server's `/dev/events`. Read it directly via page.evaluate.
  const allLogs = (await page.evaluate(() => (window as unknown as { __eqxLogs?: ProbeEntry[] }).__eqxLogs ?? [])) as ProbeEntry[];
  const probes = allLogs.filter((e) => e.tag === 'ramming_probe');

  console.log(`\n=== Ramming probe — ${probes.length} frames captured ===`);

  if (probes.length === 0) {
    console.log('NO PROBE EVENTS. Either the player never got within 400u of the drone, or the probe is not wired correctly.');
  } else {
    // Histogram of visVsPhys.
    const buckets = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    const counts = new Array<number>(buckets.length + 1).fill(0);
    let maxV = 0;
    let maxFrame: ProbeEntry | null = null;
    for (const p of probes) {
      const v = p.data.visVsPhys;
      if (v > maxV) {
        maxV = v;
        maxFrame = p;
      }
      let placed = false;
      for (let i = 0; i < buckets.length; i++) {
        if (v < buckets[i]!) {
          counts[i]!++;
          placed = true;
          break;
        }
      }
      if (!placed) counts[counts.length - 1]!++;
    }
    console.log('visVsPhys distribution:');
    for (let i = 0; i < buckets.length; i++) {
      console.log(`  < ${buckets[i]!.toString().padStart(4)} u : ${counts[i]}`);
    }
    console.log(`  >=${buckets[buckets.length - 1]!.toString().padStart(4)} u : ${counts[counts.length - 1]}`);
    console.log(`\nPEAK visVsPhys = ${maxV.toFixed(2)} u`);

    if (maxFrame) {
      console.log('Peak frame:');
      console.log(JSON.stringify(maxFrame.data, null, 2));
    }

    // Compute average drOffset (dead-reckon contribution) and average
    // lerpOffset magnitude — the two known sources of visual lead.
    let totalDr = 0;
    let totalLerp = 0;
    let totalSpd = 0;
    for (const p of probes) {
      const dr = Math.hypot(p.data.drOffset.x, p.data.drOffset.y);
      const lp = Math.hypot(p.data.lerpOffset.x, p.data.lerpOffset.y);
      totalDr += dr;
      totalLerp += lp;
      totalSpd += p.data.physSpd;
    }
    console.log(`\nAvg dead-reckon offset magnitude : ${(totalDr / probes.length).toFixed(2)} u`);
    console.log(`Avg lerp offset magnitude        : ${(totalLerp / probes.length).toFixed(2)} u`);
    console.log(`Avg player speed                 : ${(totalSpd / probes.length).toFixed(1)} u/s`);

    // Player path summary — first/middle/last frame's pose so we can
    // see where the player ended up vs the L. For the L spawn at
    // math (0, 0), the horizontal arm's top edge (the expected contact
    // point) is at math y = -600.
    const f0 = probes[0]!;
    const fMid = probes[Math.floor(probes.length / 2)]!;
    const fLast = probes[probes.length - 1]!;
    console.log('\nPath summary:');
    console.log(`  start  (tick ${f0.data.inputTick}): physPos = (${f0.data.physPos.x}, ${f0.data.physPos.y}), spd = ${f0.data.physSpd}`);
    console.log(`  middle (tick ${fMid.data.inputTick}): physPos = (${fMid.data.physPos.x}, ${fMid.data.physPos.y}), spd = ${fMid.data.physSpd}`);
    console.log(`  end    (tick ${fLast.data.inputTick}): physPos = (${fLast.data.physPos.x}, ${fLast.data.physPos.y}), spd = ${fLast.data.physSpd}`);

    // Look for STEADY-STATE CONTACT — frames where the player has low
    // velocity AND is near the horizontal arm top (math y near -600).
    const contactFrames = probes.filter(
      (p) => Math.abs(p.data.physPos.y - -600) < 100 && p.data.physSpd < 50,
    );
    if (contactFrames.length > 0) {
      console.log(`\n${contactFrames.length} frames at steady-state contact (|y - (-600)| < 100 AND spd < 50):`);
      for (const f of contactFrames.slice(0, 5)) {
        console.log(JSON.stringify(f.data));
      }
    } else {
      console.log('\nNO STEADY-STATE CONTACT FRAMES — player did not get stopped at the L (tunneling? collider missing? hull regen?).');
    }
  }
  console.log('=============================================\n');

  // Soft assertion: at minimum we should have captured SOME probe
  // entries. If none were captured, the wiring is broken.
  expect(probes.length, 'expected at least 30 probe entries in the ramming window').toBeGreaterThan(30);

  // ---- Regression-lock assertion: body-local ball-vs-polygon penetration ----
  // The L is spawned at angle π/4 in `ramming-probe-test` (server room
  // config). To get body-local position we rotate the world delta by -π/4
  // (CW). Polygon edges in body-local: vertical arm right edge at x = -600,
  // horizontal arm top edge at y = -600. Ball radius is 22 u (kind.radius
  // 190 + SHIELD_RADIUS_PAD 10 = 200 for the L, but the PLAYER's ball is
  // 22 u — see `PhysicsWorld.spawnShip`). Deepest valid contact:
  // body_x = -578 (vertical) or body_y = -578 (horizontal); past that is
  // real resolver penetration.
  const cosA = Math.cos(-Math.PI / 4);
  const sinA = Math.sin(-Math.PI / 4);
  const PLAYER_BALL_RADIUS = 22;
  const ARM_INNER_EDGE = -600;
  const penetrations: number[] = [];
  for (const p of probes) {
    const dx = p.data.physPos.x - p.data.dronePos.x;
    const dy = p.data.physPos.y - p.data.dronePos.y;
    const bx = dx * cosA - dy * sinA;
    const by = dx * sinA + dy * cosA;
    const vPen = Math.max(0, ARM_INNER_EDGE + PLAYER_BALL_RADIUS - bx); // -578 - bx
    const hPen = Math.max(0, ARM_INNER_EDGE + PLAYER_BALL_RADIUS - by); // -578 - by
    penetrations.push(Math.max(vPen, hPen));
  }
  penetrations.sort((a, b) => a - b);
  const qq = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(a.length * q))]!;
  const penMedian = qq(penetrations, 0.5);
  const penP95 = qq(penetrations, 0.95);
  const penMax = qq(penetrations, 1.0);
  console.log(`\nBall-into-polygon penetration depth (body-local, both arms):`);
  console.log(`  median : ${penMedian.toFixed(2)} u`);
  console.log(`  p95    : ${penP95.toFixed(2)} u`);
  console.log(`  max    : ${penMax.toFixed(2)} u`);
  console.log(`  frames with penetration > 11 u ("half-ship deep") : ${penetrations.filter((p) => p > 11).length} / ${penetrations.length}`);

  // The fix bar: median penetration must be at most a small fraction of the
  // ball radius. 5 u is generous (almost a quarter of the ball radius) and
  // should be easily achievable with stiffer integration parameters; 58 u
  // (current baseline) blows past this by 10×.
  expect(
    penMedian,
    `median ball-into-polygon penetration depth must be tight; current = ${penMedian.toFixed(1)} u (HEAD baseline 58 u; expected < 5 u after integration-params fix)`,
  ).toBeLessThan(5);

  // Also lock the peak: massive single-frame penetrations indicate the
  // resolver is wedging the ball deep into the polygon, which is the user-
  // visible "fly half-way into it" symptom.
  expect(
    penMax,
    `peak ball-into-polygon penetration must be bounded; current peak = ${penMax.toFixed(1)} u (HEAD baseline 159 u; expected < 30 u after fix)`,
  ).toBeLessThan(30);

  await ctx.close();
});
