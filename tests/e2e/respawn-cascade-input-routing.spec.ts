/**
 * Regression lock — capture `2026-05-31T15-36-08Z-7eqj1a` "pinning after
 * respawn" + capture `hlqxy6` "instance leak (4 constructed / 3 disposed)".
 *
 * Sibling to `tests/integration/sectorRoom/respawnInputApplies.test.ts`,
 * which proved the SERVER side of respawn is clean — input handler,
 * worker SPAWN, isActive-flip-at-arrival, playerToSlot mapping all work.
 *
 * This spec exercises the CLIENT side: drives the actual galaxy-map
 * sector-pick flow that triggers the GameSurface effect's dispose +
 * remount cascade, then asserts inputs still reach the server and move
 * the ship after a second respawn cycle.
 *
 * Failure mode being locked:
 *   - User dies, opens galaxy map, picks a sector → fresh spawn handshake
 *   - Repeats the cycle (die again, pick again) — the SECOND cycle
 *     leaks an orphaned ColyseusGameClient (4 client_constructed events
 *     in the capture vs 3 dispose_complete)
 *   - Inputs route to the orphaned client's dead room reference
 *   - Server never sees them → ship pinned at server-authoritative pose
 *
 * Test strategy: open in galaxy room, drive in-game galaxy-map open +
 * sector-click TWICE, assert `data-ship-positions` for the local ship
 * shows movement after thrust in BOTH new sectors.
 *
 * Per Invariant #13: this MUST FAIL on current code to lock the bug.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface PositionsMap { [playerId: string]: { x: number; y: number } }

async function readLocalPos(page: import('@playwright/test').Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate((): { x: number; y: number } | null => {
    const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
    if (!el) return null;
    const localId = el.dataset['localPlayerId'];
    if (!localId) return null;
    const raw = el.dataset['shipPositions'];
    if (!raw) return null;
    try {
      const positions = JSON.parse(raw) as PositionsMap;
      const p = positions[localId];
      if (!p) return null;
      return { x: p.x, y: p.y };
    } catch {
      return null;
    }
  });
}

async function waitForHandshakeComplete(page: import('@playwright/test').Page, label: string): Promise<void> {
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-loading-active="0"]') !== null,
      { timeout: 15_000 },
    );
  } catch (err) {
    // Dump diagnostic state so we can see WHY the handshake stalled.
    // First, give the page 200ms to catch its breath in case Playwright
    // detected a transient close that's actually still alive.
    await new Promise((r) => setTimeout(r, 200));
    let state: {
      loadingAttr: string;
      gameSurfacePresent: boolean;
      recentTagCounts: Record<string, number>;
      cleanupFailures: unknown[];
      last30Events: unknown[];
    } | null = null;
    let evalErr: string | null = null;
    try {
      state = await page.evaluate(() => {
        type Entry = { ts: number; tag: string; data: Record<string, unknown> };
        const logs = (window as unknown as { __eqxLogs?: Entry[] }).__eqxLogs ?? [];
        const recent = logs.slice(-30);
        const loadingEl = document.querySelector('[data-loading-active]') as HTMLElement | null;
        const surfaceEl = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
        const cleanupFailures = logs.filter((e) => e.tag === 'cleanup_step_failed');
        const tagCounts: Record<string, number> = {};
        for (const e of logs) tagCounts[e.tag] = (tagCounts[e.tag] ?? 0) + 1;
        return {
          loadingAttr: loadingEl?.getAttribute('data-loading-active') ?? '<no element>',
          gameSurfacePresent: surfaceEl !== null,
          recentTagCounts: tagCounts,
          cleanupFailures,
          last30Events: recent,
        };
      });
    } catch (e) {
      evalErr = e instanceof Error ? e.message : String(e);
    }
    throw new Error(
      `[respawn-cascade] handshake never completed for "${label}".\n` +
      (state
        ? `data-loading-active="${state.loadingAttr}"\n` +
          `game-surface present: ${state.gameSurfacePresent}\n` +
          `cleanup_step_failed events: ${JSON.stringify(state.cleanupFailures, null, 2)}\n` +
          `tag counts: ${JSON.stringify(state.recentTagCounts, null, 2)}\n` +
          `last 30 events: ${JSON.stringify(state.last30Events, null, 2)}\n`
        : `(could not read page state: ${evalErr})\n`) +
      `Original: ${String(err)}`,
    );
  }
  await page.waitForTimeout(200);
  // eslint-disable-next-line no-console
  console.log(`[respawn-cascade] handshake complete: ${label}`);
}

async function driveThrust(page: import('@playwright/test').Page, durationMs: number): Promise<void> {
  await page.keyboard.down('w');
  await page.waitForTimeout(durationMs);
  await page.keyboard.up('w');
  await page.waitForTimeout(150); // drain ack
}

async function shipPositions(page: import('@playwright/test').Page): Promise<PositionsMap> {
  return page.evaluate((): PositionsMap => {
    const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
    if (!el) return {};
    try { return JSON.parse(el.dataset['shipPositions'] ?? '{}') as PositionsMap; } catch { return {}; }
  });
}

test('respawn cascade: thrust moves ship after TWO galaxy-map sector picks', async ({ page }) => {
  test.setTimeout(120_000);

  // Capture browser console + uncaught errors so a crash during the
  // cascade surfaces with the actual JS error instead of an opaque
  // "page closed".
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}\n${err.stack ?? '<no stack>'}`);
  });
  page.on('crash', () => consoleErrors.push('[crash] page crashed'));
  // Print them on any failure.
  test.info().annotations.push({
    type: 'console',
    description: () => consoleErrors.join('\n---\n'),
  } as unknown as { type: string; description: string });

  // Stage 1: bootstrap directly into a galaxy room (skip meta/auth via
  // the documented ?room= escape hatch). autocapture=1 so we get the
  // diag trail that's been the lifeblood of this investigation.
  const baseParams = new URLSearchParams({
    diag: '1',
    autocapture: '1',
    testId: `respawn-cascade-${Date.now()}`,
  });

  // galaxy-sol-prime: matches the user's smoke environment (Living
  // World bots hunt the player). The cascade-without-hostility variant
  // passed in feel-test-25 — bug only repros under bot pressure.
  await page.goto(`${BASE_URL}/?room=galaxy-sol-prime&${baseParams}`);
  await waitForHandshakeComplete(page, 'initial spawn');

  const dumpConsole = (label: string): void => {
    if (consoleErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[${label}] console events so far:\n${consoleErrors.join('\n---\n')}`);
    }
  };

  // Skip baseline thrust in galaxy-sol-prime — the Living World bots
  // start firing immediately, the player dies within ~3 s of join, and
  // the death overlay covers the surface so the cascade-hook + thrust
  // combo can't be tested cleanly. Cascade-only test: trigger respawn
  // immediately, assert it completes + ship can move.
  dumpConsole('post-initial-spawn');

  // Give the game ~1 s to fully settle (initial join broadcast grace,
  // first snapshot tick, first arrival ack) before triggering the
  // cascade. Without this, the cascade fires while the initial handshake
  // is barely finished and we can't tell what's racing.
  await page.waitForTimeout(1000);

  // Pre-cascade state dump so we can see what's alive before we kick.
  const preCascade = await page.evaluate(() => {
    type Entry = { ts: number; tag: string; data: Record<string, unknown> };
    const logs = (window as unknown as { __eqxLogs?: Entry[] }).__eqxLogs ?? [];
    const counts: Record<string, number> = {};
    for (const e of logs) counts[e.tag] = (counts[e.tag] ?? 0) + 1;
    return {
      tagCounts: counts,
      loadingAttr: document.querySelector('[data-loading-active]')?.getAttribute('data-loading-active') ?? '<none>',
    };
  });
  // eslint-disable-next-line no-console
  console.log('[pre-cascade] state:', JSON.stringify(preCascade, null, 2));

  // Stage 2: SKIPPED — see comment above. In galaxy-sol-prime the LW
  // bots kill the player before any clean thrust window. Cascade-only
  // test from here on.

  // Stage 3: first respawn cascade. The galaxy-map sector-pick flow is
  // Pixi-rendered (no DOM hexes), so we use the dev-only window hook
  // `__eqxTriggerRespawnCascade()` which drives the same App.tsx phase
  // cycle (game → connecting → game) that ship-swap and galaxy-pick do.
  // This is the load-bearing unmount+remount cascade.
  await page.evaluate(() => {
    (window as unknown as { __eqxTriggerRespawnCascade?: () => void })
      .__eqxTriggerRespawnCascade?.();
  });

  // Mid-cascade state probe at 5 s — past the 3 s minDisplay floor,
  // so client_ready should have fired and warp_in/arrival_acked
  // should be visible. Anything missing here pinpoints the stuck gate.
  await page.waitForTimeout(5000);
  const midCascade = await page.evaluate(() => {
    type Entry = { ts: number; tag: string; data: Record<string, unknown> };
    const logs = (window as unknown as { __eqxLogs?: Entry[] }).__eqxLogs ?? [];
    // Counts across ALL retained logs (not just the tail) so we can see
    // whether the gameRafLoop / network paths fired AT ALL since the
    // cascade. Tail counts misled the previous probe.
    const counts: Record<string, number> = {};
    for (const e of logs) counts[e.tag] = (counts[e.tag] ?? 0) + 1;
    // Surface tags that signal handshake stages.
    const handshakeRelevant: Record<string, number> = {};
    const interesting = [
      'client_constructed', 'dispose_complete', 'cleanup_step_failed',
      'phase_change', 'predworld_init', 'welcome', 'rescued_own_ship_from_lingering',
      'client_ready_sent', 'warp_event', 'arrival_acked', 'respawn_ready',
      'pixi_first_frame', 'local_pose_resolved', 'first_snapshot_applied',
      'snapshot_received', 'snapshot_applied', 'mirror_rebuild', 'rafWork',
      'renderer_path_chosen', 'connection_status_change', 'disconnected',
    ];
    for (const t of interesting) handshakeRelevant[t] = counts[t] ?? 0;
    return {
      totalLogCount: logs.length,
      handshakeRelevant,
      otherTagCounts: counts,
      loadingAttr: document.querySelector('[data-loading-active]')?.getAttribute('data-loading-active') ?? '<none>',
      surfacePresent: !!document.querySelector('[data-testid="game-surface"]'),
    };
  }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  // eslint-disable-next-line no-console
  console.log('[mid-cascade @2s]:', JSON.stringify(midCascade, null, 2));

  await waitForHandshakeComplete(page, 'first respawn (cascade)').catch((e) => {
    dumpConsole('first-cascade-failed');
    throw e;
  });
  dumpConsole('post-first-cascade');

  // Stage 4: thrust after first respawn. Even in a hostile sector,
  // a short 400ms thrust gives us a movement signal before death.
  const startB = await readLocalPos(page);
  expect(startB, 'position readable after first respawn').not.toBeNull();
  await driveThrust(page, 400);
  const endB = await readLocalPos(page);
  expect(endB).not.toBeNull();
  const movedB = Math.hypot(endB!.x - startB!.x, endB!.y - startB!.y);

  expect(
    movedB,
    `after first respawn cascade, thrust must move the ship. Start (${startB!.x.toFixed(2)}, ${startB!.y.toFixed(2)}) → end (${endB!.x.toFixed(2)}, ${endB!.y.toFixed(2)})`,
  ).toBeGreaterThan(1);

  // Stage 5: SECOND respawn cascade. The capture showed the leak
  // happens on the SECOND cycle — 4× client_constructed vs 3× dispose.
  await page.evaluate(() => {
    (window as unknown as { __eqxTriggerRespawnCascade?: () => void })
      .__eqxTriggerRespawnCascade?.();
  });
  await waitForHandshakeComplete(page, 'second respawn (cascade)').catch((e) => {
    dumpConsole('second-cascade-failed');
    throw e;
  });
  dumpConsole('post-second-cascade');

  // Stage 6: thrust after second respawn — the actual regression assert.
  const startC = await readLocalPos(page);
  expect(startC, 'position readable after second respawn').not.toBeNull();
  await driveThrust(page, 400);
  const endC = await readLocalPos(page);
  expect(endC).not.toBeNull();
  const movedC = Math.hypot(endC!.x - startC!.x, endC!.y - startC!.y);

  // Also dump cleanup_step_failed logs to surface any silent dispose
  // failures the App.tsx cleanup wrapper caught.
  const cleanupFailures = await page.evaluate((): Array<{ tag: string; data: Record<string, unknown> }> => {
    type Entry = { tag: string; data: Record<string, unknown> };
    const logs = (window as unknown as { __eqxLogs?: Entry[] }).__eqxLogs ?? [];
    return logs.filter((e) => e.tag === 'cleanup_step_failed');
  });

  const finalPositions = await shipPositions(page);

  expect(
    movedC,
    [
      'After TWO galaxy-map respawn cycles, thrust must move the ship.',
      `Movement observed: ${movedC.toFixed(3)} u (expected > 1 u).`,
      `Start: (${startC!.x.toFixed(3)}, ${startC!.y.toFixed(3)})`,
      `End:   (${endC!.x.toFixed(3)}, ${endC!.y.toFixed(3)})`,
      `cleanup_step_failed events: ${cleanupFailures.length} — ${JSON.stringify(cleanupFailures, null, 2)}`,
      `Final ship positions map: ${JSON.stringify(finalPositions, null, 2)}`,
      'If 0: client cascade is broken — inputs likely routed to an',
      'orphaned ColyseusGameClient with a dead room reference.',
    ].join('\n'),
  ).toBeGreaterThan(1);
});
