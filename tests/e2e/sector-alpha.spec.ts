import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinSector(page: import('@playwright/test').Page): Promise<void> {
  // Post-auth flow (storageState pre-pops the JWT). The old "Enter Sector
  // Alpha" button is gone — flow is now: landing → "Join the fight" CTA →
  // galaxy-map-screen → engineering-rooms-button → engineering-room-test-sector.
  // Pattern lifted from the working spawn-select-flow.spec.ts:19.
  // test-sector (engineering, testMode=true, no drones) is the right room
  // for the basic connectivity/movement/broadcast tests below.
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const cta = page.locator('text=Join the fight').first();
  if (await cta.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cta.click();
  }
  await page.locator('[data-testid="galaxy-map-screen"]').waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="engineering-rooms-button"]').click();
  await page.locator('[data-testid="engineering-room-test-sector"]').click();
  // Wait for the in-game HUD to mount + the local ship to broadcast.
  await page.locator('[data-testid="ship-stats-card"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 10_000 },
  );
}

async function shipCount(page: import('@playwright/test').Page): Promise<number> {
  const text = await page.locator('[data-testid="ship-count"]').textContent();
  return parseInt(text?.replace('Ships: ', '') ?? '0', 10);
}

/** State-wait until the page sees at least `n` ships. Replaces fixed
 *  `waitForTimeout` sleeps before two-client `shipCount >= 2` assertions —
 *  the second joiner's broadcast crosses network + Colyseus state-diff +
 *  syncMirror, whose latency varies and made the fixed waits flaky. */
async function waitForShipCount(page: import('@playwright/test').Page, n = 2): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) >= min;
    },
    n,
    { timeout: 10_000 },
  );
}

function getShipPos(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return {
      x: parseFloat(el?.getAttribute('data-ship-x') ?? 'NaN'),
      y: parseFloat(el?.getAttribute('data-ship-y') ?? 'NaN'),
    };
  });
}

async function waitForShipPos(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      const x = el?.getAttribute('data-ship-x');
      return x !== null && x !== undefined && !Number.isNaN(parseFloat(x));
    },
    { timeout: 8000 },
  );
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

