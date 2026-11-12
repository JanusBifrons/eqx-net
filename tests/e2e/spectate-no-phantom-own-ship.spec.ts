/**
 * Spectate must not leave a predicted phantom of the pilot's own ship.
 *
 * Reported (capital-breakup take, 2026-11-12, room `showcase-capital-duel`):
 * after `ctx.spectate()` a `'local'` camera cue held on an INTACT hull for the
 * whole 24 s while the parked cruiser's death explosion played at the right
 * edge of the frame. Measured in a browser: the camera followed a sprite keyed
 * by the pilot's player id, not the parked (lingering) hull. One frame after
 * Spectate the client had re-predicted its own ship at (0, 0) and kept that
 * body for the rest of the take.
 *
 * Cause: `sendSpectate` despawns the local predicted body at once, but the
 * server's `isActive=false` patch lands a tick or more later. The schema patch
 * in between still lists the own hull as ACTIVE (with no pose, x/y = 0), so
 * `syncMirror` re-ran `tryInitPredWorld` and spawned a fresh local body.
 *
 * The earlier fix (spectateOwnHullDrawnPose.test.ts, integration) fed the
 * client the state AFTER the server had parked the hull, so it missed this
 * window. This lock runs the real flow in a real browser (invariant #13: a
 * surviving bug gets its test at a different level).
 */
import { test, expect } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

const ROOM = 'showcase-capital-duel' as unknown as 'test-sector';

test('after Spectate the client never re-predicts its own ship', async ({ browser }) => {
  test.setTimeout(90_000);
  const { page } = await launchTestClient(browser, {
    room: ROOM, spawnX: 4000, spawnY: 0, shipKind: 'heavy-cruiser', initialHull: 1_000_000,
    extraParams: { worker: '0' }, joinTimeoutMs: 60_000,
  });
  await page.waitForFunction(() => {
    const c = (globalThis as { __eqxClient?: { mirror: { localPlayerId?: string | null }; predWorld?: { hasShip(id: string): boolean } } }).__eqxClient;
    const id = c?.mirror.localPlayerId;
    return !!id && c?.predWorld?.hasShip(id) === true;
  }, undefined, { timeout: 30_000 });

  // Record, every animation frame from the click on, whether a local body or a
  // local mirror entry exists (the mirror entry is rewritten per frame from the
  // body, then dropped on the next schema patch, so sample both).
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __eqxClient: { mirror: { localPlayerId: string; ships: Map<string, { x: number; y: number }>; lingeringShips?: Map<string, { ownerPlayerId?: string }> }; predWorld?: { hasShip(id: string): boolean } };
      __eqxStore: { getState(): { pilotMode?: string } };
      __phantomLog: Array<{ spectating: boolean; body: boolean; entry: boolean }>;
      __phantomStop?: boolean;
    };
    g.__phantomLog = [];
    g.__phantomStop = false;
    const tick = (): void => {
      const c = g.__eqxClient;
      const id = c.mirror.localPlayerId;
      g.__phantomLog.push({
        spectating: g.__eqxStore.getState().pilotMode === 'spectator',
        body: c.predWorld?.hasShip(id) === true,
        entry: c.mirror.ships.has(id),
      });
      // Until the test stops it: a fixed 600-frame cap ran out before Spectate
      // on a slow CI runner (19 spectating frames sampled).
      if (!g.__phantomStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('[data-testid="spectator-toggle"]').first().click({ timeout: 10_000 });
  await page.waitForFunction(
    () => (window as unknown as { __eqxStore?: { getState(): { pilotMode?: string } } }).__eqxStore?.getState().pilotMode === 'spectator',
    undefined, { timeout: 5000 },
  );
  // The parked hull reaches the client as a lingering hull of ours.
  await page.waitForFunction(() => {
    const c = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string; lingeringShips?: Map<string, { ownerPlayerId?: string }> } } }).__eqxClient;
    for (const e of c?.mirror.lingeringShips?.values() ?? []) if (e.ownerPlayerId === c?.mirror.localPlayerId) return true;
    return false;
  }, undefined, { timeout: 10_000 });
  await page.waitForTimeout(3000);

  const log = await page.evaluate(() => {
    const g = globalThis as unknown as { __phantomLog: Array<{ spectating: boolean; body: boolean; entry: boolean }>; __phantomStop?: boolean };
    g.__phantomStop = true;
    return g.__phantomLog;
  });
  const spectatingFrames = log.filter((f) => f.spectating);
  expect(spectatingFrames.length, 'frames sampled while spectating').toBeGreaterThan(30);
  const withBody = spectatingFrames.filter((f) => f.body).length;
  const withEntry = spectatingFrames.filter((f) => f.entry).length;
  expect(withBody, `frames with a predicted own ship while spectating (of ${spectatingFrames.length})`).toBe(0);
  expect(withEntry, `frames with an own mirror.ships entry while spectating (of ${spectatingFrames.length})`).toBe(0);
});
