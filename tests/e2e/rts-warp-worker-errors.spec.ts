/**
 * RTS smoke test (owner, 2026-11-14, desktop Chrome, default WORKER render
 * path, Command view): warping between sectors filled the console with
 *
 *   [render-worker] worker error: Cannot read properties of undefined (reading 'onPointerMove')   (x7)
 *
 * Every sector load boots a fresh render worker (the first join, and every
 * re-join into another sector). `WorkerRendererClient.init` posts BOOT and
 * installs the canvas pointer/wheel listeners at once, while the worker's
 * `PixiRenderer.init` is still awaiting Pixi; the worker exposed the renderer
 * before init resolved, so a mouse move in that window reached
 * `forwardPointerEvent` with no Camera built yet. The worker now drops input
 * until READY (`rendererReady` in `renderer.worker.ts`).
 *
 * The bug lives across the render-worker boundary, so this runs on the
 * default worker path (never `?worker=0`) and reads the worker's errors off
 * the page console (`WorkerRendererClient` logs the worker's ERROR message
 * and its `onerror`). Repro: keep the mouse moving over the canvas while a
 * galaxy sector loads in Command view, as a player's hand on the mouse does
 * (the per-test `galaxy-test` room: a galaxy sector with no shared state).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SURFACE = '[data-testid="game-surface"]';

/** Render-worker failures as the page console shows them. */
function collectWorkerErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[render-worker]')) errors.push(t);
  });
  return errors;
}

/** Keep the mouse moving over the page until `stop()`. */
function wiggleMouse(page: Page): { stop: () => Promise<void> } {
  let moving = true;
  const run = (async () => {
    for (let i = 0; moving; i++) {
      await page.mouse.move(300 + (i % 20) * 20, 300 + (i % 7) * 10).catch(() => undefined);
      await page.waitForTimeout(16).catch(() => undefined);
    }
  })();
  return { stop: async () => { moving = false; await run; } };
}

test.describe('RTS sector load on the worker render path @feature', () => {
  test('loading a sector in Command view with the mouse moving raises no render-worker errors', async ({ browser }) => {
    test.setTimeout(60_000);
    // A fresh pilot in its own galaxy-test room (as `launchGalaxyTestClient`,
    // but on the default worker path): a shared account's saved ship would
    // decide the landing mode instead of `startMode`.
    const ctx = await browser.newContext();
    await ctx.addInitScript((pid) => {
      try { localStorage.setItem('eqxPlayerId', pid as string); } catch { /* ignore */ }
    }, randomUUID());
    const page = await ctx.newPage();
    const errors = collectWorkerErrors(page);
    const mouse = wiggleMouse(page);
    const params = new URLSearchParams({ room: 'galaxy-test', testId: randomUUID(), shipKind: 'fighter', startMode: 'command' });
    await page.goto(`${BASE_URL}/?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector(SURFACE, { timeout: 20_000 });
    await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute('data-warp-visible', '0', { timeout: 30_000 });
    await expect(page.locator(SURFACE)).toHaveAttribute('data-pilot-mode', 'spectator', { timeout: 15_000 });
    await mouse.stop();
    expect(errors, errors.join('\n')).toEqual([]);
    await ctx.close();
  });
});
