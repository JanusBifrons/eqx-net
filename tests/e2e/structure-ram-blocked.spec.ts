/**
 * Structure ram-through regression lock — playtest 2026-06-10 Issue 4
 * ("the collision boxes are just completely broken… you can fly right into
 * a 'capital'").
 *
 * A capital (and every structure) is a pose-core kind-2 entity with a BALL
 * collider — server-side via `SwarmSpawner.spawnStructure` → `postSpawnObstacle`,
 * client-side via `structureClientLeaf` → `spawnObstacle` + `lockBody`. So a
 * player thrusting into one should be BLOCKED, exactly like ramming an asteroid.
 * This is the structure half of Issue 4 — DISTINCT from the T-ship hull-collider
 * fix (hull-exposed ships use triangle colliders; structures are balls), so the
 * triangle revert does not touch this path.
 *
 * Scenario (`structure-test` room): the local player spawns at math (0, 0)
 * facing +Y (spawn angle 0 → forward = +Y); a structure `struct-0` sits
 * straight ahead at (0, 150) with collider radius 60. Holding thrust drives
 * the player straight into it.
 *
 * Two independent assertions, so a failure localises:
 *   1. SERVER registered the contact — a `collision_resolved` involving
 *      `struct-0` lands in `/dev/events` (the structure body is solid + has
 *      CONTACT_FORCE_EVENTS, and the player rams it with closing velocity).
 *   2. CLIENT didn't fly through — the rendered local-ship position
 *      (`data-ship-positions`, the render mirror = what the player SEES) never
 *      penetrates past the structure's near surface. Contact is at player
 *      centre y ≈ 150 − 60 − 12(ball) = 78; a deep penetration / pass-through
 *      (y → 150+) is the user's "fly right into it" symptom.
 *
 * Per Invariant #13 this is the failing-test-first repro: if structures don't
 * actually block, assertion 1 (no contact) and/or assertion 2 (penetration)
 * fail RED on current code. If both pass, structure blocking works server-side
 * and the "fly into a capital" report is a client-prediction/feel issue or
 * scenario-specific (→ on-device capture).
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

/** Structure-test geometry (the structure sits straight ahead at +Y). */
const STRUCT_Y = 150;
const STRUCT_RADIUS = 60;
/** The deepest a non-penetrating player centre can sit (structure near edge
 *  minus the fighter ball radius), plus a small tolerance for the prediction /
 *  lerp overshoot that a healthy block still shows briefly. A genuine
 *  fly-through drives y toward/past the structure CENTRE (150). */
const MAX_PLAYER_Y = STRUCT_Y - STRUCT_RADIUS + 20; // 110
/** P3.10 (P0) — a structure must be IMMOVABLE. Rendered from the swarm mirror
 *  (interpolated off the authoritative pose), a locked structure stays put; a
 *  ram that shoves it (the "I hit a pylon and it MOVED" bug) drifts it well past
 *  this tolerance. Small tolerance covers interpolation/quantisation jitter on a
 *  truly-static pose. */
const MAX_STRUCT_DRIFT = 12;

// Infra budget: cold Vite compile of the structure-test page + join/snapshot
// settle + the ram sampling loop. NOT a game-time wait (the player reaches the
// structure in < 1 s) — harness rule: bump for infra, not gameplay.
test.setTimeout(50_000);

