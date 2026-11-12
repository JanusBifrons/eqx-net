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

/**
 * Capital destruction S3 — with the Machined look on, every piece draws the
 * dead battleship's OWN baked art (no re-bake), its cut edges glow molten
 * right after the break-up, and the break-up burst plays once.
 * `EQX_WRECK_SHOT_DIR` saves `hot.png` (~0.5 s after death) and `cool.png`
 * (~6 s) for review.
 */
test('wreck pieces wear the dead ship\'s art and their cut edges glow (S3)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${BASE_URL}?room=wreck-test&testId=${randomUUID()}&worker=0&shipKind=fighter&initialHull=1000000&zoom=0.12&art=machined&fx=new&spawnX=1800&spawnY=2500`);
  type Stats = { machinedSprites: number; wreckPieces: number; wreckTextured: number; wreckGlowing: number; wreckBreaks: number };
  // The battleship (and our ship) draw Machined: the parent art is baked.
  await page.waitForFunction(() => {
    const s = (globalThis as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.();
    return (s?.machinedSprites ?? 0) >= 2;
  }, undefined, { timeout: 90_000 });

  await page.evaluate(() => {
    const g = globalThis as unknown as { __eqxClient?: { getRoom?: () => { send: (ch: string, m: unknown) => void } | null } };
    g.__eqxClient?.getRoom?.()?.send('test_kill_capitals', { type: 'test_kill_capitals' });
  });
  await page.waitForFunction(() => {
    const s = (globalThis as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.();
    return (s?.wreckPieces ?? 0) >= 2;
  }, undefined, { timeout: 15_000 });
  const t0 = Date.now();
  const stats = (): Promise<Stats> => page.evaluate(() => (globalThis as unknown as { __eqxArtStats: () => Stats }).__eqxArtStats());
  const hot = await stats();
  expect(hot.wreckTextured, JSON.stringify(hot)).toBe(hot.wreckPieces);
  expect(hot.wreckGlowing, JSON.stringify(hot)).toBeGreaterThan(0);
  expect(hot.wreckBreaks, JSON.stringify(hot)).toBe(1);
  const dir = process.env['EQX_WRECK_SHOT_DIR'];
  if (dir) {
    await page.waitForTimeout(Math.max(0, 500 - (Date.now() - t0)));
    await page.screenshot({ path: `${dir}/hot.png` });
    await page.waitForTimeout(Math.max(0, 6000 - (Date.now() - t0)));
    await page.screenshot({ path: `${dir}/cool.png` });
    const cool = await stats();
    expect(cool.wreckTextured, JSON.stringify(cool)).toBe(cool.wreckPieces);
  }
});
