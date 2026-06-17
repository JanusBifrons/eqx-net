/**
 * Wave-attack — player-visible E2E (Invariant #9 / #13).
 *
 * The deterministic decision logic (faction readiness, wave assignment, squad
 * state machine, de-escalation, the AI structure-targeting + escalation flip)
 * is locked at the unit + integration level (src/core/faction, src/server/
 * livingworld/director/*.test.ts, DamageRouter.dispatch). This E2E locks the
 * end-to-end player-facing essence those can't see: a real browser client with
 * a READY base draws a real drone squad through the LivingWorldDirector →
 * SectorRoom → wire → client pipeline, the "8 × Legionnaires" warp-in WARNING
 * renders in the HUD, and the squad warps in and ATTACKS the structures.
 *
 * Determinism: the `galaxy-wave-test` room (EQX_E2E_WAVE=1) seeds a player-owned
 * READY base; the owner-presence gate holds the wave until this client joins AS
 * the base owner (face0000-…), killing the pre-join race. Every assertion is
 * OUTCOME-gated (HUD testids + /dev/events), never tick/perf-gated, so a slow
 * env just takes longer. `EQX_BOT_SPOOL_MS=5000` keeps the warning banner on
 * screen ~5 s (a comfortable polling window) before the squad commits.
 *
 * Single eager `galaxy-wave-test` instance (shared, stateful) ⇒ retries OFF;
 * the test is deterministic by construction.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

// Must match `prebuiltStructuresOwner` on the `galaxy-wave-test` room define
// (src/server/index.ts). The client joins AS this id so it OWNS the seeded base
// and the owner-presence gate releases the wave.
const WAVE_OWNER_ID = 'face0000-0000-4000-8000-000000000001';

interface ServerEvent {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

async function recentEvents(): Promise<ServerEvent[]> {
  const res = await fetch(`${SERVER_URL}/dev/events?limit=500`);
  const body = (await res.json()) as { events?: ServerEvent[] };
  return body.events ?? [];
}

interface GalaxySector {
  key: string;
  players: number;
  enemies: number;
  neutrals: number;
}

/** Enemy count for the wave sector from the PUBLIC /galaxy/snapshot endpoint
 *  (the HTTP feed behind the in-game galaxy map). */
async function waveSectorEnemies(): Promise<number> {
  const res = await fetch(`${SERVER_URL}/galaxy/snapshot`);
  const body = (await res.json()) as { sectors?: GalaxySector[] };
  return body.sectors?.find((s) => s.key === 'galaxy-wave-test')?.enemies ?? 0;
}

test.describe.configure({ retries: 0 });

test('wave attack: a ready base draws an 8 × Legionnaires squad that warps in and attacks', async ({
  browser,
}) => {
  test.setTimeout(90_000);

  // Start from a clean event ring so the structure-damage assertion only sees
  // hits from THIS wave.
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });

  // Join the wave room AS the base owner (localStorage identity seeded before
  // load) so ownerPresent flips true → the director releases the wave.
  const ctx = await browser.newContext();
  await ctx.addInitScript((pid) => {
    try {
      localStorage.setItem('eqxPlayerId', pid as string);
    } catch {
      /* ignore */
    }
  }, WAVE_OWNER_ID);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=galaxy-wave-test&worker=0&spawnX=0&spawnY=600`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  // Joined + active (the ship-stats card means we're in-game; ownerPresent now true).
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 30_000 });

  // 1. The headline: the sector-wide warp-in WARNING banner for the incoming
  //    squad — "8 × Legionnaires". Appears on the first director tick after the
  //    owner is present (~1.5 s) and stays up for the ~5 s spool window.
  const banner = page.locator('[data-testid="warp-warning"][data-warning-count="8"]');
  await expect(banner).toBeVisible({ timeout: 45_000 });
  await expect(banner).toContainText('Legionnaire');
  // Phase-4 P0 — a wave squad is an ENEMY inbound, so the banner reads red
  // (relation=hostile). The warning now rides the universal warp-decision feed
  // (IncomingRegistry), not the retired wave-only final-approach branch.
  await expect(banner).toHaveAttribute('data-warning-relation', 'hostile');

  // 2. The squad actually warps IN: in-interest drones populate the swarm
  //    mirror, so the HUD swarm count goes positive.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="swarm-count"]');
      return el !== null && parseInt(el.textContent?.replace(/\D+/g, '') ?? '0', 10) > 0;
    },
    { timeout: 45_000 },
  );

  // 3. The squad ATTACKS the structures: a drone hit lands on a structure
  //    (pose-core kind 2), logged as `damage_applied` with swarmKind 2. Poll the
  //    server event ring until one appears.
  await expect
    .poll(
      async () => {
        const events = await recentEvents();
        return events.some((e) => e.tag === 'damage_applied' && e.data['swarmKind'] === 2);
      },
      { timeout: 45_000, intervals: [1000], message: 'a drone should hit a base structure' },
    )
    .toBe(true);

  // 4. A5 — the PUBLIC galaxy-map feed reflects the wave: GET /galaxy/snapshot
  //    shows enemies>0 in the wave sector. This is the endpoint behind the
  //    in-game galaxy map (the 2026-06-17 "no hostiles on the map" bug surface),
  //    zero-tested E2E before. Outcome-gated poll.
  await expect
    .poll(waveSectorEnemies, {
      timeout: 45_000,
      intervals: [1000],
      message: 'the galaxy snapshot should show hostile ships in the wave sector',
    })
    .toBeGreaterThan(0);

  await ctx.close();
});
