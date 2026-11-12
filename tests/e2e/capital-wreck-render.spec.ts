/**
 * Capital destruction S2b — a dead capital's wreck reaches a real browser and
 * is drawn. The `wreck-test` room (capital wrecks on) holds a peaceful
 * battleship; `test_kill_capitals` kills it, the server breaks it into wreck
 * bodies, their poses ride the binary swarm wire (v5, kind 4) and the wreck's
 * `wrecks[]` descriptor rides the snapshot. The client must rebuild every piece
 * (the same deterministic geometry) and draw one sprite per piece.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['BASE_URL'] ?? DEFAULT_BASE_URL;

interface WreckView { pieces: number; wrecks: number; drawn: number }

test('a killed capital breaks into wreck pieces the client draws', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${BASE_URL}?room=wreck-test&testId=${randomUUID()}&worker=0&shipKind=fighter&initialHull=1000000&zoom=0.12`);
  // The battleship is in the swarm mirror (drone, kind 1).
  await page.waitForFunction(() => {
    const c = (globalThis as unknown as { __eqxClient?: { mirror: { swarm?: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient;
    for (const e of c?.mirror.swarm?.values() ?? []) if (e.kind === 1 && e.shipKind === 'battleship') return true;
    return false;
  }, undefined, { timeout: 45_000 });

  await page.evaluate(() => {
    const g = globalThis as unknown as { __eqxClient?: { getRoom?: () => { send: (ch: string, m: unknown) => void } | null } };
    g.__eqxClient?.getRoom?.()?.send('test_kill_capitals', { type: 'test_kill_capitals' });
  });

  const read = (): Promise<WreckView> => page.evaluate(() => {
    const g = globalThis as unknown as {
      __eqxClient?: { mirror: { swarm?: Map<number, { kind: number }>; wrecks?: Map<number, unknown> } };
      __eqxArtStats?: () => { wreckPieces: number };
    };
    let pieces = 0;
    for (const e of g.__eqxClient?.mirror.swarm?.values() ?? []) if (e.kind === 4) pieces++;
    return { pieces, wrecks: g.__eqxClient?.mirror.wrecks?.size ?? 0, drawn: g.__eqxArtStats?.().wreckPieces ?? -1 };
  });
  await page.waitForFunction(() => {
    const g = globalThis as unknown as {
      __eqxClient?: { mirror: { swarm?: Map<number, { kind: number }> } };
      __eqxArtStats?: () => { wreckPieces: number };
    };
    let pieces = 0;
    for (const e of g.__eqxClient?.mirror.swarm?.values() ?? []) if (e.kind === 4) pieces++;
    return pieces >= 2 && (g.__eqxArtStats?.().wreckPieces ?? 0) === pieces;
  }, undefined, { timeout: 15_000 }).catch(() => {});
  const v = await read();
  expect(v.wrecks, JSON.stringify(v)).toBe(1);
  expect(v.pieces, JSON.stringify(v)).toBeGreaterThanOrEqual(2);
  expect(v.drawn, 'one sprite per wreck piece').toBe(v.pieces);
  // The battleship itself is gone from the mirror.
  const shipLeft = await page.evaluate(() => {
    const c = (globalThis as unknown as { __eqxClient?: { mirror: { swarm?: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient;
    for (const e of c?.mirror.swarm?.values() ?? []) if (e.kind === 1 && e.shipKind === 'battleship') return true;
    return false;
  });
  expect(shipLeft).toBe(false);
  if (process.env['EQX_WRECK_SHOT']) await page.screenshot({ path: process.env['EQX_WRECK_SHOT'] });
});
