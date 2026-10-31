/**
 * Living World showcase — P0 + P1a (plan peppy-jumping-pinwheel). NOT a gate:
 * a scripted run of the real game that RECORDS a video of the new loop:
 *
 *   robots vs drones fight on sight (P0) → kills drop glowing loot pods (P1a-1)
 *   → the pilot flies over them (cargo chip fills) → flies home to their
 *   Capital → holds position → "Banked …" (P1a-2).
 *
 * Run: pnpm exec playwright test --config playwright.showcase.config.ts
 * Output: diag/showcase/p1a/living-world-p1.webm (+ a few key-frame PNGs).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:5173/';
const OUT_DIR = join('diag', 'showcase', 'p1a');
const CAPITAL = { x: 0, y: -420 }; // re-picked per run (see the placement loop)

interface Pose { x: number; y: number; angle: number }

type ClientShape = {
  mirror?: {
    localPlayerId?: string | null;
    ships?: Map<string, Pose>;
    swarm?: Map<number, { kind: number; shipKind?: string; x: number; y: number }>;
  };
  getRoom?: () => { send: (type: string, msg: unknown) => void } | null;
};

async function localPose(page: Page): Promise<Pose | null> {
  return page.evaluate(() => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    const id = c?.mirror?.localPlayerId;
    const s = id ? c?.mirror?.ships?.get(id) : undefined;
    return s ? { x: s.x, y: s.y, angle: s.angle } : null;
  });
}

async function podPositions(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    const out: Array<{ x: number; y: number }> = [];
    for (const e of c?.mirror?.swarm?.values() ?? []) {
      if (e.kind === 3 && e.shipKind === 'cargo-pod') out.push({ x: e.x, y: e.y });
    }
    return out;
  });
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Steer the local ship to (tx, ty) with the real keyboard (nose = (-sin a, cos a);
 *  turnLeft increases the angle). Returns true when within `arrive` units. */
async function flyTo(page: Page, tx: number, ty: number, arrive: number, maxMs: number): Promise<boolean> {
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) { await page.keyboard.down(key); held.add(key); }
    if (!on && held.has(key)) { await page.keyboard.up(key); held.delete(key); }
  };
  const end = Date.now() + maxMs;
  let arrived = false;
  let prev: { x: number; y: number; t: number } | null = null;
  while (Date.now() < end) {
    const p = await localPose(page);
    if (p) {
      const now = Date.now();
      const speed = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(0.001, (now - prev.t) / 1000) : 0;
      prev = { x: p.x, y: p.y, t: now };
      const dx = tx - p.x;
      const dy = ty - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < arrive && speed < 150) { arrived = true; break; }
      const want = Math.atan2(-dx, dy);
      const diff = wrapPi(want - p.angle);
      await set('ArrowLeft', diff > 0.08);
      await set('ArrowRight', diff < -0.08);
      // Approach speed scales with distance so the ship doesn't overshoot;
      // brake (reverse thrust) when close and still fast.
      const cruise = Math.max(120, dist * 0.8);
      const facing = Math.abs(diff) < 0.6;
      await set('ArrowUp', facing && speed < cruise);
      await set('ArrowDown', facing && speed > cruise * 1.3 && dist < 600);
    }
    await page.waitForTimeout(50);
  }
  for (const k of [...held]) await set(k, false);
  return arrived;
}

test('Living World P1: robots vs drones → loot → carry home → bank', async ({ page }, testInfo) => {
  mkdirSync(OUT_DIR, { recursive: true });
  // A FRESH pilot per run: the shared e2e login would otherwise resume a hull
  // left lingering in this (persistent) sector by a previous recording.
  const pid = randomUUID();
  await page.addInitScript((id) => {
    try { localStorage.setItem('eqxPlayerId', id as string); } catch { /* ignore */ }
  }, pid);
  const params = new URLSearchParams({
    room: 'living-world-showcase', testId: randomUUID(), worker: '0', newShip: '1',
    spawnX: '0', spawnY: '-250', initialHull: '99999', zoom: '0.55',
  });
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('24678')) console.log('[page]', m.type(), t.slice(0, 200));
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
    { timeout: 120_000 },
  );
  // Let the warp-in curtain lift.
  await page.waitForTimeout(6_000);

  // Plant a Capital behind the pilot — home base for the deposit. The showcase
  // sector PERSISTS (earlier recordings' Capitals are restored), so pick a fresh
  // spot and confirm a structure actually appears there; retry elsewhere if the
  // placement was rejected for overlap.
  for (let attempt = 0; attempt < 6; attempt++) {
    CAPITAL.x = Math.round((Math.random() - 0.5) * 1400);
    CAPITAL.y = -420 - Math.round(Math.random() * 500);
    await page.evaluate((cap) => {
      const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
      c?.getRoom?.()?.send('place_structure', { type: 'place_structure', kind: 'capital', x: cap.x, y: cap.y });
    }, CAPITAL);
    const placed = await page.waitForFunction((cap) => {
      const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
      for (const e of c?.mirror?.swarm?.values() ?? []) {
        if (e.kind === 2 && Math.hypot(e.x - cap.x, e.y - cap.y) < 5) return true;
      }
      return false;
    }, CAPITAL, { timeout: 3_000 }).then(() => true, () => false);
    if (placed) break;
  }

  // 1) Robots and drones engage each other on sight; kills drop loot.
  await page.waitForFunction(() => {
    const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
    let n = 0;
    for (const e of c?.mirror?.swarm?.values() ?? []) if (e.kind === 3 && e.shipKind === 'cargo-pod') n++;
    return n >= 2;
  }, undefined, { timeout: 60_000 });
  await page.screenshot({ path: join(OUT_DIR, '1-fight-and-loot.png') });
  await page.waitForTimeout(4_000); // let the fight play out on camera

  // 2) Fly over the pods (nearest first) — the cargo chip fills.
  for (let i = 0; i < 6; i++) {
    const pods = await podPositions(page);
    const me = await localPose(page);
    if (pods.length === 0 || me === null) break;
    pods.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    await flyTo(page, pods[0]!.x, pods[0]!.y, 50, 12_000);
    await page.waitForTimeout(400);
  }
  await expect(page.getByTestId('cargo-chip')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(OUT_DIR, '2-cargo-collected.png') });

  // 3) Fly home and hold position by the Capital — auto-deposit.
  await flyTo(page, CAPITAL.x + 180, CAPITAL.y, 160, 25_000);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('loot-feed-line').filter({ hasText: 'Banked' })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: join(OUT_DIR, '3-banked.png') });
  await page.waitForTimeout(2_500);

  // Copy the recording out once the page closes (Playwright finalises it then).
  const video = page.video();
  await page.close();
  if (video) {
    const src = await video.path();
    copyFileSync(src, join(OUT_DIR, 'living-world-p1.webm'));
    testInfo.attachments.push({ name: 'video', path: src, contentType: 'video/webm' });
  }
});
