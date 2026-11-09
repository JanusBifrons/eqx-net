/**
 * Phone E2E regression lock for the idle-suppression connected-client
 * fix (commit 98c8bc5).
 *
 * Pattern (the new paradigm — user direction 2026-06-01):
 *   - For every bug-class fix that crosses the wire, in addition to
 *     the unit test, ship a phone-driven E2E test that exercises the
 *     full stack end-to-end.
 *   - Always use an engineering (`testMode`) room with the TIGHTEST
 *     possible conditions to make execution fast + deterministic.
 *   - Conditions here = empty `test-sector`: no asteroids, no swarm,
 *     no AI, no projectiles. Connect a client, do nothing, wait the
 *     idle-threshold window, assert ZERO recv_gap_long events.
 *
 * The bug class: pre-fix, `evaluateSectorIdle` returned true after
 * `IDLE_THRESHOLD_TICKS` (60 ticks ≈ 1 s) of no signals — even with a
 * client connected. Broadcast suppression engaged, producing 250-1184 ms
 * `recv_gap_long` events on the client during natural play lulls (user
 * smoke capture `2026-06-01T16-07-35Z-0bboym`).
 *
 * Post-fix: connected client → never idle, no suppression, no gaps.
 *
 * Verified red-green-red: this spec asserts 0 events; temporarily
 * removing the `connectedClientCount > 0` branch from
 * `sectorIdleEvaluator.ts` makes it fail loud.
 */
import { test, expect } from '@playwright/test';
import { connectAndroidOrFallback } from './helpers/androidConnect';
import { pickLanIp } from './helpers/lanIp';
import { assertPhoneAwakeAndUnlocked } from './helpers/adbPreflight';

const DRIVE_MS = 30_000;
const STALL_MIN_MS = 200; // recv_gap_long only fires for gaps > 200ms (per logSnapshotRecvTelemetry)

test.setTimeout(120_000);

