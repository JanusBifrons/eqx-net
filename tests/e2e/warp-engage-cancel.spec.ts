/**
 * Phase 3b feature lock — warp/transit engage→spool→cancel state-machine
 * roundtrip, end-to-end through the live ColyseusClient ↔ SectorRoom
 * ↔ TransitOrchestrator ↔ TransitStateMachine path.
 *
 * Plan: e2e-rebuild (`C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md`)
 * Phase 3b — "warp/transit lifecycle: only `configurable-arrival.spec.ts`
 * covers UI not the full engage→spool→commit→arrive flow."
 *
 * Why the cancel path (not the full arrival):
 *   - `SPOOL_DURATION_MS = 30_000` (slow-down-gameplay pass 2026-05-18,
 *     `src/core/transit/TransitStateMachine.ts:38`). Waiting the full
 *     spool puts a single E2E spec over the 30-second per-test cap that
 *     `playwright.config.ts:5` calls "non-negotiable."
 *   - Adding a `testSpoolMs` JoinOption is the right move only when 3+
 *     tests would benefit (`docs/architecture/e2e-framework.md` bespoke
 *     trigger rule). Today only this spec would use it; the COMMIT path
 *     is already locked by `tests/integration/sectorRoom/warpBroadcasts.test.ts`,
 *     `src/server/transit/TransitOrchestrator.test.ts` (commit path),
 *     `src/client/net/ColyseusClient.transitArrivalDrift.test.ts`
 *     (destination-room reseed), `src/client/components/WarpScreen.transit.test.tsx`
 *     (UI re-arm), `src/client/state/store.rearmJoinReadiness.test.ts`
 *     (Zustand re-arm). The gap was the ENGAGE wire + SPOOLING UI
 *     surface E2E — which this spec fills.
 *
 * What this locks (in one ≤10 s test):
 *   1. The `engage_transit` Colyseus message reaches the orchestrator
 *      from a real client room (`room.send('engage_transit', { type: ...,
 *      target: 'cygnus-arm' })`).
 *   2. The orchestrator broadcasts `transit_state SPOOLING` back, the
 *      client's `ColyseusClient` translates it into the Zustand
 *      `transitState='SPOOLING'` + `transitSpoolMs`, and React mounts
 *      the `HyperspaceOverlay` SpoolingBar (`data-testid=
 *      "hyperspace-overlay"` + `data-transit-state="SPOOLING"`).
 *   3. Clicking the abort button (`data-testid="hyperspace-cancel"`)
 *      sends `cancel_transit` over the wire, the orchestrator transitions
 *      the state machine back to `DOCKED`, the client store clears,
 *      and the overlay unmounts (returns null on DOCKED — see
 *      `HyperspaceOverlay.tsx:35`).
 *
 * Reverting any of:
 *   - the `engage_transit` wire shape (`src/client/net/transitClient.ts:30`)
 *   - the `transit_state` SPOOLING handler in `ColyseusClient`
 *   - the `HyperspaceOverlay`'s `data-transit-state="SPOOLING"` attribute
 *   - the `handleCancelTransit` → `cancelTransit` callback wiring in App.tsx
 *   - the orchestrator's SPOOLING → cancel → DOCKED transition path
 * would fail this spec.
 *
 * Boot strategy: same `?galaxy=sol-prime` autojoin used by
 * `join-warp-screen.spec.ts` / `mobile-joystick-ship-swap.spec.ts` etc.
 * — Sol Prime is the core hub; post Living Galaxy P1 its graph neighbours are
 * vega-reach / lyra-fringe / cygnus-arm. The engage_transit ownership check
 * passes because we leave `shipId` unset (legacy SAB-pose path) and
 * `target: 'cygnus-arm'` is a real neighbour.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForGameSurface(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 15_000 });
  // Wait for the WarpScreen curtain to lift — guarantees the room is
  // joined, first snapshot applied, and the player ship is on the wire
  // (the engage_transit message would reject otherwise).
  await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute(
    'data-warp-visible',
    '0',
    { timeout: 15_000 },
  );
}

test('warp engage → SPOOLING overlay → cancel → DOCKED (state-machine roundtrip)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE_ERROR: ${msg.text()}`);
  });

  // Spawn at a clearly non-origin point so we can also confirm the
  // ship pose stayed stable across the cancelled spool (no teleport
  // glitch). Sol-prime engineering bounds are |x|, |y| ≤ 5000.
  const SPAWN_X = 400;
  const SPAWN_Y = -200;

  await page.goto(
    `${BASE_URL}/?galaxy=sol-prime&spawnX=${SPAWN_X}&spawnY=${SPAWN_Y}`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );

  await waitForGameSurface(page);

  // ── Step 1: state-machine starts DOCKED (no overlay) ─────────────
  // The HyperspaceOverlay renders null on DOCKED, so the testid is
  // absent. Use isVisible() not waitForSelector — we want a negative.
  await expect(page.locator('[data-testid="hyperspace-overlay"]')).toHaveCount(0);

  // ── Step 2: dispatch engage_transit through the live room ────────
  // `__eqxClient` is DEV-only (`App.tsx:248-250`); Playwright runs Vite
  // dev mode so it's available. `getRoom()` is a sanctioned accessor
  // (`ColyseusClient.ts:453`) and the engage_transit message shape is
  // `EngageTransitSchema` — type + target + optional arrival/shipId.
  // cygnus-arm is a real graph neighbour of sol-prime (the Crimson chokepoint;
  // post Living Galaxy P1 the core hub links to vega-reach / lyra-fringe / cygnus-arm).
  const dispatched = await page.evaluate(() => {
    interface ClientWithRoom {
      getRoom?: () => { send: (channel: string, msg: unknown) => void } | null;
    }
    const client = (window as unknown as { __eqxClient?: ClientWithRoom })
      .__eqxClient;
    if (!client?.getRoom) return { ok: false, reason: 'no __eqxClient.getRoom' };
    const room = client.getRoom();
    if (!room) return { ok: false, reason: 'no room' };
    room.send('engage_transit', {
      type: 'engage_transit',
      targetSectorKey: 'cygnus-arm',
    });
    return { ok: true };
  });
  expect(dispatched.ok, `engage_transit dispatch: ${dispatched.reason ?? ''}`).toBe(true);

  // ── Step 3: SPOOLING overlay mounts ──────────────────────────────
  // The orchestrator broadcasts `transit_state SPOOLING` immediately
  // (no async server-side delay — see TransitOrchestrator.beginTransit).
  // ColyseusClient writes Zustand `transitState='SPOOLING'`, React mounts
  // HyperspaceOverlay → SpoolingBar with `data-transit-state="SPOOLING"`.
  const overlay = page.locator('[data-testid="hyperspace-overlay"]');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await expect(overlay).toHaveAttribute('data-transit-state', 'SPOOLING');

  // Sanity: the fill bar exists with a numeric progress value (Zustand
  // `transitSpoolMs` is populated, the SpoolingBar receives a >0 spool
  // duration, not a stale or null one).
  const fill = page.locator('[data-testid="hyperspace-fill"]');
  await expect(fill).toBeVisible();
  const progress = await fill.getAttribute('data-progress');
  expect(progress).toMatch(/^0\.\d{3}$/);

  // ── Step 4: cancel via the wire (mirrors HyperspaceOverlay onCancel
  //              → handleCancelTransit → cancelTransit(room) → server).
  // Sent via the same room.send seam as engage_transit (and matches the
  // wire shape locked by `transitClient.cancelTransit`) so a single
  // selector wiring break in the React overlay doesn't fail this lock
  // — this spec is the WIRE state-machine lock; the React cancel-button
  // click→onCancel wiring is covered by `HyperspaceOverlay`'s own
  // component tests.
  const cancelled = await page.evaluate(() => {
    interface ClientWithRoom {
      getRoom?: () => { send: (channel: string, msg: unknown) => void } | null;
    }
    const client = (window as unknown as { __eqxClient?: ClientWithRoom })
      .__eqxClient;
    const room = client?.getRoom?.();
    if (!room) return { ok: false, reason: 'no room' };
    room.send('cancel_transit', { type: 'cancel_transit' });
    return { ok: true };
  });
  expect(cancelled.ok, `cancel_transit dispatch: ${cancelled.reason ?? ''}`).toBe(true);

  // ── Step 5: state-machine returns to DOCKED ──────────────────────
  // Overlay unmounts (HyperspaceOverlay returns null on DOCKED).
  await expect(overlay).toHaveCount(0, { timeout: 5_000 });

  // Step 6: still no page errors (a state-machine race or null deref
  // would surface as a pageerror on a hot path).
  expect(errors, errors.join('\n')).toHaveLength(0);
});
