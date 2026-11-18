/**
 * Autopilot (navigation slice 13): a fighter given a course point on the far
 * side of a field rock flies round it, not into it.
 *
 * The course is set through the client's own helm (`__eqxClient.setHelmCourse`,
 * the same call a tap on empty space makes; the tap itself is covered by
 * `capital-helm.spec.ts`). The client asks the server for a route
 * (`nav_route_request`), the reply loads into the helm order, and the helm
 * flies it with ordinary inputs. Checked:
 *   1. a route came back (the helm order holds waypoints);
 *   2. the ship arrives at the point (the order ends on arrival);
 *   3. it never touched the rock: no server `collision_resolved` with a
 *      `field:` body, and the drawn ship centre never inside a rock outline.
 *
 * Scenario (`cut-field-test` room, seed `look`): at the field's eastern rim, a
 * ~300 u rim rock sits on the straight line between spawn S and course point G
 * (both ~800 u clear of rock, outside the field); the planner routes one turn
 * round it on the open side. The fighter spawns at S facing G. (Inside the field the rock
 * tiles the space: a fighter crosses packed chunks only by street, so a rock
 * to go round in open water is found at the rim; navigation guide, fine layer.)
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL, DEFAULT_SERVER_URL } from './helpers/ports';
import { fieldRocksNear, depthInsideOutline } from './helpers/fieldRocks';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SERVER_URL = process.env['EQX_SERVER_URL'] ?? DEFAULT_SERVER_URL;

interface ServerLogEntry { ts: number; tag: string; data: Record<string, unknown> }
type HelmRead = { active: boolean; tx: number; ty: number; route?: { n: number; idx: number } | null };
type EqxWindow = { __eqxClient?: { mirror?: { localPlayerId?: string | null }; cutFieldStats?: { predBodies: number }; setHelmCourse(x: number, y: number): void; getHelmOrder(): HelmRead } };

const S = { x: -7_192, y: 13_288 };
const G = { x: -6_792, y: 10_392 };
/** The deepest point of rock on the straight line S→G (~156 u inside). */
const ROCK_CENTRE = { x: -6_990, y: 11_826 };
/** Nose along S→G: forward is (-sin θ, cos θ). */
const FACING = Math.atan2(-(G.x - S.x), G.y - S.y);
const ROCKS = fieldRocksNear(S);
/** Deepest the drawn ship centre may sit inside a rock outline past its collider smoothing (as cut-field-collision). */
const MAX_DEPTH = 20;
/** Done this near the point (the fighter's helm arrival is a few tens of u). */
const ARRIVED_WITHIN = 150;

// Infra budget: cold Vite compile + join + chunk cut; the flight is ~3 km at fighter speed (~6 s).
test.setTimeout(60_000);

test('a fighter on autopilot flies round a field rock to the far side', async ({ browser }) => {
  // Precondition (from the seed): the rock sits on the straight line, the ends are clear.
  expect(Math.max(...ROCKS.map((r) => depthInsideOutline(r.outline, ROCK_CENTRE))), 'a rock covers the straight line').toBeGreaterThan(120);
  for (const p of [S, G]) expect(Math.max(...ROCKS.map((r) => depthInsideOutline(r.outline, p))), 'spawn and goal are open water').toBeLessThan(-500);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=cut-field-test&testId=${randomUUID()}&spawnX=${S.x}&spawnY=${S.y}&initialAngle=${FACING.toFixed(4)}`);
  await page.waitForFunction(() => ((window as unknown as EqxWindow).__eqxClient?.cutFieldStats?.predBodies ?? 0) > 0, undefined, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
    try { return raw ? ((JSON.parse(raw) as { snapshotCount?: number }).snapshotCount ?? 0) >= 30 : false; } catch { return false; }
  }, undefined, { timeout: 10_000 });

  // The helm takes orders once the panel shows (the physics loop runs past the loading curtain).
  await page.getByTestId('helm-panel').waitFor({ timeout: 10_000 });
  // The dev event log is server-wide (AI haulers in other sectors touch their rock too): count this ship's contacts only.
  const me = await page.evaluate(() => (window as unknown as EqxWindow).__eqxClient?.mirror?.localPlayerId ?? '');
  expect(me, 'the local ship id is known').not.toBe('');
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });
  await page.evaluate(([x, y]) => { (window as unknown as EqxWindow).__eqxClient!.setHelmCourse(x!, y!); }, [G.x, G.y]);

  // 1. The server's route reaches the helm.
  await expect.poll(() => page.evaluate(() => (window as unknown as EqxWindow).__eqxClient!.getHelmOrder().route?.n ?? 0), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2);

  // 2 + 3. Fly it, sampling the drawn ship.
  let deepest = -Infinity;
  const path: { x: number; y: number }[] = [];
  let active = true;
  let last = { x: S.x, y: S.y };
  for (let i = 0; i < 250 && active; i++) {
    await page.waitForTimeout(100);
    const s = await page.evaluate(() => {
      const el = document.querySelector('[data-ship-x]') as HTMLElement | null;
      return { x: Number(el?.dataset['shipX']), y: Number(el?.dataset['shipY']), active: (window as unknown as EqxWindow).__eqxClient!.getHelmOrder().active };
    });
    active = s.active;
    if (Number.isNaN(s.x)) continue;
    last = { x: s.x, y: s.y };
    for (const r of ROCKS) deepest = Math.max(deepest, depthInsideOutline(r.outline, last) - r.slack);
    if (i % 5 === 0) path.push({ x: Math.round(s.x), y: Math.round(s.y) });
  }

  const events = ((await (await fetch(`${SERVER_URL}/dev/events?limit=500`)).json()) as { events: ServerLogEntry[] }).events;
  const fieldContacts = events.filter((e) => e.tag === 'collision_resolved'
    && (e.data['aId'] === me || e.data['bId'] === me)
    && (String(e.data['aId']).startsWith('field:') || String(e.data['bId']).startsWith('field:')));
  const endDist = Math.hypot(last.x - G.x, last.y - G.y);
  console.log(`\n=== Autopilot round a rock: end ${endDist.toFixed(0)} u from the point; deepest ${deepest.toFixed(0)}; field contacts ${fieldContacts.length}; path ${JSON.stringify(path)} ===\n`);

  expect(active, 'the helm order ends on arrival').toBe(false);
  expect(endDist, 'arrived at the point').toBeLessThan(ARRIVED_WITHIN);
  expect(fieldContacts.length, 'never touched a field rock (server)').toBe(0);
  expect(deepest, 'drawn ship never inside a rock').toBeLessThan(MAX_DEPTH);
  await ctx.close();
});
