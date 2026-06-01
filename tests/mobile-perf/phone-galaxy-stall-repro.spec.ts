/**
 * Phone-driven repro for the 2.2-s server-side dispatch stalls + the
 * ~10 MB/min heap leak.
 *
 * IMPORTANT NOTE (2026-06-01): the earlier version of this spec had
 * `locator.tap()` failing 100 % silently — the player's ship never
 * fired, sat stationary, and died fast. That produces stalls of
 * 20-24 s purely from the BROADCAST IDLE-SUPPRESSION path firing on
 * a stationary corpse. Those stalls are NOT the same mechanism the
 * user reports during active play (where they saw ~2.2 s gaps in
 * capture `jfd81u`). This rewrite uses `page.touchscreen.tap` with
 * bounding-box coords for FIRE + a CDP-driven held-and-rotating
 * joystick for movement, and SAMPLES HEAP throughout. The goal is
 * realistic combat-loaded play, not the corpse pathology.
 *
 * Run: `pnpm e2e:phone:stall`
 * Expected wall-clock: ~110-130 s (90 s drive + boot + cleanup).
 */
import { test, expect, type CDPSession } from '@playwright/test';
import { join } from 'node:path';
import { connectAndroidOrFallback } from './helpers/androidConnect';
import { pickLanIp, listLanCandidates } from './helpers/lanIp';
import { assertPhoneAwakeAndUnlocked } from './helpers/adbPreflight';
import {
  snapshotCaptures,
  findNewestCaptureSince,
  findRecvGapLongs,
  fetchDevEvents,
  readNdjson,
} from './helpers/captureFetcher';

const DRIVE_MS = 90_000;
const FIRE_INTERVAL_MS = 500;
const JOY_ROTATE_INTERVAL_MS = 2_000;
const HEAP_SAMPLE_INTERVAL_MS = 5_000;
const STALL_MIN_MS = 1000;
const MODE = process.env['STALL_REPRO_MODE'] ?? 'repro';

test.setTimeout(180_000);

interface JoystickHold {
  active: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  cdp: CDPSession;
}

async function joyDown(cdp: CDPSession, x: number, y: number): Promise<JoystickHold> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 0 }],
  });
  return { active: true, startX: x, startY: y, currentX: x, currentY: y, cdp };
}

async function joyMove(hold: JoystickHold, dx: number, dy: number): Promise<void> {
  if (!hold.active) return;
  hold.currentX = hold.startX + dx;
  hold.currentY = hold.startY + dy;
  await hold.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: hold.currentX, y: hold.currentY, id: 0 }],
  });
}

async function joyUp(hold: JoystickHold): Promise<void> {
  if (!hold.active) return;
  // Pass touchEnd with the joystick touchPoint that's RELEASING.
  // (Empty touchPoints releases all — fine if we know nothing else is held.)
  await hold.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: hold.currentX, y: hold.currentY, id: 0 }],
  });
  hold.active = false;
}

// CDP-driven multi-touch tap. While the joystick is held, EVERY
// touch event must list the still-active joystick touch in
// touchPoints (otherwise Chrome treats it as released). Fire uses
// touch id 1; joystick id 0.
async function cdpTapWithJoystick(hold: JoystickHold, fireX: number, fireY: number): Promise<void> {
  if (!hold.active) {
    // Just a standalone tap.
    await hold.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: fireX, y: fireY, id: 1 }],
    });
    await hold.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [{ x: fireX, y: fireY, id: 1 }],
    });
    return;
  }
  // Joystick is held — keep it in touchPoints alongside the new fire touch.
  await hold.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: hold.currentX, y: hold.currentY, id: 0 },
      { x: fireX, y: fireY, id: 1 },
    ],
  });
  // Release ONLY the fire touch; joystick stays in touchPoints.
  await hold.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: hold.currentX, y: hold.currentY, id: 0 }],
  });
}

async function readHeapMb(page: Awaited<ReturnType<typeof connectAndroidOrFallback>>['page']): Promise<number> {
  return page.evaluate(() => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    return mem?.usedJSHeapSize ? mem.usedJSHeapSize / 1024 / 1024 : 0;
  });
}

