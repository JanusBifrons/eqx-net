/**
 * Structure break-up T6 (docs/architecture/capital-destruction.md
 * "Structures"): a destroyed structure breaks into wreck pieces through the
 * ship death path (swarm death policy → `spawnScrapFromDrone`'s structure
 * branch → `RoomWreckSpawns.spawnStructureWreck` → `CapitalWreckSubsystem.onDeath`),
 * behind the `structureWrecks` room option (off by default).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

const WRECK_KIND = 4;

describe('SectorRoom integration — structure wrecks (structure break-up T6)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function boot(structureWrecks: boolean | undefined, owner: string): Promise<SectorRoom['_internals']> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }, { kind: 'solar', x: 900, y: 0 }],
      prebuiltStructuresOwner: owner,
      ...(structureWrecks !== undefined ? { structureWrecks } : {}),
    });
    await harness.connectActive(owner, { shipKind: 'fighter', spawnX: -20_000, spawnY: -20_000 });
    return (harness.getServerRoom() as unknown as SectorRoom)._internals;
  }

  function solarId(internal: SectorRoom['_internals']): string {
    const s = [...internal.structureRegistry.all()].find((r) => r.kind === 'solar');
    expect(s, 'the seeded solar').toBeTruthy();
    return s!.id;
  }

  it('switch on: a killed solar leaves kind-4 pieces under a structure descriptor with its owner, and the structure is gone', async () => {
    const owner = randomUUID();
    const internal = await boot(true, owner);
    const id = solarId(internal);
    await harness.advance(100);
    internal.applyDamage(id, 'shooter-x', 1e7, 900, 0);

    expect(internal.swarmRegistry.get(id) ?? null).toBeNull();
    expect(internal.structureRegistry.get(id)).toBeUndefined();
    const desc = internal.wreckDescriptors().find((d) => d.parentKind === 'structure');
    expect(desc, 'a structure wreck descriptor').toBeTruthy();
    expect(desc!.structure).toEqual({ k: 'solar' });
    expect(desc!.owner).toBe(owner);
    const pieces = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND && r.wreckId === desc!.wreckId);
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    for (const p of pieces) {
      const st = internal.wreckState(p.id)!;
      expect(Math.hypot(st.x - 900, st.y)).toBeLessThan(600);
    }
  }, 25_000);

  it('switch off (the default): the structure just goes, no wreck', async () => {
    const internal = await boot(undefined, randomUUID());
    const id = solarId(internal);
    await harness.advance(100);
    internal.applyDamage(id, 'shooter-x', 1e7, 900, 0);

    expect(internal.structureRegistry.get(id)).toBeUndefined();
    expect(internal.wreckDescriptors().length).toBe(0);
    expect([...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).length).toBe(0);
  }, 25_000);
});
