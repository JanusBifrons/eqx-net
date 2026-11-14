/**
 * Nose turrets turn on screen, each at its OWN angle (owner, three times:
 * "turrets still don't turn"). Showcase take 9 (fleet-melee): a drone
 * fighter's drawn nose gun sat in line with its hull while its tracers left
 * 15-20° off.
 *
 * Cause: the server pooled each snapshot's `mountAngles` arrays by length,
 * so every one-turret ship (every nose turret: fighter, scout, heavy,
 * robot-square/-circle/-hexagon) shared ONE array and the wire carried the
 * last ship's angle for all of them. Every AI pilot's nose gun was drawn at
 * some other ship's angle (often near zero) while its own shots left down
 * its real one. Server lock: SnapshotBroadcaster.mountAngles.test.ts.
 *
 * This probe films nothing; it reads the real fight at the showcase look
 * (`art=machined&fx=new&shiplight=high`, the GPU-lit path): the
 * `showcase-melee` room, drones v robots already fighting. Per drawn
 * Machined gun, `__eqxArtStats().turretAim` gives the mount angle the
 * renderer was handed (`aim`) and the angle the drawn gun art stands at
 * relative to its hull (`drawn`, from its world transform). It needs:
 *  - the one-turret AI pilots' guns NOT all at the same angle once they
 *    train on different foes (fails before the fix: identical every frame);
 *  - every drawn gun at its mount angle.
 * `?worker=0` so the stats hook reads the live renderer.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
type Aim = { id: string; mount: string; aim: number; drawn: number; shown: boolean };
type Stats = { turretAim?: Aim[] };

// Infrastructure cost only: a cold join plus the first-visit bakes.
test.describe.configure({ timeout: 90_000 });

test('AI pilots\' nose guns are drawn each at its own turret angle (GPU-lit)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'showcase-melee', shipKind: 'fighter', testId: randomUUID(), worker: '0',
    art: 'machined', fx: 'new', shiplight: 'high', zoom: '0.6', initialHull: '50000',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return el !== null && el.getAttribute('data-local-player-id') !== '';
  }, undefined, { timeout: 30_000 });
  await waitForInPlay(page);

  // The drawn one-turret guns (nose turrets) stand at at least three
  // different angles (their pilots train on different foes), for 30 frames
  // in a row. Before the fix every one of them read the same angle each
  // frame (a gun whose drone left the interest window can keep a stale
  // second value, so "two different" is not enough).
  const handle = await page.waitForFunction(() => {
    const w = window as unknown as { __eqxArtStats?: () => Stats; __noseApart?: number };
    const all = w.__eqxArtStats?.()?.turretAim ?? [];
    const guns = all.filter((a) => a.id.startsWith('swarm-') && a.shown && all.filter((o) => o.id === a.id).length === 1);
    const aims = guns.map((g) => g.aim).sort((a, b) => a - b);
    let distinct = aims.length > 0 ? 1 : 0;
    for (let i = 1; i < aims.length; i++) if (aims[i]! - aims[i - 1]! > 0.02) distinct++;
    w.__noseApart = distinct >= 3 ? (w.__noseApart ?? 0) + 1 : 0;
    return w.__noseApart >= 30 ? guns : null;
  }, undefined, { timeout: 30_000, polling: 'raf' });
  const guns = (await handle.jsonValue()) as Aim[];
  mkdirSync('diag/e2e-screenshots/nose-turret', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/nose-turret/melee.png' });
  for (const g of guns) {
    expect(Math.abs(g.drawn - g.aim), `${g.id}: drawn ${g.drawn.toFixed(3)} rad vs mount angle ${g.aim.toFixed(3)} rad`).toBeLessThan(0.02);
  }
  await ctx.close();
});