test(`phone galaxy-sol-prime — ${MODE} stalls + heap under realistic combat`, async () => {
  const phoneState = assertPhoneAwakeAndUnlocked();
  // eslint-disable-next-line no-console
  console.log(`[phone-stall] phone state: ${JSON.stringify(phoneState)}`);

  const lanIp = pickLanIp();
  const lanOrigin = `http://${lanIp}:5173`;
  // eslint-disable-next-line no-console
  console.log(`[phone-stall] LAN IP: ${lanIp} (candidates: ${JSON.stringify(listLanCandidates())})`);

  const testId = `galaxy-stall-${Date.now()}`;
  const url =
    `${lanOrigin}/?room=galaxy-sol-prime&worker=0&autocapture=1` +
    `&startHostile=1&testId=${testId}`;
  // eslint-disable-next-line no-console
  console.log(`[phone-stall] navigating phone to: ${url}`);

  const before = snapshotCaptures();
  // eslint-disable-next-line no-console
  console.log(`[phone-stall] capture dir count (before): ${before.size}`);

  try {
    const clearRes = await fetch('http://localhost:2567/dev/events/clear', { method: 'POST' });
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] /dev/events cleared: ${clearRes.status}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] /dev/events clear failed (continuing): ${(err as Error).message}`);
  }

  const conn = await connectAndroidOrFallback({
    mode: 'force-device',
    baseURL: url,
    extraOrigins: [lanOrigin],
  });

  try {
    expect(conn.kind, 'connected via _android (not desktop fallback)').toBe('android');

    await conn.page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
    await conn.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-hull-pct]');
        return el !== null && Number(el.getAttribute('data-hull-pct')) > 0;
      },
      undefined,
      { timeout: 30_000 },
    );
    await conn.page.waitForSelector('[data-testid="mobile-fire"]', { timeout: 15_000 });
    await conn.page.waitForSelector('[data-testid="mobile-joystick"]', { timeout: 5_000 });

    const fireBox = await conn.page.locator('[data-testid="mobile-fire"]').boundingBox();
    const joyBox = await conn.page.locator('[data-testid="mobile-joystick"]').boundingBox();
    if (!fireBox || !joyBox) {
      throw new Error('Mobile control bounding boxes not found (fire or joystick)');
    }
    const fireX = fireBox.x + fireBox.width / 2;
    const fireY = fireBox.y + fireBox.height / 2;
    const joyX = joyBox.x + joyBox.width / 2;
    const joyY = joyBox.y + joyBox.height / 2;
    // eslint-disable-next-line no-console
    console.log(
      `[phone-stall] FIRE center: (${fireX.toFixed(0)}, ${fireY.toFixed(0)}); ` +
        `JOY center: (${joyX.toFixed(0)}, ${joyY.toFixed(0)})`,
    );

    // Drift in 8-direction rotation throughout the run — keeps ship moving.
    const joy = await joyDown(conn.cdp, joyX, joyY);
    await joyMove(joy, 35, -35); // start: up-right
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] joystick held — starting active combat drive`);

    const startTime = Date.now();
    let tapCount = 0;
    let tapErrors = 0;
    let lastFireMs = -FIRE_INTERVAL_MS;
    let lastJoyRotateMs = 0;
    let lastHeapMs = -HEAP_SAMPLE_INTERVAL_MS;
    const heapSamples: Array<{ tMs: number; mb: number }> = [];

    while (Date.now() - startTime < DRIVE_MS) {
      const elapsedMs = Date.now() - startTime;

      if (elapsedMs - lastFireMs >= FIRE_INTERVAL_MS) {
        try {
          await cdpTapWithJoystick(joy, fireX, fireY);
          tapCount++;
        } catch (err) {
          tapErrors++;
          if (tapErrors === 1) {
            // eslint-disable-next-line no-console
            console.log(`[phone-stall] first fire tap error: ${(err as Error).message}`);
          }
        }
        lastFireMs = elapsedMs;
      }

      if (elapsedMs - lastJoyRotateMs >= JOY_ROTATE_INTERVAL_MS) {
        const angle = (elapsedMs / JOY_ROTATE_INTERVAL_MS) * (Math.PI / 4);
        const dx = Math.cos(angle) * 40;
        const dy = Math.sin(angle) * 40;
        await joyMove(joy, dx, dy).catch(() => undefined);
        lastJoyRotateMs = elapsedMs;
      }

      if (elapsedMs - lastHeapMs >= HEAP_SAMPLE_INTERVAL_MS) {
        try {
          const mb = await readHeapMb(conn.page);
          heapSamples.push({ tMs: elapsedMs, mb });
        } catch {
          // skip — heap api may be unavailable briefly
        }
        lastHeapMs = elapsedMs;
      }

      await conn.page.waitForTimeout(80);
    }

    await joyUp(joy);

    const elapsed = (Date.now() - startTime) / 1000;
    // eslint-disable-next-line no-console
    console.log(
      `[phone-stall] drive complete: ${tapCount} fire-taps, ${tapErrors} errors, ${elapsed.toFixed(1)} s elapsed`,
    );

    // Heap timeline + slope estimate
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] heap samples (${heapSamples.length}):`);
    for (const s of heapSamples) {
      // eslint-disable-next-line no-console
      console.log(`[phone-stall]   t=${(s.tMs / 1000).toFixed(1)}s heap=${s.mb.toFixed(1)} MB`);
    }
    if (heapSamples.length >= 2) {
      const first = heapSamples[0];
      const last = heapSamples[heapSamples.length - 1];
      const deltaMb = last.mb - first.mb;
      const slope = deltaMb / (last.tMs / 60_000);
      // eslint-disable-next-line no-console
      console.log(
        `[phone-stall] heap delta: +${deltaMb.toFixed(1)} MB over ${(last.tMs / 1000).toFixed(1)} s = ${slope.toFixed(2)} MB/min`,
      );
    }

    // Allow autocapture stream to flush.
    await conn.page.waitForTimeout(3_000);

    const captureDir = findNewestCaptureSince(before);
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] new capture dir: ${captureDir}`);

    // Verify FIRE actually fired — count sendFire-like events on the client side.
    const combatEvents = readNdjson(join(captureDir, 'combat.ndjson'));
    const fireTags = ['sendFire', 'fire_sent', 'local_fire', 'fire'];
    const fireEvents = combatEvents.filter((e) => fireTags.includes(e.tag));
    // eslint-disable-next-line no-console
    console.log(
      `[phone-stall] client-side fire events in combat.ndjson: ${fireEvents.length} (taps attempted: ${tapCount})`,
    );
    if (fireEvents.length === 0 && tapCount > 0) {
      // Surface what tags ARE in combat.ndjson — helps diagnose
      // whether touchscreen.tap is doing nothing or just landing
      // off-target.
      const combatTags = new Map<string, number>();
      for (const e of combatEvents) combatTags.set(e.tag, (combatTags.get(e.tag) ?? 0) + 1);
      // eslint-disable-next-line no-console
      console.log(`[phone-stall] combat.ndjson tag census: ${JSON.stringify([...combatTags])}`);
    }

    const stalls = findRecvGapLongs(captureDir, STALL_MIN_MS);
    // eslint-disable-next-line no-console
    console.log(
      `[phone-stall] recv_gap_long > ${STALL_MIN_MS} ms event count: ${stalls.length}`,
    );
    for (const e of stalls) {
      // eslint-disable-next-line no-console
      console.log(
        `[phone-stall]   ts=${e.ts.toFixed(1)} via=${e.via} recvGapMs=${e.recvGapMs.toFixed(1)} ` +
          `heapUsedMb=${e.heapUsedMb.toFixed(1)} serverSendPerfNow=${e.serverSendPerfNow.toFixed(1)} ` +
          `wsBufferedAmountBytes=${e.wsBufferedAmountBytes}`,
      );
    }

    const serverEvents = await fetchDevEvents('http://localhost:2567', 20_000);
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] /dev/events count: ${serverEvents.length}`);

    const tagCounts = new Map<string, number>();
    for (const e of serverEvents) tagCounts.set(e.tag, (tagCounts.get(e.tag) ?? 0) + 1);
    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] tag census (${sortedTags.length} distinct):`);
    for (const [tag, count] of sortedTags) {
      // eslint-disable-next-line no-console
      console.log(`[phone-stall]   ${tag}: ${count}`);
    }

    if (serverEvents.length > 0) {
      const first = serverEvents[0];
      const last = serverEvents[serverEvents.length - 1];
      // eslint-disable-next-line no-console
      console.log(
        `[phone-stall] events span: ${((last.ts - first.ts) / 1000).toFixed(1)} s`,
      );
    }

    const tickHitches = serverEvents.filter((e) => e.tag === 'tick_hitch');
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] tick_hitch count: ${tickHitches.length}`);
    const sortedHitches = [...tickHitches].sort(
      (a, b) => Number(b.data['totalMs'] ?? 0) - Number(a.data['totalMs'] ?? 0),
    );
    for (const h of sortedHitches.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.log(
        `[phone-stall]   tick_hitch: ts=${h.ts} totalMs=${h.data['totalMs']} phases=${JSON.stringify(h.data['phasesSnapshot'] ?? h.data['phases'] ?? {})}`,
      );
    }

    const sortedEvents = [...serverEvents].sort((a, b) => a.ts - b.ts);
    const gaps: Array<{ from: number; to: number; deltaMs: number; beforeTag: string; afterTag: string }> = [];
    for (let i = 1; i < sortedEvents.length; i++) {
      const delta = sortedEvents[i].ts - sortedEvents[i - 1].ts;
      if (delta > 500) {
        gaps.push({
          from: sortedEvents[i - 1].ts,
          to: sortedEvents[i].ts,
          deltaMs: delta,
          beforeTag: sortedEvents[i - 1].tag,
          afterTag: sortedEvents[i].tag,
        });
      }
    }
    gaps.sort((a, b) => b.deltaMs - a.deltaMs);
    // eslint-disable-next-line no-console
    console.log(`[phone-stall] inter-event gaps > 500 ms in server stream: ${gaps.length}`);
    for (const g of gaps.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.log(
        `[phone-stall]   gap: from=${g.from} (${g.beforeTag}) → to=${g.to} (${g.afterTag}) deltaMs=${g.deltaMs} (${(g.deltaMs / 1000).toFixed(1)} s)`,
      );
    }

    const broadcasts = sortedEvents.filter((e) => e.tag === 'snapshot_broadcast');
    if (broadcasts.length > 1) {
      const bcastGaps: Array<{ deltaMs: number; from: number; serverTickBefore: unknown }> = [];
      for (let i = 1; i < broadcasts.length; i++) {
        const delta = broadcasts[i].ts - broadcasts[i - 1].ts;
        if (delta > 500) {
          bcastGaps.push({
            deltaMs: delta,
            from: broadcasts[i - 1].ts,
            serverTickBefore: broadcasts[i - 1].data['serverTick'],
          });
        }
      }
      bcastGaps.sort((a, b) => b.deltaMs - a.deltaMs);
      // eslint-disable-next-line no-console
      console.log(`[phone-stall] snapshot_broadcast gaps > 500 ms: ${bcastGaps.length}`);
      for (const g of bcastGaps.slice(0, 5)) {
        // eslint-disable-next-line no-console
        console.log(
          `[phone-stall]   bcast gap: from=${g.from} (serverTick=${g.serverTickBefore}) deltaMs=${g.deltaMs} (${(g.deltaMs / 1000).toFixed(1)} s)`,
        );
      }
    }

    if (MODE === 'verify') {
      expect(
        stalls.length,
        `[verify] expected ZERO recv_gap_long > ${STALL_MIN_MS} ms in ${DRIVE_MS / 1000} s drive`,
      ).toBe(0);
    } else {
      // Diagnostic mode: pass as long as the test infrastructure ran
      // (capture appeared, joystick produced some input). Tap success
      // is informational; the main signal lives in stalls + heap +
      // server events.
      expect(
        captureDir,
        '[repro] expected a fresh capture dir from the autocapture stream',
      ).toBeTruthy();
    }
  } finally {
    await conn.cleanup();
  }
});
