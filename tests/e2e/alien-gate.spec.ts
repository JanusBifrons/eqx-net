/**
 * v4 A — alien gates through the real UI. The `alien-gate-test` room seeds one
 * Ancients' gate at the origin; the pilot spawns inside its zone.
 *
 *  - Selecting the gate shows its owner (The Ancients), and no pairing offer:
 *    alien gates only link to each other.
 *  - Firing inside the zone disables the pilot: the "Systems disabled" chip
 *    appears, driven by the own-ship snapshot's `disabledMs` (#16).
 *
 * Lock-to-fire (2026-11-09): a pilot can only fire at a COMPLETED lock, so the
 * room must offer something lockable inside the zone and in weapon reach of
 * the spawn (the gate itself is 1500 u away, far past any gun's reach). The
 * pilot joins with `instantLock=1&anyTarget=1`: the AUTO group locks that target in front
 * within ~0.1 s and fires, which is the hostile act the gate punishes.
 *
 * The engines-off input gate itself is locked by `tests/unit/disableParity`
 * (both sides use one shared function) and the integration tests.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';
import { waitForInPlay } from './helpers/gameScenario';
import { ALIEN_GATE_SEAL_APOTHEM } from '../../src/shared-types/alienGateSeal';
import { TP_PHASE } from '../../src/shared-types/teleport';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

type EqxWindow = { __eqxSelectAtWorld?: (x: number, y: number) => string | null };

test('an alien gate disables a pilot who fires in its zone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${BASE_URL}?room=alien-gate-test&testId=${randomUUID()}&worker=0&instantLock=1&anyTarget=1`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );

  // The gate: owned by the Ancients, no "ask to pair".
  await expect.poll(() => page.evaluate(() => (window as unknown as EqxWindow).__eqxSelectAtWorld?.(0, 0) ?? null), { timeout: 10_000 }).not.toBeNull();
  await page.getByTestId('left-strip-cog').click(); // the readout is in Details
  await expect(page.getByTestId('entity-stats-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('entity-stats-owner')).toContainText('Ancients');
  await expect(page.getByTestId('tp-foreign-panel')).toHaveCount(0);

  // Fire inside the zone → disabled. (AUTO fires at its instant lock; Space
  // adds the active group if it is MAN.)
  await page.keyboard.down('Space');
  try {
    await expect(page.getByTestId('ship-disabled')).toBeVisible({ timeout: 10_000 });
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
  }
  expect(Number(await page.getByTestId('ship-disabled').getAttribute('data-seconds'))).toBeGreaterThan(0);
});

/**
 * Teleporter redesign A3 — the gate has no posts; while its jump phase is
 * SEALED its outer ring (`alienGateSeal.ts`: 32 chords on r ≈ 818) is solid
 * walls, in the server worker and the client prediction alike, and the rest
 * of the time nothing at the gate blocks a ship (#9).
 *
 * The pilot spawns outside the ring on x = −230 (the line of one of the old
 * posts, which stood at (−230, −690)) and flies north at the gate's centre.
 * The phase is forced with the `test_gate_seal` cue (the test room's gate has
 * no twin, so its timetable never runs): unsealed, the ship crosses the ring
 * and the old post's spot; sealed, its centre never gets inside the seal.
 */
const LANE_X = -230;
const SPAWN_Y = -1150;
/** Well inside the seal, on the light pool (the ride area, inside the inner
 *  ring; owner 2026-11-26). On x = −230 that is also north of the old post
 *  line (y −690). */
const INSIDE_R = ALIEN_GATE_SEAL_APOTHEM - 100;

type GateWindow = {
  __eqxClient?: {
    getRoom?: () => { send: (type: string, msg: unknown) => void } | null;
    mirror?: {
      localPlayerId?: string;
      ships: Map<string, { x: number; y: number }>;
      structures?: Map<number, { teleport?: { phase: number } }>;
      swarm?: Map<number, { shipKind?: string }>;
    };
  };
};

