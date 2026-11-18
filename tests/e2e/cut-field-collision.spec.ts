/**
 * Cut field collision (macro terrain v2, flag `cutField`; invariant #9).
 *
 * Field rocks never ride the wire: the server and the client each cut the
 * same chunks from the seed and build the same fixed bodies
 * (`CutFieldStreamer`, `fieldRockBody`). So a ship ramming a field rock must
 * be blocked on BOTH sides:
 *   1. SERVER: a `collision_resolved` involving a `field:` body lands in
 *      `/dev/events`.
 *   2. NO WAKE (rock mass, owner 2026-11-16): a rock wakes only to a body at
 *      least as heavy as itself (`fieldRockWakes`), and the fighter is far
 *      lighter than any field rock, so no `field_rock_woke` is logged and the
 *      rock stays FIXED on both sides (`cutFieldStats.awake` stays 0).
 *   3. CLIENT: the rendered local ship's centre never gets inside any field
 *      rock's drawn outline (built from the same seed here) by more than the
 *      collider's smoothing (`FIELD_COLLIDER_SIMPLIFY`, plan C1: the collider
 *      follows the outline's dents, so a ship may slide into one). A missing predWorld body shows as the ship flying in, then
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
import { fieldRocksNear, depthInside, depthInsideOutline, type FieldPoint } from './helpers/fieldRocks';

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
/** Deepest the ship centre may sit inside a rock outline, past the rock's
 *  collider smoothing: a blocked ship's centre stays a ship radius outside;
 *  the slack covers a brief prediction overshoot. A fly-through goes hundreds
 *  of units in. */
const MAX_DEPTH = 20;

type P = FieldPoint;
const ROCKS = fieldRocksNear(SPAWN);

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
      for (const r of ROCKS) deepest = Math.max(deepest, depthInsideOutline(r.outline, p) - r.slack);
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
  const awakeOnClient = await page.evaluate(() => (window as unknown as EqxWindow).__eqxClient?.cutFieldStats?.awake ?? 0);
  const fieldContacts = events.filter((e) => e.tag === 'collision_resolved'
    && (String(e.data['aId']).startsWith('field:') || String(e.data['bId']).startsWith('field:')));

  // eslint-disable-next-line no-console
  console.log(`\n=== Cut-field ram: peak advance ${peak.toFixed(0)} u (rock edge at ${GAP.toFixed(0)}); deepest inside a rock ${deepest.toFixed(0)} u; field contacts ${fieldContacts.length}; woke ${woke.length}; path ${JSON.stringify(path.filter((_, i) => i % 4 === 0))} ===\n`);

  expect(peak, 'the ship must reach the rock (else the ram proves nothing)').toBeGreaterThan(GAP - 150);
  expect(fieldContacts.length, 'server must log a collision_resolved with a field: rock').toBeGreaterThan(0);
  expect(woke.length, 'a fighter never wakes a field rock (rock mass)').toBe(0);
  expect(awakeOnClient, 'no field rock is awake on the client').toBe(0);
  expect(deepest, `rendered ship must never go inside a field rock past its collider smoothing (deepest ${deepest.toFixed(0)} u < ${MAX_DEPTH})`).toBeLessThan(MAX_DEPTH);

  await ctx.close();
});

/** A spot in a dent of a field rock near the test spawn: 48 u inside the
 *  rock's convex hull, yet ~40 u clear of the rock's real outline and of its
 *  collider parts (plan C1; locked by `packedChunk.test.ts` "dent spot"). A
 *  fighter's shield bubble is 34 u. */
const DENT = { x: -30_698, y: 25_366 };

test('a ship parked in a rock\'s dent is not shoved out (colliders follow the outline, plan C1)', async ({ browser }) => {
  // The old single convex hull fills the dent: that rock would sit on the
  // ship and push it out (a field: contact on the server, the ship moved).
  expect(Math.max(...ROCKS.map((r) => depthInside(r.hull, DENT))), 'the spot is inside a rock hull').toBeGreaterThan(40);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=cut-field-test&testId=${randomUUID()}&spawnX=${DENT.x}&spawnY=${DENT.y}`);
  await page.waitForFunction(
    () => ((window as unknown as EqxWindow).__eqxClient?.cutFieldStats?.predBodies ?? 0) > 0,
    undefined,
    { timeout: 20_000 },
  );
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });
  const pos = async (): Promise<P | null> => page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
    try { const v = raw ? Object.values(JSON.parse(raw) as Record<string, { x: number; y: number }>) : []; return v[0] ?? null; } catch { return null; }
  });
  let drift = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    const p = await pos();
    if (p) drift = Math.max(drift, Math.hypot(p.x - DENT.x, p.y - DENT.y));
  }
  const events = ((await (await fetch(`${SERVER_URL}/dev/events?limit=500`)).json()) as { events: ServerLogEntry[] }).events;
  const fieldContacts = events.filter((e) => e.tag === 'collision_resolved'
    && (String(e.data['aId']).startsWith('field:') || String(e.data['bId']).startsWith('field:')));
  console.log(`\n=== Cut-field dent: drift ${drift.toFixed(1)} u; field contacts ${fieldContacts.length} ===\n`);
  expect(fieldContacts.length, 'no rock touches the parked ship').toBe(0);
  // Measured: ~4 u with the parts (spawn settle), ~34 u with one hull (pushed out).
  expect(drift, 'the parked ship stays where it spawned').toBeLessThan(10);
  await ctx.close();
});
