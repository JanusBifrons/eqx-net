/**
 * AI steering slice 2c (plan composed-harbor §2): combat movement resolves
 * through context steering with same-side separation, so a pack attacking one
 * target spreads out instead of stacking nose to tail.
 *
 * Six drone fighters start in a tight clump and attack one stationary pilot
 * (startHostile, huge hull so the fight never ends). We sample the pack's
 * minimum pairwise distance after it settles, with the neighbour grid on
 * (separation) and off (the pre-2c behaviour: `view.neighbours` absent), and
 * require: separation on keeps min spacing ≥ 0.8 × combatSeparation for
 * ≥ 80 % of samples, beats the control, and the pack still hits the pilot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';

const SEP = shipTuning(getShipKind('fighter')).combatSeparation;
const PACK = 6;
const SETTLE_MS = 6000;
const SAMPLE_MS = 6000;
const SAMPLE_EVERY_MS = 100;

interface SceneResult { okFrac: number; meanMin: number; hits: number; samples: number }

async function runScene(separation: boolean): Promise<{ harness: SectorTestHarness; result: SceneResult }> {
  // A tight clump (60 u apart) 1100 u south of the pilot, noses north.
  const dronePoses = [];
  for (let i = 0; i < PACK; i++) {
    dronePoses.push({ kind: 'fighter', x: (i % 3) * 60 - 60, y: -1100 + Math.floor(i / 3) * 60, angle: 0, hullExposed: false });
  }
  const harness = await bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    testMode: true,
    asteroidConfig: [],
    dronePoses,
    lockTimeCapS: 0,
    defaultSpawnX: 0,
    defaultSpawnY: 0,
  });
  const pilot = randomUUID();
  await harness.connectActive(pilot, { startHostile: true, initialHull: 1_000_000, initialShield: 1_000_000 });
  const room = harness.getServerRoom()!;
  const internals = room._internals;
  internals.setAiNeighbours(separation);
  const hits: string[] = [];
  const r = room as unknown as { applyDamage: (t: string, s: string, ...rest: unknown[]) => void };
  const orig = r.applyDamage.bind(r);
  r.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
    if (t === pilot) hits.push(s);
    orig(t, s, ...rest);
  };
  const ids = [...internals.swarmRegistry.all()].filter((rec) => rec.kind === 1).map((rec) => rec.id);
  expect(ids.length).toBe(PACK);

  await harness.advance(SETTLE_MS);
  let ok = 0;
  let samples = 0;
  let sumMin = 0;
  const end = Date.now() + SAMPLE_MS;
  while (Date.now() < end) {
    let min = Infinity;
    for (let a = 0; a < ids.length; a++) {
      const pa = internals.swarmPose(ids[a]!);
      if (!pa) continue;
      for (let b = a + 1; b < ids.length; b++) {
        const pb = internals.swarmPose(ids[b]!);
        if (!pb) continue;
        min = Math.min(min, Math.hypot(pa.x - pb.x, pa.y - pb.y));
      }
    }
    if (Number.isFinite(min)) {
      samples++;
      sumMin += min;
      if (min >= SEP * 0.8) ok++;
    }
    await harness.advance(SAMPLE_EVERY_MS);
  }
  return { harness, result: { okFrac: ok / Math.max(1, samples), meanMin: sumMin / Math.max(1, samples), hits: hits.length, samples } };
}

describe('SectorRoom integration — combat separation (AI steering 2c)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('a six-ship pack keeps its spacing while attacking, and still hits; without separation it clumps', { timeout: 90_000 }, async () => {
    const on = await runScene(true);
    harness = on.harness;
    await harness.cleanup();
    harness = undefined;
    const off = await runScene(false);
    harness = off.harness;

    // Printed for the PR (A/B evidence).
    console.log(`[combatSeparation] sep=${SEP.toFixed(0)} on=${JSON.stringify(on.result)} off=${JSON.stringify(off.result)}`);

    expect(on.result.samples).toBeGreaterThan(20);
    expect(on.result.okFrac, 'separation on: min spacing ≥ 0.8 × combatSeparation most of the time').toBeGreaterThanOrEqual(0.8);
    expect(on.result.hits, 'the pack still fires on the target').toBeGreaterThan(0);
    expect(on.result.meanMin, 'separation is the cause: spacing improves on the control').toBeGreaterThan(off.result.meanMin);
    expect(on.result.okFrac).toBeGreaterThan(off.result.okFrac);
  });
});
