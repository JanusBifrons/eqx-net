import { test, expect, type Page } from '@playwright/test';

/**
 * #17 — sector-transit ADJACENCY regression lock. The galaxy graph is correct
 * (Thornfield and Cygnus-Arm are in different regions and share NO edge) and the
 * server's TransitOrchestrator rejects a non-neighbour `engage_transit` with
 * `reason: 'not_neighbour'`. A same-tick jump between two non-adjacent sectors is
 * therefore impossible; any live log showing such a hop is an INTERMEDIATE-hop
 * misread, not a real bypass.
 *
 * This spec boots into Thornfield, fires `engage_transit → cygnus-arm` over the
 * live room, and asserts: (a) the server replies `transit_state DOCKED` with
 * `reason: 'not_neighbour'`, and (b) the SPOOLING HyperspaceOverlay never mounts
 * (the rejected transit cannot start). A CONTROL jump to a real neighbour
 * (orion-belt) then DOES spool — proving the rejection is adjacency-specific, not
 * a dead engage path.
 *
 * NOTE (orchestrator): WRITTEN-NOT-RUN in the worktree — E2E/dev-server are not
 * run here (parallel agents collide on ports). Runs in CI.
 *
 * The deterministic locks for the SAME behaviour (runnable in the inner loop) are
 * `TransitOrchestrator.test.ts` (#17 Thornfield→Cygnus rejection) and
 * `galaxy.test.ts` (#17 thornfield/cygnus-arm non-neighbour).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForGameSurface(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 15_000 });
  await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute(
    'data-warp-visible',
    '0',
    { timeout: 15_000 },
  );
}

interface ClientWithRoom {
  getRoom?: () => {
    send: (channel: string, msg: unknown) => void;
    onMessage: (channel: string, cb: (msg: unknown) => void) => void;
  } | null;
}

test('engage_transit to a NON-neighbour is rejected with not_neighbour (#17)', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}/?galaxy=thornfield`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForGameSurface(page);

  // Capture transit_state replies on the live room, then engage to a NON-neighbour.
  // Thornfield's graph neighbours are orion-belt / bloomgate / verdance — NOT
  // cygnus-arm, so the orchestrator must reply DOCKED / not_neighbour.
  const reason = await page.evaluate(async () => {
    const client = (window as unknown as { __eqxClient?: ClientWithRoom }).__eqxClient;
    const room = client?.getRoom?.();
    if (!room) return { ok: false as const, reason: 'no room' };
    const got = await new Promise<{ state: string; reason?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ state: 'TIMEOUT' }), 4000);
      room.onMessage('transit_state', (m: unknown) => {
        const msg = m as { state: string; reason?: string };
        clearTimeout(timer);
        resolve(msg);
      });
      room.send('engage_transit', { type: 'engage_transit', targetSectorKey: 'cygnus-arm' });
    });
    return { ok: true as const, ...got };
  });
  expect(reason.ok, JSON.stringify(reason)).toBe(true);
  expect(reason.state).toBe('DOCKED');
  expect(reason.reason).toBe('not_neighbour');

  // The rejected transit must NOT start a spool — no HyperspaceOverlay.
  await expect(page.locator('[data-testid="hyperspace-overlay"]')).toHaveCount(0);

  // CONTROL: a real neighbour (orion-belt) DOES start spooling, proving the
  // rejection above is adjacency-specific and the engage path is live.
  await page.evaluate(() => {
    const client = (window as unknown as { __eqxClient?: ClientWithRoom }).__eqxClient;
    client?.getRoom?.()?.send('engage_transit', {
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
    });
  });
  const overlay = page.locator('[data-testid="hyperspace-overlay"]');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await expect(overlay).toHaveAttribute('data-transit-state', 'SPOOLING');

  expect(errors, errors.join('\n')).toHaveLength(0);
});