async function joinOutsideRing(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}?room=alien-gate-test&testId=${randomUUID()}&worker=0&spawnX=${LANE_X}&spawnY=${SPAWN_Y}`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );
  await waitForInPlay(page); // thrust counts only once the curtain lifts
}

/** The local ship's pose from the render mirror (null until it arrives). */
function shipPos(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const m = (window as unknown as GateWindow).__eqxClient?.mirror;
    const s = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    return s ? { x: s.x, y: s.y } : null;
  });
}

/** The gate's jump phase as this client decoded it from its row (−1 until
 *  the gate arrives; a row with no teleport block is an idle gate). */
function gatePhase(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = (window as unknown as GateWindow).__eqxClient?.mirror;
    if (!m?.structures || !m.swarm) return -1;
    for (const [id, e] of m.swarm) {
      if (e.shipKind === 'alien_gate') return m.structures.has(id) ? (m.structures.get(id)?.teleport?.phase ?? 0) : -1;
    }
    return -1;
  });
}

async function setSealed(page: Page, sealed: boolean): Promise<void> {
  await page.evaluate((v) => {
    (window as unknown as GateWindow).__eqxClient?.getRoom?.()?.send('test_gate_seal', { type: 'test_gate_seal', sealed: v });
  }, sealed);
}

/** Join south of the ring; the ship starts clear outside it. */
async function startOutside(page: Page): Promise<void> {
  await joinOutsideRing(page);
  await expect.poll(() => shipPos(page), { timeout: 10_000 }).not.toBeNull();
  const p = (await shipPos(page))!;
  expect(Math.hypot(p.x, p.y), 'the ship starts outside the ring').toBeGreaterThan(ALIEN_GATE_SEAL_APOTHEM + 200);
}

/**
 * Hold thrust + boost north until the ship is well inside the ring or
 * `holdMs` pass; return the closest approach to the gate's centre.
 */
async function flyNorth(page: Page, holdMs: number): Promise<number> {
  await page.locator('[data-testid="game-surface"]').click();
  let minR = Infinity;
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  try {
    for (let t = 0; t < holdMs && minR >= INSIDE_R; t += 50) {
      await page.waitForTimeout(50);
      const p = await shipPos(page);
      if (p === null) continue;
      minR = Math.min(minR, Math.hypot(p.x, p.y));
    }
  } finally {
    await page.keyboard.up('w').catch(() => undefined);
    await page.keyboard.up('Shift').catch(() => undefined);
  }
  return minR;
}

test('an unsealed Ancients’ gate lets a ship fly through its ring', async ({ page }) => {
  test.setTimeout(120_000); // infrastructural: a cold server + Vite join
  await startOutside(page);
  await setSealed(page, false);
  await expect.poll(() => gatePhase(page), { timeout: 5_000 }).toBe(TP_PHASE.IDLE);
  const minR = await flyNorth(page, 8_000);
  console.log(`unsealed gate: closest r=${minR.toFixed(0)}`);
  expect(minR, 'the ship crossed the ring and the old post line').toBeLessThan(INSIDE_R);
});

test('a sealed Ancients’ gate stops a ship at its ring', async ({ page }) => {
  test.setTimeout(120_000); // infrastructural: a cold server + Vite join
  await startOutside(page);
  await setSealed(page, true);
  await expect.poll(() => gatePhase(page), { timeout: 5_000 }).toBe(TP_PHASE.SEALED);
  // The same thrust that carries an unsealed ship through (above), held on.
  const minR = await flyNorth(page, 6_000);
  console.log(`sealed gate: closest r=${minR.toFixed(0)} (seal apothem ${ALIEN_GATE_SEAL_APOTHEM.toFixed(0)})`);
  expect(minR, 'the ship reached the ring').toBeLessThan(ALIEN_GATE_SEAL_APOTHEM + 150);
  expect(minR, 'the sealed ring kept the ship outside').toBeGreaterThan(ALIEN_GATE_SEAL_APOTHEM);
});