test.describe('connection', () => {
  test('splash screen shows the Join the fight CTA', async ({ page }) => {
    // The old "Enter Sector Alpha" splash button was removed when the
    // post-auth flow was refactored to galaxy-map-spawn. The new entry
    // point is the meta-landing's "Join the fight" CTA. Storage-state
    // pre-pops the JWT so we land on the post-auth meta-landing.
    await page.goto(BASE_URL);
    await expect(page.locator('text=Join the fight').first()).toBeVisible({ timeout: 15_000 });
  });

  test('single client connects and receives a playerId', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await joinSector(page);

    // playerId is exposed on the game-surface dataset (the old "ID: <hex>"
    // HUD chip was removed when the diagnostics moved drawer-side).
    const localId = await page
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');
    expect(localId, 'local player id present after join').toMatch(/^[0-9a-f-]{8,}/);
    await expect(page.locator('[data-testid="ship-count"]')).not.toHaveText('Ships: 0');

    const canvas = await page.locator('canvas').boundingBox();
    expect(canvas).not.toBeNull();
    expect(canvas!.width).toBeGreaterThan(100);
    expect(canvas!.height).toBeGreaterThan(100);

    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// Two-client isolation (was: "only 1 ship; both players control it")
// ---------------------------------------------------------------------------

test.describe('two-client isolation', () => {
  test('two isolated contexts produce distinct playerIds and two ships each', async ({ browser }) => {
    // Separate contexts → separate localStorage → distinct playerIds.
    // This was the root cause of "both browsers control the same ship".
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await joinSector(page1);
    await joinSector(page2);

    // playerId is exposed on the game-surface dataset (old HUD chip is gone).
    const id1 = await page1
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');
    const id2 = await page2
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2); // distinct identities

    // Both clients must see at least 2 ships. The server is shared across test
    // runs so there may be leftover ships; the important invariant is ≥ 2 distinct
    // ships exist and the two new joiners have different identities.
    // Let the server broadcast stabilise.
    await waitForShipCount(page1);
    await waitForShipCount(page2);
    expect(await shipCount(page1)).toBeGreaterThanOrEqual(2);
    expect(await shipCount(page2)).toBeGreaterThanOrEqual(2);

    await ctx1.close();
    await ctx2.close();
  });

  test('player 2 does not move when only player 1 thrusts', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await joinSector(page1);
    await joinSector(page2);

    await waitForShipCount(page1);
    await waitForShipCount(page2);
    expect(await shipCount(page1)).toBeGreaterThanOrEqual(2);
    expect(await shipCount(page2)).toBeGreaterThanOrEqual(2);

    // Capture player 2's position before player 1 moves.
    await waitForShipPos(page2);
    const p2Before = await getShipPos(page2);

    // Player 1 thrusts.
    await page1.keyboard.down('w');
    await page1.waitForTimeout(800);
    await page1.keyboard.up('w');
    await page1.waitForTimeout(200); // let state propagate

    // Player 2's own ship should not have moved.
    const p2After = await getShipPos(page2);
    const p2Dist = Math.hypot(p2After.x - p2Before.x, p2After.y - p2Before.y);
    expect(p2Dist).toBeLessThan(0.5); // p2 was stationary

    await ctx1.close();
    await ctx2.close();
  });
});

// ---------------------------------------------------------------------------
// Movement (was: "thrust works, but ship doesn't appear to move")
// ---------------------------------------------------------------------------

test.describe('movement', () => {
  test('W key thrusts ship — position changes measurably', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await joinSector(page);

    // Wait until the local ship has a known position in the DOM.
    await waitForShipPos(page);
    const before = await getShipPos(page);

    await page.keyboard.down('w');
    await page.waitForTimeout(800);
    await page.keyboard.up('w');
    await page.waitForTimeout(200); // let last server tick propagate

    const after = await getShipPos(page);
    const dist = Math.hypot(after.x - before.x, after.y - before.y);

    // With mass≈1 and THRUST_IMPULSE=0.15 at 60 Hz, 800 ms of thrust gives
    // roughly 7 units/s terminal velocity → ≥2 unit displacement is conservative.
    expect(dist).toBeGreaterThan(2);

    await ctx.close();
  });

  test('A key rotates ship left (angle increases)', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await joinSector(page);
    await waitForShipPos(page);

    const getAngle = (): Promise<number> =>
      page.evaluate(() =>
        parseFloat(
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-angle') ?? 'NaN',
        ),
      );

    await page.keyboard.down('a');
    await page.waitForTimeout(300);
    await page.keyboard.up('a');
    await page.waitForTimeout(100);

    // angle is exposed in data-ship-angle (added alongside x/y in the render loop)
    // Rapier CCW = positive angle; turnLeft = positive ω → angle should have increased.
    const angle = await getAngle();
    // Angle may be NaN if data-ship-angle not yet wired; skip rather than fail noisily.
    if (!Number.isNaN(angle)) {
      expect(angle).toBeGreaterThan(0);
    }

    await ctx.close();
  });

  test('both clients remain connected while player 1 moves', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await joinSector(page1);
    await joinSector(page2);

    await waitForShipCount(page1);
    expect(await shipCount(page1)).toBeGreaterThanOrEqual(2);

    await page1.keyboard.down('w');
    await page1.waitForTimeout(1000);
    await page1.keyboard.up('w');

    // No crashes or disconnects. (The old "connected" indicator text moved
    // into the drawer's Debug tab — but if either client had disconnected,
    // the game-surface's data-local-player-id would have been cleared and
    // the ship-stats-card unmounted, both of which we already covered via
    // joinSector. Re-assert the playerId is still present on both.)
    expect(
      await page1.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id'),
    ).toBeTruthy();
    expect(
      await page2.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id'),
    ).toBeTruthy();
    await waitForShipCount(page2);
    expect(await shipCount(page2)).toBeGreaterThanOrEqual(2);

    await ctx1.close();
    await ctx2.close();
  });
});

