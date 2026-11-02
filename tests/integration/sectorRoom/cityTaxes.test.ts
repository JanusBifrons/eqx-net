/**
 * D3 (plan soft-leaping-truffle v3) — cities in a real room. A player's
 * powered Habitat Module uses provisions and consumer goods from the base's
 * storage and pays its owner taxes into their WALLET (never a hold); without
 * consumer goods it starves, pays nothing, and clients see why (#16).
 *
 * Layout: Capital (0,0) → Connector (0,-350) → Habitat (0,-650); a Cargo Bay
 * (-450,-350) is the base's storage.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { PROD_STATE } from '../../../src/shared-types/production.js';
import { RECIPES, recipeCredits } from '../../../src/shared-types/recipes.js';
import { getWallet } from '../../../src/server/db/PersistenceWorker.js';

const OWNER = '6a7e0000-0000-4000-8000-0000000000d3';

describe('SectorRoom integration — city taxes (D3)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function boot() {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -350 },
        { kind: 'habitat_module', x: 0, y: -650 },
        { kind: 'cargo_bay', x: -450, y: -350 },
      ],
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: -1500,
    });
    const observer = await harness.connectAs(randomUUID());
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const hab = all.find((r) => r.kind === 'habitat_module')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    expect(hab && bay && capital, 'layout seeded').toBeTruthy();
    capital.hold = { goods: {}, blueprints: [] };
    hab.prodLoaded = false;
    hab.prodProgress = 0;
    return { internals, hab, bay, observer };
  }

  it("a fed habitat pays its owner's wallet each cycle and uses up the goods", async () => {
    const { internals, hab, bay } = await boot();
    bay.hold = { goods: { provisions: 8, consumer_goods: 2 }, blueprints: [] };
    const before = getWallet().balance(OWNER);
    for (let i = 0; i < RECIPES.habitat_upkeep.cyclePulses; i++) internals.pulseStructureGrid();
    expect(hab.prodState).toBe(PROD_STATE.running);
    expect(getWallet().balance(OWNER) - before).toBe(recipeCredits('habitat_upkeep'));
    expect(bay.hold!.goods).toEqual({ provisions: 4, consumer_goods: 1 });
  });

  it('a starving habitat pays nothing and says what it needs', async () => {
    const { internals, hab, bay, observer } = await boot();
    bay.hold = { goods: { provisions: 20 }, blueprints: [] };
    const before = getWallet().balance(OWNER);
    for (let i = 0; i < RECIPES.habitat_upkeep.cyclePulses * 2; i++) internals.pulseStructureGrid();
    expect(hab.prodState).toBe(PROD_STATE.starved);
    expect(getWallet().balance(OWNER)).toBe(before);
    await harness.advance(200);
    const row = observer.state.structures.get(String(internals.swarmRegistry.get(hab.id)!.entityId)) as
      | { prodState?: number }
      | undefined;
    expect(row?.prodState).toBe(PROD_STATE.starved);
  });
});
