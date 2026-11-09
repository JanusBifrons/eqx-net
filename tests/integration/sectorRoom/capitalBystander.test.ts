/**
 * Smoke report (2026-11-07, capital-guns-bystander clip): "the so-called
 * bystander ship is getting shot". A battleship hostile ONLY to its target
 * must never pick a non-hostile pilot parked beside it as a turret target,
 * and that pilot must not be hit.
 *
 * Layout: battleship at (5000, 0), 50° (as capitalEngagement.test); the
 * target at the origin (startHostile); the bystander 900 u off the
 * battleship on the side AWAY from the target, inside AA and 5" reach.
 * The target joins with `instantLock` (its 16" lock completes at once; see
 * capitalEngagement.test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';

describe('SectorRoom integration — capital bystander', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [],
      dronePoses: [{ kind: 'battleship', x: 5000, y: 0, angle: (50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('turrets never target or hit a non-hostile pilot beside the battleship', { timeout: 60_000 }, async () => {
    const target = randomUUID(), bystander = randomUUID();
    const tr = await harness.connectActive(target, { initialHull: 1_000_000, initialShield: 0, startHostile: true, instantLock: true });
    const br = await harness.connectActive(bystander, { initialHull: 1_000_000, initialShield: 0, spawnX: 5900, spawnY: 0 });
    const targetHits: DamageEvent[] = [], bystanderHits: DamageEvent[] = [];
    tr.onMessage('damage', (e: DamageEvent) => { if (e.targetId === target) targetHits.push(e); });
    br.onMessage('damage', (e: DamageEvent) => { if (e.targetId === bystander) bystanderHits.push(e); });
    const room = harness.getServerRoom() as unknown as { mountTicker: { droneMountTargetIds: Map<string, (string | null)[]> } };
    const picked = new Set<string>();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && targetHits.length === 0) {
      for (const per of room.mountTicker.droneMountTargetIds.values()) for (const id of per) if (id) picked.add(id);
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`[bystander] picked=${[...picked].map((p) => (p === target ? 'target' : p === bystander ? 'BYSTANDER' : p)).join(',')} targetHits=${targetHits.length} bystanderHits=${bystanderHits.length}`);
    expect(picked.has(bystander), 'a turret picked the non-hostile bystander').toBe(false);
    expect(bystanderHits.length, 'the bystander was hit').toBe(0);
    expect(targetHits.length, 'precondition: the battleship engaged its target').toBeGreaterThan(0);
  });
});