test('phone idle-suppression — empty test-sector + AFK client → ≥500 snapshots in 30s', async () => {
  const phoneState = assertPhoneAwakeAndUnlocked();
  // eslint-disable-next-line no-console
  console.log(`[idle-suppression] phone state: ${JSON.stringify(phoneState)}`);

  const lanIp = pickLanIp();
  const lanOrigin = `http://${lanIp}:5173`;
  const testId = `idle-suppression-${Date.now()}`;
  // `test-sector` is the empty engineering room: testMode=true, no
  // asteroids, no swarm, no AI, no projectiles. Pre-fix this would
  // flip to idle after 60 ticks of player inactivity.
  // `diag=0` matches the user's real phone smoke conditions
  // (Playwright sets navigator.webdriver which auto-enables diag;
  // explicit opt-out keeps the test honest to production).
  const url =
    `${lanOrigin}/?room=test-sector&worker=0&diag=0` +
    `&testId=${testId}&shipKind=Frigate`;
  // eslint-disable-next-line no-console
  console.log(`[idle-suppression] navigating phone to: ${url}`);

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

    // AFK window — DELIBERATELY no fire / joystick / movement.
    // The fix-under-test is "if a client is connected, never
    // suppress broadcasts even when nothing's happening".
    // eslint-disable-next-line no-console
    console.log(`[idle-suppression] AFK for ${DRIVE_MS / 1000}s in empty test-sector…`);
    await conn.page.waitForTimeout(DRIVE_MS);

    // Read recv_gap_long + snapshot_received from the in-page ring
    // buffer. Inspect both: a successful suppression won't fire
    // recv_gap_long unless gaps exceed 200ms, so we also need the raw
    // inter-arrival distribution.
    const result = await conn.page.evaluate((minMs) => {
      interface E { ts: number; tag: string; data: Record<string, unknown> }
      const ring = (window as unknown as { __eqxLogs?: E[] }).__eqxLogs ?? [];
      const stalls: Array<{ ts: number; recvGapMs: number }> = [];
      const allRecvGapsMs: number[] = [];
      for (const e of ring) {
        if (e.tag === 'recv_gap_long') {
          const recvGapMs = Number(e.data['recvGapMs']);
          if (Number.isFinite(recvGapMs) && recvGapMs >= minMs) {
            stalls.push({ ts: e.ts, recvGapMs });
          }
        }
        if (e.tag === 'snapshot_received') {
          const g = Number(e.data['recvGapMs']);
          if (Number.isFinite(g) && g > 0) allRecvGapsMs.push(g);
        }
      }
      allRecvGapsMs.sort((a, b) => a - b);
      const n = allRecvGapsMs.length;
      return {
        stalls,
        snapshotCount: n,
        recvGapStats: n > 0
          ? {
              min: allRecvGapsMs[0],
              p50: allRecvGapsMs[Math.floor(n / 2)],
              p95: allRecvGapsMs[Math.floor(n * 0.95)],
              max: allRecvGapsMs[n - 1],
              gapsOver100ms: allRecvGapsMs.filter((g) => g > 100).length,
              gapsOver500ms: allRecvGapsMs.filter((g) => g > 500).length,
            }
          : null,
      };
    }, STALL_MIN_MS);
    const stalls = result.stalls;
    // eslint-disable-next-line no-console
    console.log(
      `[idle-suppression] snapshot_received count: ${result.snapshotCount}, recvGap stats: ${JSON.stringify(result.recvGapStats)}`,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[idle-suppression] recv_gap_long > ${STALL_MIN_MS}ms count: ${stalls.length}`,
    );
    for (const e of stalls) {
      // eslint-disable-next-line no-console
      console.log(`[idle-suppression]   ts=${e.ts.toFixed(1)} recvGapMs=${e.recvGapMs.toFixed(1)}`);
    }

    // Primary signal: snapshot delivery COUNT.
    //
    // Pre-fix (verified red-phase on phone): idle suppression engages
    // after the 5 s join-grace window, broadcasts stop, NEVER recover
    // because nothing happens in the empty room. Snapshot count plateaus
    // at ~100 (the grace window's worth) in a 30 s drive.
    //
    // Post-fix: connectedClientCount > 0 keeps the sector active. At
    // 20 Hz broadcast cadence × 30 s drive = ~600 snapshots expected.
    // 500 is a comfortable floor below normal jitter.
    //
    // `recv_gap_long` is NOT a reliable signal for this bug: it only
    // fires on the NEXT snapshot after a gap, but suppression that
    // never releases produces no "next" snapshot.
    const EXPECTED_SNAPSHOT_FLOOR = 500;
    expect(
      result.snapshotCount,
      `expected ≥ ${EXPECTED_SNAPSHOT_FLOOR} snapshots in ${DRIVE_MS / 1000}s ` +
        `(20 Hz × ${DRIVE_MS / 1000}s = ~${(20 * DRIVE_MS) / 1000}). ` +
        `Got ${result.snapshotCount} — idle suppression is engaging on a ` +
        `connected client (the bug commit 98c8bc5 fixes).`,
    ).toBeGreaterThan(EXPECTED_SNAPSHOT_FLOOR);

    // Secondary signal: zero recv_gap_long > 200 ms AFTER the
    // join-handshake window. The first ~5 s after page-nav can see
    // legitimate gaps from Vite dev-mode chunk loading / initial state
    // sync — those aren't the idle-suppression bug class. The bug
    // would manifest at ts > 10 s once the join-broadcast-grace
    // (5 s @ 60 Hz) has expired.
    const POST_GRACE_TS = 10_000;
    const postGraceStalls = stalls.filter((s) => s.ts > POST_GRACE_TS);
    expect(
      postGraceStalls.length,
      `expected ZERO recv_gap_long > ${STALL_MIN_MS}ms AFTER ts=${POST_GRACE_TS}ms ` +
        `(idle suppression would manifest post-join-grace)`,
    ).toBe(0);
  } finally {
    await conn.cleanup();
  }
});
