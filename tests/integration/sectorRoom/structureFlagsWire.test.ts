/**
 * Regression lock (found 2026-11-01 while building break-ins): the structure flag
 * bits NO_AMMO (P2d), NO_FUEL (D1) and DRAW_FULL (active power)
 * were set INSIDE the shield-emitter branch of `rebuildStructuresSlice`, so
 * they only ever reached clients for pylons and gates. A Reactor's "NO FUEL",
 * a turret's "NO MUNITIONS" and every structure's live power draw were wrong
 * on the wire. The unit tests fed decoded state straight to the inspector and
 * the integration tests read the server records, so nothing crossed the seam.
 *
 * This test reads the flags from a CLIENT's room state, where the bug lived.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { STRUCTURE_FLAG_DRAW_FULL, STRUCTURE_FLAG_NO_FUEL } from '../../../src/shared-types/structureStateWire.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('SectorRoom integration — structure flag bits reach clients (all kinds)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('a fuel-less Reactor shows NO_FUEL and a drilling Miner shows DRAW_FULL in client room state', { timeout: 30_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 }, { kind: 'connector', x: 0, y: 350 },
        { kind: 'reactor', x: 800, y: 800 }, { kind: 'miner', x: -180, y: 420 },
      ],
      prebuiltStructuresOwner: owner,
    });
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: -2500 });
    const internal = harness.getServerRoom()!._internals;
    internal.spawnTestAsteroid('rock', -500, 900, 30);
    for (let i = 0; i < 3; i++) internal.pulseStructureGrid();
    const recs = [...internal.structureRegistry.all()];
    const reactor = recs.find((r) => r.kind === 'reactor')!;
    const miner = recs.find((r) => r.kind === 'miner')!;
    const eid = (id: string): string => String(internal.swarmRegistry.get(id)!.entityId);
    const flags = (id: string): number => (cr.state as unknown as SectorState).structures.get(eid(id))?.flags ?? 0;

    expect(reactor.fueled, 'no fuel in storage').not.toBe(true);
    expect(await until(() => (flags(reactor.id) & STRUCTURE_FLAG_NO_FUEL) !== 0, 3_000), 'NO_FUEL reaches the client').toBe(true);
    // The Miner drills on alternate pulses (brown-out), so pulse until it's drawing.
    for (let i = 0; i < 3 && miner.drawFull !== true; i++) internal.pulseStructureGrid();
    expect(miner.drawFull).toBe(true);
    expect(await until(() => (flags(miner.id) & STRUCTURE_FLAG_DRAW_FULL) !== 0, 3_000), 'DRAW_FULL reaches the client').toBe(true);
  });
});
