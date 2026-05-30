/**
 * Hull-collision determinism spec — 2026-05-28.
 *
 * Spawns two stationary Crossguard T-ships positioned so their shield
 * bubbles overlap massively but their actual polygon silhouettes don't
 * touch. With shields force-dropped at spawn (`hullExposed: true` on the
 * `dronePoses` room option), the polygon compound collider is what's
 * under test. A correctly-decomposed concave T leaves the crossbar-tip
 * gap regions empty and emits ZERO contacts; a buggy concave hull
 * (filled gap, overlapping triangles, wrong winding, or anything that
 * makes the polygon collider exceed the rendered silhouette) emits
 * non-zero contacts.
 *
 * Why we read `/dev/events` (server log) instead of
 * `data-pred-stats.collisionEventsApplied` (client counter): the client
 * counter only increments when `applyCollisionResolved`'s outcome
 * `applied.length > 0`, which requires the involved bodies to be in the
 * client's `predWorld`. Drones are keyed `swarm-${entityId}` in the
 * client predWorld but `pose-drone-N` on the wire — they never match,
 * so a drone-vs-drone `collision_resolved` is a silent no-op on the
 * client. The server's ring-buffer (`serverLogEvent` → `/dev/events`)
 * is the unfiltered source of truth: every contact above the worker's
 * `CONTACT_FORCE_FLOOR=200` is logged here regardless of the client's
 * predWorld state. That's the right level for testing whether the
 * SERVER PHYSICS detects a collision, which is what the concave hull
 * affects.
 *
 * Scenario geometry (entity-local Pixi-up, post `scale: 10`):
 *   - Crossbar: x ∈ [-140, 140], y ∈ [-160, -100]
 *   - Stem:     x ∈ [ -40,  40], y ∈ [ -80,  120]
 *
 * World placement (negative control — `hull-collision-test`):
 *   - Drone 0: (x=0, y=-130, angle=0)    regular T — stem-tip at world y = -10
 *   - Drone 1: (x=0, y=+130, angle=π)    inverted T — stem-tip at world y = +10
 *   - Gap between stem-tips: 20 u; both stems at x ∈ [-40, 40].
 *
 * World placement (positive control — `hull-collision-overlap-test`):
 *   - Drone 0: (x=0, y=0, angle=0)
 *   - Drone 1: (x=0, y=0, angle=π)  ← identical position
 *
 * Per Invariant #13 (failing-test-first): if the concave hull is broken,
 * the negative-control fires non-zero events. The positive-control is
 * the live-surface guard — it MUST fire events, otherwise the test
 * infrastructure isn't actually observing collisions and the negative
 * assertion is meaningless.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['EQX_SERVER_URL'] ?? 'http://localhost:2567';

interface ServerLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

async function clearServerEvents(): Promise<void> {
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });
}

async function fetchServerEvents(): Promise<ServerLogEntry[]> {
  const res = await fetch(`${SERVER_URL}/dev/events?limit=500`);
  const json = (await res.json()) as { events: ServerLogEntry[] };
  return json.events;
}

function countCollisionEvents(events: ServerLogEntry[]): {
  resolved: ServerLogEntry[];
  ramDamage: ServerLogEntry[];
} {
  return {
    resolved: events.filter((e) => e.tag === 'collision_resolved'),
    ramDamage: events.filter((e) => e.tag === 'ram_damage'),
  };
}

test.setTimeout(20_000);

test('NEGATIVE control: two stationary T-ships with overlapping bounding circles do NOT collide', async ({ browser }) => {
  await clearServerEvents();
  const testId = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE_URL}?room=hull-collision-test&testId=${testId}`);

  // Both drones live (HudTestAttributes mirrors swarm count as text).
  await page.waitForFunction(
    () =>
      parseInt(
        document
          .querySelector('[data-testid="swarm-count"]')
          ?.textContent?.replace(/[^0-9]/g, '') ?? '0',
        10,
      ) >= 2,
    { timeout: 10_000 },
  );

  // Let the physics + snapshot pipeline run for ~30 snapshots (1.5 s at
  // 20 Hz). Any collision between the two stationary drones would have
  // resolved well within this window — Rapier's contact-force events fire
  // every step, and the server's collision_resolved + ram_damage logs land
  // immediately. Snapshot-count gate, NOT waitForTimeout (harness rule).
  await page.waitForFunction(
    () => {
      const raw = document
        .querySelector('[data-testid="game-surface"]')
        ?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        const stats = JSON.parse(raw) as { snapshotCount?: number };
        return (stats.snapshotCount ?? 0) >= 30;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  );

  const events = await fetchServerEvents();
  const { resolved, ramDamage } = countCollisionEvents(events);

  console.log('\n=== NEGATIVE control — server log ===');
  console.log(`collision_resolved entries: ${resolved.length}`);
  console.log(`ram_damage entries: ${ramDamage.length}`);
  if (resolved.length > 0) {
    console.log('First few resolved:', JSON.stringify(resolved.slice(0, 3), null, 2));
  }
  console.log('======================================\n');

  // Only events involving the two test drones count toward the assertion;
  // anything else is unrelated background noise (there shouldn't be any
  // in a fresh test room, but be defensive).
  const droneA = 'pose-drone-0';
  const droneB = 'pose-drone-1';
  const involvesTestDrones = (e: ServerLogEntry): boolean => {
    const a = e.data['aId'];
    const b = e.data['bId'];
    const both = [a, b].sort().join('|');
    return both === [droneA, droneB].sort().join('|');
  };
  const filteredResolved = resolved.filter(involvesTestDrones);
  const filteredRam = ramDamage.filter(involvesTestDrones);

  expect(filteredResolved.length, 'collision_resolved between test drones').toBe(0);
  expect(filteredRam.length, 'ram_damage between test drones').toBe(0);

  await ctx.close();
});

test('POSITIVE control: two overlapping T-ships DO collide (proves the test surface is live)', async ({ browser }) => {
  await clearServerEvents();
  const testId = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE_URL}?room=hull-collision-overlap-test&testId=${testId}`);

  await page.waitForFunction(
    () =>
      parseInt(
        document
          .querySelector('[data-testid="swarm-count"]')
          ?.textContent?.replace(/[^0-9]/g, '') ?? '0',
        10,
      ) >= 2,
    { timeout: 10_000 },
  );

  await page.waitForFunction(
    () => {
      const raw = document
        .querySelector('[data-testid="game-surface"]')
        ?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        const stats = JSON.parse(raw) as { snapshotCount?: number };
        return (stats.snapshotCount ?? 0) >= 30;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  );

  const events = await fetchServerEvents();
  const { resolved, ramDamage } = countCollisionEvents(events);

  console.log('\n=== POSITIVE control — server log ===');
  console.log(`collision_resolved entries: ${resolved.length}`);
  console.log(`ram_damage entries: ${ramDamage.length}`);
  console.log('======================================\n');

  expect(resolved.length, 'positive control must log collision_resolved').toBeGreaterThan(0);

  await ctx.close();
});