test('player ramming a structure is BLOCKED, not flown through (Issue 4)', async ({ browser }) => {
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });
  const testId = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE_URL}?room=structure-test&testId=${testId}`);

  // Structure live (swarm-count counts the kind-2 entity) + player on the map.
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="ship-count"]')?.textContent?.replace(/[^0-9]/g, '') ?? '0',
        10,
      ) >= 1
      && parseInt(
        document.querySelector('[data-testid="swarm-count"]')?.textContent?.replace(/[^0-9]/g, '') ?? '0',
        10,
      ) >= 1,
    { timeout: 15_000 },
  );

  // Let the spawn lerp settle so the pre-ram baseline is at predWorld.
  await page.waitForFunction(
    () => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        return ((JSON.parse(raw) as { snapshotCount?: number }).snapshotCount ?? 0) >= 30;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  );

  // Drop spawn-window noise; we want only contacts from the ramming phase.
  await fetch(`${SERVER_URL}/dev/events/clear`, { method: 'POST' });
  await page.locator('[data-testid="game-surface"]').click();

  // Hold thrust + boost forward (+Y) into the structure. Sample the rendered
  // local-ship Y every 100 ms so we catch any transient deep penetration, not
  // just the settled pose.
  let peakY = -Infinity;
  const sampleY = async (): Promise<void> => {
    const ys = await page.evaluate(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      if (!raw) return [] as number[];
      try {
        const m = JSON.parse(raw) as Record<string, { x: number; y: number }>;
        return Object.values(m).map((p) => p.y);
      } catch {
        return [] as number[];
      }
    });
    for (const y of ys) if (y > peakY) peakY = y;
  };

  // P3.10 — read the structure's rendered pose (the kind-2 swarm entry; the
  // mirror is keyed `swarm-<numericId>`, so locate it by `kind`, not 'struct-0').
  const readStructPose = async (): Promise<{ x: number; y: number } | null> =>
    page.evaluate(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-swarm-detail');
      if (!raw) return null;
      try {
        const m = JSON.parse(raw) as Record<string, { x: number; y: number; kind: number }>;
        const s = Object.values(m).find((e) => e.kind === 2);
        return s ? { x: s.x, y: s.y } : null;
      } catch {
        return null;
      }
    });

  // Baseline the structure's pre-ram pose, then track the worst drift from it.
  const structBase = await readStructPose();
  let structPeakDrift = 0;
  const sampleStruct = async (): Promise<void> => {
    if (!structBase) return;
    const p = await readStructPose();
    if (!p) return;
    const d = Math.hypot(p.x - structBase.x, p.y - structBase.y);
    if (d > structPeakDrift) structPeakDrift = d;
  };

  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  // ~1.6 s of thrust: the player covers the ~78 u gap in well under a second,
  // so the back half is steady-state press against the structure (the regime
  // where a fly-through would manifest). Sample peak Y throughout.
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(100);
    await sampleY();
    await sampleStruct();
  }
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await sampleY();
  await sampleStruct();

  const res = await fetch(`${SERVER_URL}/dev/events?limit=500`);
  const events = ((await res.json()) as { events: ServerLogEntry[] }).events;
  const structContacts = events.filter(
    (e) => e.tag === 'collision_resolved' && (e.data['aId'] === 'struct-0' || e.data['bId'] === 'struct-0'),
  );

  // eslint-disable-next-line no-console
  console.log(`\n=== Structure ram — peak rendered player Y = ${peakY.toFixed(1)} (structure at y=${STRUCT_Y}, r=${STRUCT_RADIUS}, block-line ≈ ${STRUCT_Y - STRUCT_RADIUS}); struct-0 collision_resolved = ${structContacts.length}; structure peak drift = ${structPeakDrift.toFixed(1)} ===\n`);

  // 1) Server registered the contact (structure is a solid, event-emitting body).
  expect(structContacts.length, 'server must log a collision_resolved involving struct-0 (structure blocks)').toBeGreaterThan(0);
  // 2) The player did not fly through — rendered Y stayed short of the structure body.
  expect(peakY, `rendered player must not penetrate the structure (peakY ${peakY.toFixed(1)} should stay < ${MAX_PLAYER_Y})`).toBeLessThan(MAX_PLAYER_Y);
  // 3) P3.10 (P0) — the structure itself did NOT move when rammed (locked body).
  expect(structBase, 'structure pose must be observable in the swarm mirror (kind-2 entry)').not.toBeNull();
  expect(structPeakDrift, `structure must not move when rammed (peak drift ${structPeakDrift.toFixed(1)} should stay < ${MAX_STRUCT_DRIFT})`).toBeLessThan(MAX_STRUCT_DRIFT);

  await ctx.close();
});
