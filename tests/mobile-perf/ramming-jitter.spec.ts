/**
 * Mobile-emulation ramming smoke — screenshots + objective overlap measurement
 * (2026-05-28).
 *
 * Five fix attempts in a row failed to fix what the user reports because every
 * metric I tried (body-local geometric penetration depth, Rapier contact
 * normal direction, Rapier contact impulse, frame-to-frame visual delta)
 * pointed at a different thing. The user's actual on-device complaint is:
 *
 *   - First: "fly half-way into the drone" (ship sprite visibly inside L
 *     silhouette).
 *   - Then, after stiffer-params + convexHull + kinematic body: "jittery as
 *     hell" — drone oscillates in place.
 *
 * The capture data shows drone-pose oscillations in EVERY capture from the
 * baseline onwards (1610 osc in pre-fix → 545 osc in latest). The user is
 * right that we've been chasing the wrong end of the stick.
 *
 * This spec abandons further speculative fixes. It runs the ramming scenario
 * in CPU-THROTTLED Chromium (4× — matches `tests/perf/perf-baseline.spec.ts`
 * mobile-shaped arm and the mobile-perf helper's fallback default) and saves
 * SCREENSHOTS at key moments so visual overlap can be inspected directly,
 * outside of any speculation about what a metric "means."
 *
 * Outputs to `tests/mobile-perf/screenshots/ramming-jitter/`:
 *   - `01-spawn.png`        : just after the L is live + before player thrust
 *   - `02-mid-flight.png`   : player accelerated mid-way to the L
 *   - `03-first-contact.png`: first frame where physSpd drops or pen > 0
 *   - `04-contact-1s.png`   : 1 s into sustained contact
 *   - `05-contact-2s.png`   : 2 s into sustained contact
 *   - `06-contact-3s.png`   : 3 s into sustained contact
 *
 * The user can look at the screenshots and tell us directly whether the
 * ship sprite is or isn't inside the L silhouette, and whether the L is
 * jittering between adjacent frames (visible as motion-blur or fringing
 * around the L edges in a side-by-side comparison).
 *
 * The probe data (`ramming_probe` events written to `window.__eqxLogs`)
 * is dumped to JSON alongside the screenshots so we can correlate any
 * visible defect with the measured `contactState.impulse` /
 * `contactState.normal` / `dronePos` at the same frame.
 *
 * NOTE: this does NOT run by default in `pnpm e2e` (it's in
 * `tests/mobile-perf/` not `tests/e2e/`). Run explicitly with
 * `pnpm exec playwright test tests/mobile-perf/ramming-jitter.spec.ts
 *  --reporter=line --headed` (drop --headed for CI).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectAndroidOrFallback, type MobilePerfConnection } from './helpers/androidConnect';

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
    contactState: {
      normal: { x: number; y: number };
      penetration: number;
      impulse: number;
      contactCount: number;
      otherBodyId: string | null;
    } | null;
  };
}

test.setTimeout(90_000);

const SCREENSHOT_DIR = resolve(process.cwd(), 'tests/mobile-perf/screenshots/ramming-jitter');

async function shot(connection: MobilePerfConnection, label: string): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await connection.page.screenshot({
    path: resolve(SCREENSHOT_DIR, `${label}.png`),
    fullPage: false,
  });
}

test('@diag ramming jitter — CPU-throttled mobile emulation, screenshots + probe dump', async () => {
  const testId = randomUUID();
  const connection = await connectAndroidOrFallback({
    mode: 'force-fallback',
    cpuThrottleRate: 4,
    baseURL:
      `${process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173'}` +
      `?room=ramming-probe-test&testId=${testId}&initialAngle=${Math.PI}`,
  });
  try {
    const page = connection.page;

    // Wait for the game surface to be present, NO gate on swarm-count
    // (we want to capture screenshots even if the L doesn't spawn for
    // some reason — that itself is a finding).
    await page
      .locator('[data-testid="game-surface"]')
      .waitFor({ timeout: 20_000 });
    // Give the spawn lerp + a few snapshots time to settle.
    await page.waitForTimeout(2500);

    await page.locator('[data-testid="game-surface"]').click();
    await shot(connection, '01-spawn');

    // Sustained pushing scenario: hold W+Shift the WHOLE time. The
    // mass-5000 rectangle won't be shoved away on first impact, so we
    // get many seconds of continuous contact instead of a one-and-bounce.
    await page.keyboard.down('w');
    await page.keyboard.down('Shift');

    await page.waitForTimeout(2000);
    await shot(connection, '02-mid-flight');

    // ~2.5 s in: first contact with rectangle's top edge.
    await page.waitForTimeout(2500);
    await shot(connection, '03-first-contact');

    // 1 s of sustained pushing.
    await page.waitForTimeout(1000);
    await shot(connection, '04-push-1s');

    // 2 s sustained pushing.
    await page.waitForTimeout(1000);
    await shot(connection, '05-push-2s');

    // 3 s sustained pushing.
    await page.waitForTimeout(1000);
    await shot(connection, '06-push-3s');

    // 4 s sustained pushing.
    await page.waitForTimeout(1000);
    await shot(connection, '07-push-4s');

    // 5 s sustained pushing.
    await page.waitForTimeout(1000);
    await shot(connection, '08-push-5s');

    await page.keyboard.up('w');
    await page.keyboard.up('Shift');

    // Dump probe data alongside the screenshots for direct correlation.
    const probes = (await page.evaluate(() => {
      const all = (window as unknown as { __eqxLogs?: ProbeEntry[] }).__eqxLogs ?? [];
      return all.filter((e) => e.tag === 'ramming_probe');
    })) as ProbeEntry[];
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    writeFileSync(
      resolve(SCREENSHOT_DIR, 'probes.json'),
      JSON.stringify(probes, null, 2),
    );

    // ANALYSIS — print drone-position oscillation stats, contact normal +
    // impulse distribution, and visual-vs-physics divergence. The
    // assertions here are SOFT — they print + always pass — so the
    // screenshots + raw probe data become the source of truth and the
    // user can call the visual defect directly.
    console.log(`\n=== Ramming jitter (mobile-throttled ${connection.kind}) ===`);
    console.log(`probe frames: ${probes.length}`);

    // OBJECTIVE METRIC — body-local position relative to the rectangle.
    // L kind has been overridden to a scale-10 square (vertices ±100 →
    // ±1000 in body-local). Rectangle's body-local interior is
    // |bx| < 1000 AND |by| < 1000. Ball radius 22, so deepest valid
    // surface contact has |bx| or |by| at 978. Anything further inside
    // (|bx| < 978 AND |by| < 978) is real solid-mass penetration —
    // the "fly into the drone" symptom. Drone spawn angle is now 0
    // (axis-aligned), so body-local = world delta directly.
    if (probes.length > 0) {
      const cos = 1; // angle 0
      const sin = 0;
      let insideSolid = 0;
      let onSurface = 0;
      let outside = 0;
      let maxDepth = 0;
      let maxDepthFrame: ProbeEntry | null = null;
      for (const p of probes) {
        const dx = p.data.physPos.x - p.data.dronePos.x;
        const dy = p.data.physPos.y - p.data.dronePos.y;
        const bx = dx * cos - dy * sin;
        const by = dx * sin + dy * cos;
        // Penetration "depth" into the rectangle = how much the ball
        // sphere is past 978 on either axis. Positive = inside solid.
        const xDepth = 978 - Math.abs(bx);
        const yDepth = 978 - Math.abs(by);
        const depth = Math.min(xDepth, yDepth);
        if (depth > 0) {
          insideSolid++;
          if (depth > maxDepth) {
            maxDepth = depth;
            maxDepthFrame = p;
          }
        } else if (depth > -20) {
          onSurface++;
        } else {
          outside++;
        }
      }
      console.log(`\n--- Body-local position vs rectangle solid mass ---`);
      console.log(`  frames INSIDE  solid (|bx|<978 AND |by|<978) : ${insideSolid} (${(100 * insideSolid / probes.length).toFixed(1)}%)`);
      console.log(`  frames AT      surface (within 20u of edge)  : ${onSurface} (${(100 * onSurface / probes.length).toFixed(1)}%)`);
      console.log(`  frames OUTSIDE rectangle entirely             : ${outside} (${(100 * outside / probes.length).toFixed(1)}%)`);
      console.log(`  max penetration depth into solid mass         : ${maxDepth.toFixed(1)} u`);
      if (maxDepthFrame) {
        const d = maxDepthFrame.data;
        const dx = d.physPos.x - d.dronePos.x;
        const dy = d.physPos.y - d.dronePos.y;
        const bx = dx * cos - dy * sin;
        const by = dx * sin + dy * cos;
        console.log(`  worst frame: tick=${d.inputTick} physPos=(${d.physPos.x.toFixed(0)},${d.physPos.y.toFixed(0)}) bodyLocal=(${bx.toFixed(0)},${by.toFixed(0)}) physSpd=${d.physSpd}`);
        if (d.contactState) {
          console.log(`    contactState: pen=${d.contactState.penetration.toFixed(1)} impulse=${d.contactState.impulse.toFixed(2)} contacts=${d.contactState.contactCount}`);
        } else {
          console.log(`    contactState: null (Rapier reported NO contact at deepest frame!)`);
        }
      }
    }

    if (probes.length > 60) {
      const cos = Math.cos(-Math.PI / 4);
      const sin = Math.sin(-Math.PI / 4);
      let oscCount = 0;
      let droneMoveCount = 0;
      let lastDx = 0;
      let lastDy = 0;
      let lastDroneId = -1;
      for (let i = 1; i < probes.length; i++) {
        const a = probes[i - 1]!.data;
        const b = probes[i]!.data;
        const dtMs = probes[i]!.ts - probes[i - 1]!.ts;
        if (dtMs < 8 || dtMs > 30 || a.droneId !== b.droneId) {
          lastDx = 0;
          lastDy = 0;
          lastDroneId = b.droneId;
          continue;
        }
        const dx = b.dronePos.x - a.dronePos.x;
        const dy = b.dronePos.y - a.dronePos.y;
        const mag = Math.hypot(dx, dy);
        if (mag > 1) droneMoveCount++;
        const prevMag = Math.hypot(lastDx, lastDy);
        if (mag > 1 && prevMag > 1 && lastDroneId === b.droneId && (lastDx * dx < 0 || lastDy * dy < 0)) {
          oscCount++;
        }
        lastDx = dx;
        lastDy = dy;
        lastDroneId = b.droneId;
      }
      console.log(`drone position oscillations (back-forth ≥1u per frame): ${oscCount} / ${droneMoveCount}`);

      const contactFrames = probes.filter((p) => p.data.contactState !== null);
      if (contactFrames.length > 0) {
        const impulses = contactFrames.map((p) => p.data.contactState!.impulse).sort((a, b) => a - b);
        const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]!;
        console.log(`\ncontactState samples: ${contactFrames.length}`);
        console.log(`  impulse — median ${q(impulses, 0.5).toFixed(2)}, p95 ${q(impulses, 0.95).toFixed(2)}, max ${q(impulses, 1.0).toFixed(2)}`);

        // Body-local normal direction (rotates world normal by -L's spawn angle π/4).
        const buckets = { '+X': 0, '-X': 0, '+Y': 0, '-Y': 0, mixed: 0 };
        for (const p of contactFrames) {
          const n = p.data.contactState!.normal;
          const bnx = n.x * cos - n.y * sin;
          const bny = n.x * sin + n.y * cos;
          const ax = Math.abs(bnx);
          const ay = Math.abs(bny);
          if (ax > 0.9 && ay < 0.3) buckets[bnx > 0 ? '+X' : '-X']++;
          else if (ay > 0.9 && ax < 0.3) buckets[bny > 0 ? '+Y' : '-Y']++;
          else buckets.mixed++;
        }
        console.log(`  normal directions (body-local; +X+Y = away from polygon, -X-Y = INTO it):`);
        for (const k of Object.keys(buckets) as (keyof typeof buckets)[]) {
          console.log(`    ${k.padStart(5)} : ${buckets[k]}`);
        }
      } else {
        console.log(`\nNO contactState frames — Rapier never reported a contact during the run.`);
      }
    }
    console.log(`\nScreenshots + probes.json: ${SCREENSHOT_DIR}`);
    console.log('=============================================\n');

    expect(probes.length).toBeGreaterThan(60);
  } finally {
    await connection.cleanup();
  }
});
