/**
 * Spread targets (owner decision 2026-11-14): "each NPC prefers an enemy nobody
 * else is already shooting, so a 3v3 breaks into three duels that last ~7 s
 * each. Gang-ups still happen when one side is outnumbered."
 *
 * Before: in the `dogfight-3v3` perf scene 2–3 ships focused one target and a
 * kill took ~1.75 s from first hit; one-on-one TTK is ~7 s (arcade tuning).
 *
 * This boots that scene (a pilot parked 20 km away starts it, out of the
 * fight) and samples every brain's held target:
 *  - gang share: of the samples where a side is NOT outnumbering the other
 *    (attackers ≤ living enemies), the share of engaged targets held by more
 *    than one attacker. Spread targeting keeps it low;
 *  - TTK: median time from a ship's first shield/hull loss to its death.
 * Both are logged; the asserts are loose bands around the measured values.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { PERF_SCENES } from '../../../src/shared-types/perf/perfScenes.js';

const SAMPLE_MS = 100;
const RUN_MS = 45_000;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number } | null;
    swarmHealth: Map<string, number>;
  };
  shieldHullRouter: { swarmShield: Map<string, number> };
  aiController: { getBehaviour(id: string): unknown };
}

interface Result { gangShare: number; gangSamples: number; ttks: number[] }

async function measure(harness: SectorTestHarness): Promise<Result> {
  const room = harness.getServerRoom() as unknown as Room;
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    if ([...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1).length >= 6) break;
    await harness.advance(50);
  }
  const recs = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1);
  expect(recs.length).toBe(6);
  const sideOf = new Map(recs.map((r) => [r.id, r.shipKind === 'fighter' ? 0 : 1]));
  const brains = new Map(recs.map((r) => [r.id, room.aiController.getBehaviour(r.id) as HostileDroneBehaviour]));
  const firstHit = new Map<string, number>();
  const lastHs = new Map<string, number>();
  const dead = new Set<string>();
  const ttks: number[] = [];
  let engaged = 0;
  let ganged = 0;
  const holders = new Map<string, number>();
  for (let t = 0; t < RUN_MS; t += SAMPLE_MS) {
    await harness.advance(SAMPLE_MS);
    const alive = [0, 0];
    for (const r of recs) {
      if (dead.has(r.id)) continue;
      const h = room._internals.swarmHealth.get(r.id);
      if (h === undefined || h <= 0 || !room._internals.swarmPose(r.id)) {
        dead.add(r.id);
        const fh = firstHit.get(r.id);
        if (fh !== undefined) ttks.push((t - fh) / 1000);
        continue;
      }
      alive[sideOf.get(r.id)!]!++;
      const hs = h + (room.shieldHullRouter.swarmShield.get(r.id) ?? 0);
      const prev = lastHs.get(r.id);
      if (prev !== undefined && hs < prev && !firstHit.has(r.id)) firstHit.set(r.id, t);
      lastHs.set(r.id, hs);
    }
    if (alive[0] === 0 || alive[1] === 0) break;
    for (const side of [0, 1]) {
      // Only count while this side does not outnumber the other.
      if (alive[side]! > alive[1 - side]!) continue;
      holders.clear();
      for (const r of recs) {
        if (dead.has(r.id) || sideOf.get(r.id) !== side) continue;
        const tid = brains.get(r.id)!.getTargetId();
        if (tid === null || dead.has(tid) || sideOf.get(tid) === undefined) continue;
        holders.set(tid, (holders.get(tid) ?? 0) + 1);
      }
      for (const n of holders.values()) {
        engaged++;
        if (n > 1) ganged++;
      }
    }
  }
  return { gangShare: engaged > 0 ? ganged / engaged : 0, gangSamples: engaged, ttks };
}

const median = (a: number[]): number => {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

describe('spread targets: dogfight-3v3 breaks into duels', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 15_000);

  it('few gang-ups while even, slower kills', { timeout: 180_000 }, async () => {
    const scene = PERF_SCENES.find((s) => s.id === 'dogfight-3v3')!;
    const all: number[] = [];
    let ganged = 0;
    let samples = 0;
    for (let run = 0; run < 2; run++) {
      harness = await bootSectorTestServer({
        ...scene.room, sectorKey: null, defaultSpawnX: 0, defaultSpawnY: -20_000,
      } as never);
      // The scene clock starts with the first READY pilot; parked 20 km away, out of the fight.
      await harness.connectActive(randomUUID());
      const r = await measure(harness);
      console.log(`[spreadTargets] run ${run}: gangShare=${(r.gangShare * 100).toFixed(1)}% over ${r.gangSamples} engaged-target samples; ttk=${r.ttks.map((x) => x.toFixed(2)).join(', ')} s`);
      all.push(...r.ttks);
      ganged += r.gangShare * r.gangSamples;
      samples += r.gangSamples;
      await harness.cleanup();
      harness = undefined;
    }
    const share = samples > 0 ? ganged / samples : 0;
    const med = median(all);
    console.log(`[spreadTargets] total gangShare=${(share * 100).toFixed(1)}% median TTK=${med.toFixed(2)} s (n=${all.length})`);
    expect(samples).toBeGreaterThan(100);
    expect(share).toBeLessThan(0.15);
    expect(all.length).toBeGreaterThan(0);
    expect(med).toBeGreaterThan(4.5);
  });
});