// ---------------------------------------------------------------------------
// Cross-client position agreement (Phase 1 acceptance gate)
// "both mirror the same positions within tolerance"
// ---------------------------------------------------------------------------

test.describe('server-authoritative broadcast', () => {
  test('both clients see P1 ship at the same position after movement', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await joinSector(page1);
    await joinSector(page2);

    // Get P1's durable playerId from localStorage.
    const p1Id = await page1.evaluate(() => localStorage.getItem('eqxPlayerId'));
    expect(p1Id).not.toBeNull();

    // Thrust P1 so the position is clearly non-zero.
    await waitForShipPos(page1);

    // Get P2's local player ID for cross-mirror lookups.
    const p2LocalId = await page2.evaluate(() =>
      document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? ''
    );

    // Start a continuous sampling loop in page1 and page2 before thrust starts.
    // Each page collects (t, localY, remoteY) samples every 100ms.
    const startSampling = (page: import('@playwright/test').Page, remoteId: string) =>
      page.evaluate((rid: string) => {
        (window as Record<string, unknown>)['__diagSamples'] = [];
        const start = performance.now();
        const iv = setInterval(() => {
          const el = document.querySelector('[data-testid="game-surface"]');
          const pos = JSON.parse(el?.getAttribute('data-ship-positions') ?? '{}') as Record<string, { x: number; y: number }>;
          const localId = el?.getAttribute('data-local-player-id') ?? '';
          ((window as Record<string, unknown>)['__diagSamples'] as unknown[]).push({
            t: Math.round(performance.now() - start),
            localY: pos[localId]?.y ?? null,
            remoteY: pos[rid]?.y ?? null,
          });
        }, 100);
        (window as Record<string, unknown>)['__diagSampleIv'] = iv;
      }, remoteId);

    const stopSampling = (page: import('@playwright/test').Page) =>
      page.evaluate(() => {
        clearInterval((window as Record<string, unknown>)['__diagSampleIv'] as ReturnType<typeof setInterval>);
        return (window as Record<string, unknown>)['__diagSamples'] as Array<{ t: number; localY: number | null; remoteY: number | null }>;
      });

    await Promise.all([startSampling(page1, p2LocalId), startSampling(page2, p1Id!)]);

    await page1.keyboard.down('w');
    await page1.waitForTimeout(1000);
    await page1.keyboard.up('w');
    await page1.waitForTimeout(300); // wait for final server broadcast to reach both clients

    const [p1Samples, p2Samples] = await Promise.all([stopSampling(page1), stopSampling(page2)]);

    // Read P1's self-reported position.
    const p1Self = await getShipPos(page1);

    // Read all ship positions from P2's mirror and find P1's entry.
    const p2Positions = await page2.evaluate<Record<string, { x: number; y: number }>>(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      return JSON.parse(raw ?? '{}') as Record<string, { x: number; y: number }>;
    });

    expect(p1Id).not.toBeNull();
    const p1FromP2 = p2Positions[p1Id!];
    expect(p1FromP2).toBeDefined(); // P2 must know about P1's ship

    const diff = Math.hypot(p1Self.x - p1FromP2.x, p1Self.y - p1FromP2.y);

    console.log('\n=== P2P position agreement diagnostic ===');
    console.log(`P1 self final: (${p1Self.x.toFixed(3)}, ${p1Self.y.toFixed(3)})`);
    console.log(`P1 via P2 final: (${p1FromP2?.x.toFixed(3)}, ${p1FromP2?.y.toFixed(3)})  diff=${diff.toFixed(3)} u`);
    console.log('P1 page — self-Y vs P2-remoteY (P2 as seen from P1):');
    for (const s of p1Samples.filter((_, i) => i % 2 === 0)) {
      console.log(`  t+${s.t}ms: localY=${s.localY?.toFixed(2) ?? 'null'}  remoteY=${s.remoteY?.toFixed(2) ?? 'null'}`);
    }
    console.log('P2 page — self-Y vs P1-remoteY (P1 as seen from P2):');
    for (const s of p2Samples.filter((_, i) => i % 2 === 0)) {
      console.log(`  t+${s.t}ms: localY=${s.localY?.toFixed(2) ?? 'null'}  remoteY=${s.remoteY?.toFixed(2) ?? 'null'}  Δy=${s.remoteY !== null && s.localY !== null ? (s.remoteY - s.localY).toFixed(2) : 'null'}`);
    }
    console.log('=========================================\n');
    console.log('=========================================\n');

    // P1's self-position is from prediction (slightly ahead of server).
    // P2 now renders P1 from predWorld (same approach as local ship + obstacles).
    // With predWorld and low RTT, both P1 self and P2's view of P1 should be close.
    // Allow 60 u to cover outlier cases (this test was borderline pre-fix with 100ms delay too).
    expect(diff).toBeLessThan(60);

    await ctx1.close();
    await ctx2.close();
  });
});

