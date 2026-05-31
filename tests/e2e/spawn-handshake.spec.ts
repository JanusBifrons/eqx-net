import { test, expect } from '@playwright/test';

/**
 * Plan: crispy-kazoo — RED-first regression lock for the
 * loaded-then-visible spawn handshake (Invariant #13).
 *
 * Reproduces the 2026-05-31 smoke failure (capture
 * `2026-05-31T09-48-17Z-o6wpal`): user clicks Join → galaxy screen →
 * test-sector. Welcome arrives, then `predworld_init_deferred
 * reason: 'no-mirror-entry'` and the handshake stalls forever — the
 * curtain stays up, the player is trapped.
 *
 * Root chain (the test catches the whole class, not just the
 * proximate bug):
 *  1. Server sets `ship.isActive = false` on join (handshake design).
 *  2. Client snapshot translator routes `isActive=false` to
 *     `mirror.lingeringShips`. The joiner's OWN ship ends up there
 *     instead of `mirror.ships`.
 *  3. `tryInitPredWorld(localPlayerId)` finds no entry in
 *     `mirror.ships` → returns early. `localPoseResolved` never
 *     flips → bootstrap stuck.
 *  4. Even if (3) were fixed, the pause-boundary in gameRafLoop
 *     early-returns on `computeIsLoadingActive=true` BEFORE
 *     `renderer.update(mirror)` — so `firstFrameRendered` (which
 *     requires `mirror.ships.has(localPlayerId)` AND a renderer
 *     paint pass) can never flip. Circular dependency.
 *
 * THE LOCK: `data-loading-active="0"` must appear within 20s of
 * sector pick. If it doesn't, the handshake is stalled and the
 * user is trapped. The test fails LOUDLY against a broken HEAD.
 *
 * Why E2E (not unit / integration): the bug class lives at the
 * SnapshotMessage → translator → predWorld → renderer-feedback
 * boundary. A unit on syncMirror passed in isolation pre-fix
 * (CLAUDE.md damage-number incident, 2026-05-14: the test must
 * cross the seam where the bug lives). Playwright + real client
 * + real Colyseus + real test-sector room is the right level.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.describe('spawn handshake — curtain must drop within a reasonable window', () => {
  test('engineering test-sector: handshake completes, data-loading-active flips 1→0', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('text=Join the fight').first().click();
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

    // Engineering test-sector path — deterministic, no Pixi click.
    // Goes through the same handleSelectRoom flow as the galaxy-pick
    // path; on the server the test-sector room is testMode=true but
    // still hits the spawn-handshake onJoin code path (the joiner is
    // still spawned with isActive=false unless a bypass is wired).
    await page.locator('[data-testid="engineering-rooms-button"]').click();
    await page.locator('[data-testid="engineering-room-test-sector"]').click();

    // Loading curtain is up: data-loading-active === "1".
    // HudTestAttributes is the always-mounted contract surface.
    const hudAttrs = page.locator('[data-testid="hud-test-attributes"]');
    await expect(hudAttrs).toHaveAttribute('data-loading-active', '1', { timeout: 10_000 });

    // ── THE LOCK ────────────────────────────────────────────────────
    // Within 20s of the curtain rising, the handshake must complete
    // (server gets `client_ready`, broadcasts `warp_in` with
    // `arrivalTick`, client schedules curtain drop at arrivalTick,
    // `data-loading-active` flips to "0").
    //
    // A broken handshake (the 2026-05-31 stall) leaves this stuck on
    // "1" forever — Playwright times out and fails with a precise
    // signal at the assertion (NOT a generic page-load timeout).
    //
    // 20s margin: client minDisplay floor is 3-5s, snapshot intervals
    // are ~50ms, ARRIVAL_OFFSET_TICKS adds ~100ms — typical end-to-end
    // is well under 8s. Anything over 20s indicates a real stall.
    await expect(hudAttrs).toHaveAttribute('data-loading-active', '0', { timeout: 20_000 });

    // Sanity: the ship-stats-card paints after the curtain drops
    // (existing spawn-select-flow.spec.ts contract).
    await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 5_000 });

    // No JS runtime errors during the join.
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
