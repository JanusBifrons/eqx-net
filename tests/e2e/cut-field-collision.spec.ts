/**
 * Cut field collision (macro terrain v2, flag `cutField`; invariant #9).
 *
 * Field rocks never ride the wire: the server and the client each cut the
 * same chunks from the seed and build the same fixed bodies
 * (`CutFieldStreamer`, `fieldRockBody`). So a ship ramming a field rock must
 * be blocked on BOTH sides:
 *   1. SERVER: a `collision_resolved` involving a `field:` body lands in
 *      `/dev/events`.
 *   2. WAKE (plan C2/C3): the rammed rock turns into a moving body
 *      (`field_rock_woke`) and rides the swarm wire with its rock key, so the
 *      client swaps its fixed body for the moving one (`cutFieldStats.awake`).
 *   3. CLIENT: the rendered local ship's centre never gets inside any field
 *      rock's collider (the convex hull of its outline, built from the same
 *      seed here). A missing predWorld body shows as the ship flying in, then
 *      being yanked back by correction; a missing server body as flying
 *      straight through.
 *
 * Scenario (`cut-field-test` room, seed `look`): the pilot spawns 700 u from
 * the nearest outline vertex of a field rock, facing it (`initialAngle`),
 * and holds thrust + boost (it may bounce or slide off; it must never go in).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL, DEFAULT_SERVER_URL } from './helpers/ports';
import { rocksInChunk, CHUNK_SIZE } from '../../src/core/terrain/fieldLayout';
// The same field options as `cutFieldOpts` (chunkStreamer.ts holds a class
// with parameter properties, which Playwright's strip-only loader can't load).
import { getShipKind } from '../../src/shared-types/shipKinds';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SERVER_URL = process.env['EQX_SERVER_URL'] ?? DEFAULT_SERVER_URL;

interface ServerLogEntry { ts: number; tag: string; data: Record<string, unknown> }
type CutFieldStats = { chunks: number; rocks: number; predBodies: number; awake: number };
type EqxWindow = { __eqxClient?: { cutFieldStats?: CutFieldStats } };

/** Spawn (room `defaultSpawnX/Y`) and the nearest rock outline vertex. */
const SPAWN = { x: -30_002, y: 27_191 };
const ROCK_EDGE = { x: -30_120, y: 26_501 };
const GAP = Math.hypot(ROCK_EDGE.x - SPAWN.x, ROCK_EDGE.y - SPAWN.y); // ~700
const HEAD = { x: (ROCK_EDGE.x - SPAWN.x) / GAP, y: (ROCK_EDGE.y - SPAWN.y) / GAP };
/** Deepest the ship centre may sit inside a rock hull: a blocked ship's
 *  centre stays a ship radius outside; the slack covers a brief prediction
 *  overshoot. A fly-through goes hundreds of units in. */
const MAX_DEPTH = 20;

type P = { x: number; y: number };
function convexHull(pts: readonly P[]): P[] {
  const a = [...pts].sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: P, p: P, q: P): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const lo: P[] = [], hi: P[] = [];
  for (const p of a) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, p) <= 0) lo.pop(); lo.push(p); }
  for (const p of a.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1)); // counter-clockwise
}
/** How far `p` is inside the CCW convex polygon (<= 0 = outside). */
function depthInside(h: readonly P[], p: P): number {
  let d = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!, b = h[(i + 1) % h.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    d = Math.min(d, ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len);
  }
  return d;
}
/** Every field rock collider within a chunk of the spawn, from the seed. */
const HULLS: P[][] = (() => {
  const o = { seed: 'look', battleshipLength: getShipKind('battleship').radius * 2, fighterLength: getShipKind('fighter').radius * 2 };
  const cx = Math.floor(SPAWN.x / CHUNK_SIZE), cy = Math.floor(SPAWN.y / CHUNK_SIZE);
  const out: P[][] = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const r of rocksInChunk(o, cx + i, cy + j)) out.push(convexHull(r.verts));
  return out;
})();

// Infra budget: cold Vite compile + join + chunk cut. The ram itself takes
// ~3 s of game time.
test.setTimeout(60_000);

test('ship ramming a cut-field rock is blocked on server and client', async ({ browser }) => {
  const testId = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=cut-field-test&testId=${testId}&initialAngle=2.972`);

  // The client has the rocks around the ship (predWorld bodies in).
  await page.waitForFunction(
    () => ((window as unknown as EqxWindow).__eqxClient?.cutFieldStats?.predBodies ?? 0) > 0,
    undefined,
    { timeout: 20_000 },
  );
  // Settled on the server pose before the ram.
  await page.waitForFunction(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
    try { return raw ? ((JSON.parse(raw) as { snapshotCount?: number }).snapshotCount ?? 0) >= 30 : false; } catch { return false; }
  }, undefined, { timeout: 10_000 });

  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });
  await page.locator('[data-testid="game-surface"]').click();

  let peak = -Infinity;
  let deepest = -Infinity;
  const path: P[] = [];
  const sample = async (): Promise<void> => {
    const ps = await page.evaluate(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      try { return raw ? Object.values(JSON.parse(raw) as Record<string, { x: number; y: number }>) : []; } catch { return []; }
    });
    for (const p of ps) {
      const adv = (p.x - SPAWN.x) * HEAD.x + (p.y - SPAWN.y) * HEAD.y;
      if (adv > peak) peak = adv;
      for (const h of HULLS) deepest = Math.max(deepest, depthInside(h, p));
      path.push({ x: Math.round(p.x), y: Math.round(p.y) });
    }
  };

  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(100); await sample(); }
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await sample();

  const events = ((await (await fetch(`${SERVER_URL}/dev/events?limit=500`)).json()) as { events: ServerLogEntry[] }).events;
  const woke = events.filter((e) => e.tag === 'field_rock_woke');
  const awakeOnClient = await page.waitForFunction(
    () => ((window as unknown as EqxWindow).__eqxClient?.cutFieldStats?.awake ?? 0) > 0,
    undefined,
    { timeout: 5_000 },
  ).then(() => true, () => false);
  const fieldContacts = events.filter((e) => e.tag === 'collision_resolved'
    && (String(e.data['aId']).startsWith('field:') || String(e.data['bId']).startsWith('field:')));

  // eslint-disable-next-line no-console
  console.log(`\n=== Cut-field ram: peak advance ${peak.toFixed(0)} u (rock edge at ${GAP.toFixed(0)}); deepest inside a rock ${deepest.toFixed(0)} u; field contacts ${fieldContacts.length}; woke ${woke.length}; path ${JSON.stringify(path.filter((_, i) => i % 4 === 0))} ===\n`);

  expect(peak, 'the ship must reach the rock (else the ram proves nothing)').toBeGreaterThan(GAP - 150);
  expect(fieldContacts.length, 'server must log a collision_resolved with a field: rock').toBeGreaterThan(0);
  expect(woke.length, 'the rammed field rock must wake on the server').toBeGreaterThan(0);
  expect(String(woke[0]!.data['id']).startsWith('field:')).toBe(true);
  expect(awakeOnClient, 'the woken rock must reach the client on the swarm wire').toBe(true);
  expect(deepest, `rendered ship must never go inside a field rock (deepest ${deepest.toFixed(0)} u < ${MAX_DEPTH})`).toBeLessThan(MAX_DEPTH);

  await ctx.close();
});