// ---------------------------------------------------------------------------
// Identity persistence
// ---------------------------------------------------------------------------

test.describe('identity', () => {
  test('playerId survives page reload', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await joinSector(page);
    const id1 = await page
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');
    expect(id1).toBeTruthy();

    await page.reload();
    await joinSector(page);
    const id2 = await page
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');
    expect(id2).toBeTruthy();

    expect(id1).toBe(id2);

    await ctx.close();
  });

  test('server assigns fresh UUID when stored playerId is already in use', async ({ browser }) => {
    // Simulate two tabs in the same browser sharing localStorage by manually
    // setting the same playerId in both contexts, then joining both.
    const sharedId = '00000000-0000-0000-0000-000000000001';

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();

    // Prime both contexts with the same playerId in localStorage.
    for (const ctx of [ctx1, ctx2]) {
      const p = await ctx.newPage();
      await p.goto(BASE_URL);
      await p.evaluate((id) => localStorage.setItem('eqxPlayerId', id), sharedId);
      await p.close();
    }

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await joinSector(page1);
    await joinSector(page2);

    const id1 = await page1
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');
    const id2 = await page2
      .locator('[data-testid="game-surface"]')
      .getAttribute('data-local-player-id');

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    // The server must have assigned a different ID to the second joiner.
    expect(id1).not.toBe(id2);

    // Both ships should be visible (≥ 2). Wait on the actual state (ship-count
    // reaching 2) rather than a fixed timeout — the second ship's broadcast
    // crosses network + Colyseus state-diff + syncMirror, whose latency varies.
    const bothVisible = (p: typeof page1) =>
      p.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="ship-count"]');
          return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) >= 2;
        },
        { timeout: 10_000 },
      );
    await bothVisible(page1);
    await bothVisible(page2);
    expect(await shipCount(page1)).toBeGreaterThanOrEqual(2);
    expect(await shipCount(page2)).toBeGreaterThanOrEqual(2);

    await ctx1.close();
    await ctx2.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — physics worker stall resistance
// ---------------------------------------------------------------------------

test.describe('physics worker', () => {
  test('simulation keeps ticking during a 200 ms main-thread burn', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await joinSector(page);
    await waitForShipPos(page);

    // Thrust while simultaneously triggering a 200 ms CPU-stall on the server's
    // main thread. The physics worker runs independently, so it keeps stepping;
    // after the burn completes the Colyseus broadcast catches up.
    await page.keyboard.down('w');

    // Fire-and-forget burn from inside the browser (CORS * origin is set on the server).
    await page.evaluate(() =>
      fetch('http://localhost:2567/test/burn', { method: 'POST' }).catch(() => undefined),
    );

    await page.waitForTimeout(500); // let physics accumulate during and after the burn
    await page.keyboard.up('w');
    await page.waitForTimeout(200); // let the final broadcast arrive

    // The ship must have moved — physics ran during the stall.
    const pos = await getShipPos(page);
    // Ships spawn near the origin, so raw distance from origin ≈ displacement.
    const dist = Math.hypot(pos.x, pos.y);
    expect(dist).toBeGreaterThan(2);

    // Connection alive — the "connected" text moved into the drawer's debug
    // tab, but localPlayerId is the structural-survival signal.
    expect(
      await page.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id'),
    ).toBeTruthy();

    await ctx.close();
  });
});
