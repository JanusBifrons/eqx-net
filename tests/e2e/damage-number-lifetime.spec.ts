import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Integration regression lock — the damage-number lifecycle in the
 * worker-renderer path.
 *
 * THE BUG (discovered 2026-05-14 via user smoke testing — this spec
 * exists so we never need to smoke-test it again):
 *
 * `PixiRenderer.update()` drains `mirror.pendingDamageNumbers` by
 * mutating it in place (`pendingDamageNumbers.length = 0`). In the
 * main-thread path that's fine — the renderer shares the array with
 * `ColyseusClient`. In the worker path, `PixiRenderer` runs on the
 * worker side against a STRUCTURED-CLONE of the mirror, so the drain
 * affects only the worker's local copy. The main-thread mirror's
 * `pendingDamageNumbers` array keeps the events, and every subsequent
 * frame re-posts them. The worker re-spawns the damage number on
 * every post. Visual symptom: numbers never disappear; they pile up.
 *
 * THE FIX: `WorkerRendererClient.update()` clears the per-frame drain
 * queues (`pendingDamageNumbers`, `pendingHealthBarHits`) on the
 * MAIN thread after posting — matching the main-thread renderer's
 * implicit-clear contract.
 *
 * Why a unit test on `DamageNumberManager` doesn't catch this: the
 * manager works correctly when ticked directly. The bug is at the
 * `App.tsx` → `WorkerRendererClient` → worker boundary, specifically
 * in how the main-thread drain queue interacts with structured-clone.
 *
 * This spec exercises THAT boundary: it simulates the real gameplay
 * flow (persistent mirror reference, push damage event, post mirror
 * each "frame") via the real `WorkerRendererClient` against the real
 * `renderer.worker.ts` hosting the real `PixiRenderer`.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

interface DamageProbeApi {
  pushDamage: (x: number, y: number, damage: number, targetId?: string) => void;
  postFrame: () => void;
  explode: (targetId: string) => void;
  getActiveCount: () => number;
  getPendingQueueLength: () => number;
}

interface ProbeWindow extends Window {
  __damageProbe?: DamageProbeApi;
}

async function waitForProbeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__damageProbe !== undefined, undefined,
    { timeout: 10_000 },
  );
}

async function getActiveCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as ProbeWindow).__damageProbe!.getActiveCount(),
  );
}

async function getPendingLength(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as ProbeWindow).__damageProbe!.getPendingQueueLength(),
  );
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
  await page.goto(`${BASE_URL}/__offscreen-spike__/damage-number-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  await waitForProbeReady(page);
  // Stash for the test to use.
  (page as unknown as { __probeErrors?: string[] }).__probeErrors = errors;
});

test('WorkerRendererClient.update drains pendingDamageNumbers locally', async ({ page }) => {
  test.setTimeout(15_000);

  // STEP 1: Push a damage event into the persistent mirror.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__damageProbe!.pushDamage(100, 50, 42);
  });

  // The pending queue should have 1 entry pre-post.
  expect(await getPendingLength(page)).toBe(1);

  // STEP 2: Post the mirror once.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__damageProbe!.postFrame();
  });

  // STEP 3: After post, the local drain queue MUST be empty —
  // `WorkerRendererClient.update()` is contractually required to
  // clear it. If the bug regresses (drain happens only worker-side
  // via structured-clone), this length stays at 1 and the test fails
  // immediately.
  expect(
    await getPendingLength(page),
    'pendingDamageNumbers must be drained on the main thread after WorkerRendererClient.update — ' +
      'otherwise the same damage event re-posts every frame and the worker re-spawns duplicates.',
  ).toBe(0);
});

test('damage numbers DO NOT pile up when the rAF loop posts the same mirror every frame', async ({ page }) => {
  test.setTimeout(20_000);

  // STEP 1: Push ONE damage event.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__damageProbe!.pushDamage(100, 50, 42);
  });

  // STEP 2: Post the mirror 40 times — simulating 40 rAF frames of
  // the App.tsx loop calling `renderer.update(gameClient.mirror)`.
  // If the worker-drain bug exists, the same damage event gets
  // re-posted on every frame and the worker spawns 40 damage numbers
  // (pool capped at 20 → activeCount=20).
  // If the fix is in place, only frame #1 carries the event;
  // frames 2..40 carry an empty queue. activeCount=1 throughout.
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => {
      (window as unknown as ProbeWindow).__damageProbe!.postFrame();
    });
    await page.waitForTimeout(20);
  }

  // Allow feedback round-trip.
  await page.waitForTimeout(300);

  const count = await getActiveCount(page);
  expect(
    count,
    `After 40 frames re-posting one damage event, expected exactly 1 damage number ` +
      `active (the original spawn, still within lifetime). Got ${count}. ` +
      `Values >1 indicate WorkerRendererClient is NOT draining pendingDamageNumbers locally, ` +
      `so the event re-posts every frame and the worker spawns duplicates.`,
  ).toBe(1);
});

test('a single damage number expires within its lifetime on quiet frames', async ({ page }) => {
  test.setTimeout(20_000);

  // STEP 1: Push one damage event + post.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__damageProbe!.pushDamage(100, 50, 42);
    (window as unknown as ProbeWindow).__damageProbe!.postFrame();
  });
  await expect.poll(() => getActiveCount(page), { timeout: 3_000 }).toBe(1);

  // STEP 2: Post quiet frames (no new damage) until well past the number's
  // lifetime. The accumulator model holds STAY_FRAMES (36) then fades over
  // FADE_FRAMES (24) = 60 frames total before destruction (2026-11-11; was
  // 60 + 30); 95
  // deterministic frames clears it with margin. activeCount decays to 0 as
  // the per-frame PixiRenderer.update() ticks the manager's lifetime.
  for (let i = 0; i < 95; i++) {
    await page.evaluate(() => {
      (window as unknown as ProbeWindow).__damageProbe!.postFrame();
    });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(500);

  const count = await getActiveCount(page);
  expect(
    count,
    `After 80 quiet frames past LIFETIME_FRAMES (60), the damage number should have expired. ` +
      `Got ${count}. If this fails, PixiRenderer is not ticking DamageNumberManager.update() ` +
      `every frame.`,
  ).toBe(0);
});

test('after the target explodes, late hits on it never keep its number alive', async ({ page }) => {
  test.setTimeout(20_000);
  // Hostile review of filmed fight clips (2026-11-13): "floating damage
  // numbers keep CLIMBING over a ship AFTER it has exploded." The death
  // reaches the worker only as the one-frame `explodingShips` trigger in the
  // structured-cloned mirror, so this is locked at that boundary.
  await page.evaluate(() => {
    const p = (window as unknown as ProbeWindow).__damageProbe!;
    p.pushDamage(100, 50, 42, 'victim');
    p.postFrame();
    p.explode('victim');
    p.postFrame();
  });
  // In-flight hits keep landing on the dead id for 40 frames, then 45 quiet
  // frames: 85 frames after the death, past the number's 60-frame lifetime.
  // Before the fix each late hit reset the stay window (and climbed the
  // total), so the number was still on screen until frame 40 + 60 = 100.
  for (let i = 0; i < 85; i++) {
    await page.evaluate((late) => {
      const p = (window as unknown as ProbeWindow).__damageProbe!;
      if (late) p.pushDamage(100, 50, 5, 'victim');
      p.postFrame();
    }, i < 40);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(500);
  expect(
    await getActiveCount(page),
    'A dead target\'s number must finish its float and expire; late hits on the dead id ' +
      'must not add to it or keep it alive.',
  ).toBe(0);
});
