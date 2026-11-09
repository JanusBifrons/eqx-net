/**
 * W2c — a client sees an NPC fleet warp (spool, run, gone) (the NPC warp, W2a, end to end over
 * the real wire into a browser): after `test_fleet_warp` no ship of the staged
 * fleet (`showcase-fleet-warp`) is still drawn where it started. Written when
 * the first fleet film seemed to show the fleet staying put; it passed, and
 * the film turned out to be a camera following the fleet to its arrival (fixed
 * in the shot: a held camera). Kept as the client-side lock.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['BASE_URL'] ?? DEFAULT_BASE_URL;

interface ShipView { kind: number; x: number; visible: boolean }

async function fleetView(page: Page): Promise<ShipView[]> {
  return await page.evaluate(() => {
    const c = (globalThis as unknown as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; x: number; warp?: number }> } } }).__eqxClient;
    const out: ShipView[] = [];
    for (const e of c?.mirror.swarm.values() ?? []) if (e.kind === 1) out.push({ kind: e.kind, x: e.x, visible: e.warp !== 2 });
    return out;
  });
}

test('after test_fleet_warp no fleet ship is still shown at its start', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${BASE_URL}?room=showcase-fleet-warp&testId=${randomUUID()}&worker=0&shipKind=fighter&initialHull=1000000`);
  await page.waitForFunction(() => {
    const c = (globalThis as unknown as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
    let n = 0;
    for (const e of c?.mirror.swarm.values() ?? []) if (e.kind === 1) n++;
    return n >= 3;
  }, undefined, { timeout: 45_000 });
  const before = await fleetView(page);
  expect(before.every((s) => Math.abs(s.x) < 10_000)).toBe(true);

  // Record every warp phase the client's mirror shows for the fleet.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __seen?: Set<number>; __eqxClient?: { mirror: { swarm: Map<number, { kind: number; warp?: number }> }; getRoom?: () => { send: (ch: string, m: unknown) => void } | null } };
    const seen = new Set<number>();
    g.__seen = seen;
    setInterval(() => { for (const e of g.__eqxClient?.mirror.swarm.values() ?? []) if (e.kind === 1 && e.warp) seen.add(e.warp); }, 30);
    g.__eqxClient?.getRoom?.()?.send('test_fleet_warp', { type: 'test_fleet_warp', x: -45_000, y: 0 });
  });
  // Spool 3 s + run ~2.3 s: wait (with a deadline) until none is left at the start.
  await page.waitForFunction(() => {
    const c = (globalThis as unknown as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; x: number; warp?: number }> } } }).__eqxClient;
    for (const e of c?.mirror.swarm.values() ?? []) if (e.kind === 1 && e.warp !== 2 && Math.abs(e.x) < 10_000) return false;
    return true;
  }, undefined, { timeout: 15_000 }).catch(() => {});
  const after = await fleetView(page);
  const stillHere = after.filter((s) => s.visible && Math.abs(s.x) < 10_000);
  expect(stillHere, JSON.stringify(after)).toHaveLength(0);
  // The pilot is ~6 km south, outside the fleet's interest window: it must
  // still see the spool and the run (not a slide off screen).
  const seen = await page.evaluate(() => [...((globalThis as unknown as { __seen?: Set<number> }).__seen ?? [])].sort());
  expect(seen).toEqual(expect.arrayContaining([1, 2]));
});
