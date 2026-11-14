/**
 * Nobody fights a loot pod (owner decision 2026-11-13; showcase review
 * 2026-11-14). In the filmed 3v3 a drone fighter broke up and dropped its loot
 * pod beside the wreck; a robot square kept firing at the drones around it and
 * its bolts stopped on the pod ("1" damage numbers on a grey diamond).
 *
 * Cause: friendly fire (owner decision 2026-11-10) makes an AI pilot's shot
 * hit the FIRST thing in its path, scrap included, and a loot pod is a
 * scrap-kind entity. A pod was never in the AI target pick (that reads ships
 * and structures only), but every shot through the wreck landed on it.
 *
 * Fix: AI pilot bolts and beams (and structure turret beams) pass through
 * loot pods. A player's own shot is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

type Hit = { target: string; shooter: string };

function recordHits(room: unknown): Hit[] {
  const hits: Hit[] = [];
  const r = room as { applyDamage: (t: string, s: string, ...rest: unknown[]) => void };
  const orig = r.applyDamage.bind(r);
  r.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
    hits.push({ target: t, shooter: s });
    orig(t, s, ...rest);
  };
  return hits;
}

describe('SectorRoom integration — AI pilot shots pass through loot pods', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  /** Shooter at the origin, target `gap` u ahead (+y), a loot pod half way:
   *  one real AI fire (`handleAiFire`), every hit by the shooter recorded. */
  async function fireThroughPod(shooterKind: string, targetKind: string, gap: number): Promise<{ mine: Hit[]; podAlive: boolean }> {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      asteroidConfig: [],
      testMode: true,
      peacefulDrones: true,
      defaultSpawnX: -4000,
      defaultSpawnY: -4000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('lp-shooter', 0, 0, shooterKind)).toBe(true);
    expect(internals.spawnTestDrone('lp-target', 0, gap, targetKind)).toBe(true);
    await harness.advance(100);
    const podId = internals.loot.drop({ goods: { salvage: 5 }, blueprints: [] }, 0, gap / 2, 0, 0);
    expect(podId, 'the pod spawned').toBeTruthy();
    expect(internals.swarmRegistry.get(podId!)?.shipKind).toBe('cargo-pod');
    const hits = recordHits(room);
    internals.aiFire('lp-shooter', 0, 1, 'lp-target');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !hits.some((h) => h.shooter === 'lp-shooter')) await harness.advance(50);
    return { mine: hits.filter((h) => h.shooter === 'lp-shooter'), podAlive: internals.swarmRegistry.get(podId!) !== undefined };
  }

  it('a robot square\'s bolt (the filmed case) passes the loot pod and lands on the drone fighter behind it', { timeout: 30_000 }, async () => {
    const { mine, podAlive } = await fireThroughPod('robot-square', 'fighter', 300);
    expect(mine.length, 'the bolt hit something').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === 'lp-target'), 'the bolt passed the pod: ' + JSON.stringify(mine)).toBe(true);
    expect(podAlive, 'the pod is untouched').toBe(true);
  });

  it('an AI pilot\'s beam passes the loot pod and lands on the ship behind it', { timeout: 30_000 }, async () => {
    const { mine, podAlive } = await fireThroughPod('interceptor', 'heavy', 220);
    expect(mine.length, 'the beam hit something').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === 'lp-target'), 'the beam passed the pod: ' + JSON.stringify(mine)).toBe(true);
    expect(podAlive, 'the pod is untouched').toBe(true);
  });
});
