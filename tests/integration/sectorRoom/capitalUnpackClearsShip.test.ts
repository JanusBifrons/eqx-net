/**
 * Base loop smoke film (Sunday): a new player unpacks their packed Capital
 * next to their parked Fighter (Command view) and the Fighter sits inside the
 * Capital's hull edge for good. The Capital is pre-built, so it used to spawn
 * SOLID round the ship; the physics push-out stalls and the parked hull never
 * moves on its own.
 *
 * Fixed with the existing systems: a structure that would turn solid round a
 * ship starts as a hologram (`blueprintBody.ts`, settled by the grid pulse
 * once the space is clear), and every parked hull inside the footprint gets
 * its owner's ordinary Move order to the nearest clear spot (`landingPoint`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, withCapitalCrates, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { hullOverlapsFootprint } from '../../../src/server/structures/blueprintBody.js';
import { hullExtent } from '../../../src/server/rooms/join/joinConstants.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

async function until(pred: () => boolean, ms: number, step: () => void): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    step();
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe('SectorRoom integration — a Capital unpacked over a parked ship', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('the parked Fighter ends up clear of the Capital, and the Capital turns solid', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 900, shipKind: 'fighter', initialCargo: withCapitalCrates() });
    const internal = room(cr.roomId)._internals;
    cr.send('command', { type: 'command' });
    expect(await until(() => internal.lingeringSlots.size === 1, 4000, () => {})).toBe(true);
    const shipId = [...internal.lingeringSlots.keys()][0]!;
    expect(await until(() => internal.lingeringPoseCache.has(shipId), 4000, () => {})).toBe(true);

    // The Capital's 560 × 560 footprint at (0, 700) covers the Fighter at (0, 900).
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 700 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5000, () => {})).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    const hull = (): { x: number; y: number; r: number } => {
      const p = internal.lingeringPoseCache.get(shipId)!;
      return { x: p.x, y: p.y, r: hullExtent('fighter') };
    };
    expect(hullOverlapsFootprint(cap, hull())).toBe(true);

    const clear = await until(
      () => !hullOverlapsFootprint(cap, hull()) && cap.ghostBody !== true,
      15_000,
      () => internal.pulseStructureGrid(),
    );
    expect(clear, `parked Fighter at ${JSON.stringify(hull())}, Capital ghostBody=${String(cap.ghostBody)}`).toBe(true);
    expect(cap.isConstructed).toBe(true);
    // It stays out (it guards where it stopped).
    await harness.advance(1000);
    expect(hullOverlapsFootprint(cap, hull())).toBe(false);
  });
});
