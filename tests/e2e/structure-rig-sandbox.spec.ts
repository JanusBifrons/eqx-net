/**
 * Articulation sandbox (structure-restyle 2f) — the crane clip a scene starts
 * on the freight dock reaches a LATE joiner from the room-state row alone
 * (invariant #16): clip id, start tick and the host-frame target.
 *
 * `rig-sandbox-e2e` room (scenarioLayouts.RIG_SANDBOX_E2E_SCENE): the scene
 * starts when the first pilot is ready, spawns a hauler on the pad and starts
 * `arm-reach` on the dock 200 ms later, targeted at the hauler (pad centre,
 * host (0, 460)). A second browser joins after that and must see the clip.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

// Infra budget: two cold joins.
test.setTimeout(90_000);

async function join(page: Page, testId: string): Promise<void> {
  await page.goto(`${BASE_URL}?room=rig-sandbox-e2e&testId=${testId}`);
  await waitForInPlay(page);
}

interface SeenClip { clipId: string; startTick: number; targetX?: number; targetY?: number }

/** Every structure's decoded rig clip on this client (`ColyseusClient` mirror). */
async function rigClips(page: Page): Promise<SeenClip[]> {
  return page.evaluate(() => {
    const c = (window as unknown as { __eqxClient?: { mirror?: { structures?: Map<string, { rigClip?: SeenClip }> } } }).__eqxClient;
    const out: SeenClip[] = [];
    c?.mirror?.structures?.forEach((s) => { if (s.rigClip) out.push({ ...s.rigClip }); });
    return out;
  });
}

test('a late joiner sees the crane clip from the structure row', async ({ browser }) => {
  const testId = randomUUID();
  const first = await (await browser.newContext()).newPage();
  await join(first, testId);
  // The scene plays arm-reach 200 ms after the first pilot is ready.
  await expect.poll(async () => (await rigClips(first)).map((c) => c.clipId), { timeout: 10_000 }).toContain('arm-reach');

  const late = await (await browser.newContext()).newPage();
  await join(late, testId);
  await expect.poll(async () => (await rigClips(late)).map((c) => c.clipId), { timeout: 10_000 }).toContain('arm-reach');
  const [a] = (await rigClips(first)).filter((c) => c.clipId === 'arm-reach');
  const [b] = (await rigClips(late)).filter((c) => c.clipId === 'arm-reach');
  console.log(`crane clip: first ${JSON.stringify(a)}, late ${JSON.stringify(b)}`);
  expect(b).toEqual(a);
  // Targeted at the hauler parked on the pad centre (host frame (0, 460)).
  expect(Math.abs(b!.targetX! - 0)).toBeLessThan(40);
  expect(Math.abs(b!.targetY! - 460)).toBeLessThan(40);
});
