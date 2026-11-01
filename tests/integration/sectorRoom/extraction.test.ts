/**
 * P2c (plan soft-leaping-truffle v3) — extraction in a real room. A Miner on an
 * ICE asteroid puts ice into the base's storage; on a CRYSTAL-veined one it
 * gets minerals (its buffer) plus crystal (storage). A Gas Collector gathers
 * gas only in a nebula sector.
 *
 * Layout: Capital (0,0) → Connector (0,-350) → Solar (500,-500) and the
 * extractor (0,-700); a Cargo Bay (-450,-350) is the base's storage.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

const OWNER = '6a7e0000-0000-4000-8000-0000000000a1';

describe('SectorRoom integration — extraction (P2c)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function boot(extractor: 'miner' | 'gas_collector', features: string[] = []) {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      sectorFeatures: features,
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -350 },
        { kind: 'solar', x: 500, y: -500 },
        { kind: extractor, x: 0, y: -700 },
        { kind: 'cargo_bay', x: -450, y: -350 },
      ],
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: -2500,
    });
    await harness.connectAs(randomUUID());
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const capital = all.find((r) => r.kind === 'capital')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    const ext = all.find((r) => r.kind === extractor)!;
    expect(ext, 'extractor placed').toBeDefined();
    capital.hold = { goods: {}, blueprints: [] };
    bay.hold = { goods: {}, blueprints: [] };
    const stored = (g: 'ice' | 'crystal' | 'gas') => (capital.hold?.goods[g] ?? 0) + (bay.hold?.goods[g] ?? 0);
    // Minerals are hauled from the drill to the Capital bank each pulse.
    const minerals = () => capital.minerals + ext.minerals;
    return { internals, ext, stored, minerals };
  }

  it('a Miner on an ice asteroid fills storage with ice, not minerals', async () => {
    const { internals, stored, minerals } = await boot('miner');
    expect(internals.spawnTestAsteroid('ice-rock', 0, -1250, 80, 'ice')).toBe(true);
    const before = minerals();
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    expect(stored('ice')).toBeGreaterThan(0);
    expect(minerals()).toBe(before);
  });

  it('a Miner on a crystal-veined asteroid gets minerals and some crystal', async () => {
    const { internals, stored, minerals } = await boot('miner');
    expect(internals.spawnTestAsteroid('crystal-rock', 0, -1250, 80, 'crystal')).toBe(true);
    const before = minerals();
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    expect(stored('crystal')).toBeGreaterThan(0);
    expect(minerals()).toBeGreaterThan(before);
  });

  it('a Gas Collector gathers gas only in a nebula sector', async () => {
    const noNebula = await boot('gas_collector', []);
    for (let i = 0; i < 3; i++) noNebula.internals.pulseStructureGrid();
    expect(noNebula.stored('gas')).toBe(0);
    await harness.cleanup();

    const nebula = await boot('gas_collector', ['nebula']);
    for (let i = 0; i < 3; i++) nebula.internals.pulseStructureGrid();
    expect(nebula.stored('gas')).toBeGreaterThan(0);
  });
});
