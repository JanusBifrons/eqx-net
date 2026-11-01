/**
 * P2b (plan soft-leaping-truffle v3) — production in a real room. A powered
 * Smelter takes minerals from the base's storage and puts alloy back; its
 * status reaches clients through room state (#16); only the owner can change a
 * processor's recipe.
 *
 * Layout: Capital (0,0) → Connector (0,-350) → Smelter (0,-650) and Refinery
 * (450,-350); a Cargo Bay (-450,-350) is the base's storage. The Capital's 50
 * power runs the Smelter (40); the Refinery is left unpowered.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { PROD_STATE } from '../../../src/shared-types/production.js';
import { RECIPES } from '../../../src/shared-types/recipes.js';

const OWNER = '6a7e0000-0000-4000-8000-0000000000a1';

describe('SectorRoom integration — production (P2b)', () => {
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
        { kind: 'smelter', x: 0, y: -650 },
        { kind: 'cargo_bay', x: -450, y: -350 },
      ],
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: -1500,
    });
    const observer = await harness.connectAs(randomUUID());
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const smelter = all.find((r) => r.kind === 'smelter')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    expect(smelter && bay && capital, 'layout seeded').toBeTruthy();
    return { internals, smelter, bay, capital, observer };
  }

  it('a powered smelter turns stored minerals into alloy, and clients see its status', async () => {
    const { internals, smelter, bay, capital, observer } = await boot();
    capital.minerals = 0;
    capital.hold = { goods: {}, blueprints: [] };
    // The room's own 1 Hz pulse may already have loaded a cycle from the
    // Capital's starting minerals: start from an idle smelter.
    smelter.prodLoaded = false;
    smelter.prodProgress = 0;
    bay.hold = { goods: { minerals: 30 }, blueprints: [] };
    for (let i = 0; i < RECIPES.smelt_alloy.cyclePulses; i++) internals.pulseStructureGrid();
    expect(smelter.prodState).toBe(PROD_STATE.running);
    const alloy = (bay.hold?.goods.alloy ?? 0) + (capital.hold?.goods.alloy ?? 0);
    expect(alloy).toBe(1);
    expect(bay.hold!.goods.minerals).toBe(20);

    await harness.advance(200);
    const row = observer.state.structures.get(String(internals.swarmRegistry.get(smelter.id)!.entityId)) as
      | { prodState?: number }
      | undefined;
    expect(row?.prodState).toBe(PROD_STATE.running);
  });

  it('a starved smelter says what it is waiting for', async () => {
    const { internals, smelter, bay, capital, observer } = await boot();
    capital.minerals = 0;
    capital.hold = { goods: {}, blueprints: [] };
    // The room's own 1 Hz pulse may already have loaded a cycle from the
    // Capital's starting minerals: start from an idle smelter.
    smelter.prodLoaded = false;
    smelter.prodProgress = 0;
    bay.hold = { goods: {}, blueprints: [] };
    internals.pulseStructureGrid();
    expect(smelter.prodState).toBe(PROD_STATE.starved);
    await harness.advance(200);
    const row = observer.state.structures.get(String(internals.swarmRegistry.get(smelter.id)!.entityId)) as
      | { prodState?: number; prodMissing?: number }
      | undefined;
    expect(row?.prodState).toBe(PROD_STATE.starved);
    expect(row?.prodMissing).toBe(1); // minerals is good index 0 → wire 1
  });

  it('set_recipe is owner-only', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -350 },
        { kind: 'refinery', x: 0, y: -680 },
      ],
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: -1500,
    });
    const stranger = await harness.connectAs(randomUUID());
    const owner = await harness.connectAs(OWNER);
    const internals = harness.getServerRoom()!._internals;
    const refinery = [...internals.structureRegistry.all()].find((r) => r.kind === 'refinery')!;
    const entityId = internals.swarmRegistry.get(refinery.id)!.entityId;

    stranger.send('set_recipe', { type: 'set_recipe', entityId, recipe: 'refine_gas' });
    await harness.advance(200);
    expect(refinery.recipe).toBeUndefined();

    owner.send('set_recipe', { type: 'set_recipe', entityId, recipe: 'smelt_alloy' }); // not a refinery recipe
    await harness.advance(200);
    expect(refinery.recipe).toBeUndefined();

    owner.send('set_recipe', { type: 'set_recipe', entityId, recipe: 'refine_gas' });
    await harness.advance(200);
    expect(refinery.recipe).toBe('refine_gas');
  });
});

describe('SectorRoom integration — processor blueprint slots (P2b + Living World W2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('the owner loads a blueprint from storage, it runs the recipe, and unloads it back', async () => {
    const { getHoldStore } = await import('../../../src/server/db/PersistenceWorker.js');
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -350 },
        { kind: 'solar', x: 500, y: -500 },
        { kind: 'fabricator', x: 0, y: -720 },
        { kind: 'cargo_bay', x: -450, y: -350 },
      ],
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: -1500,
    });
    const stranger = await harness.connectAs(randomUUID());
    const owner = await harness.connectAs(OWNER);
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const fab = all.find((r) => r.kind === 'fabricator')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    const entityId = internals.swarmRegistry.get(fab.id)!.entityId;
    const bp = { uid: 'bp-test-1', product: 'recipe:fab_components', kind: 'bpc' as const, runs: 3, material: 0, output: 0, research: 0 };
    bay.hold = { goods: { alloy: 20, polymer: 10 }, blueprints: [bp] };

    internals.pulseStructureGrid();
    expect(fab.prodState).toBe(PROD_STATE.needsBlueprint);

    stranger.send('load_blueprint', { type: 'load_blueprint', entityId });
    await harness.advance(200);
    expect(fab.blueprint).toBeUndefined();

    owner.send('load_blueprint', { type: 'load_blueprint', entityId });
    await harness.advance(200);
    expect(fab.blueprint?.uid).toBe('bp-test-1');
    expect(bay.hold!.blueprints).toHaveLength(0);
    // The slot is its own persisted hold, written in the same group.
    expect(getHoldStore().get(`bpslot:${fab.uid}`)?.hold.blueprints[0]?.uid).toBe('bp-test-1');

    for (let i = 0; i < RECIPES.fab_components.cyclePulses; i++) internals.pulseStructureGrid();
    // Output lands in the network (Capital or Cargo Bay). The room's own 1 Hz
    // pulse may also have run, so count rather than pin.
    const made = (bay.hold?.goods.components ?? 0) + (capital.hold?.goods.components ?? 0);
    expect(made).toBeGreaterThanOrEqual(1);
    expect(fab.blueprint?.runs).toBeLessThan(3);

    await harness.advance(200);
    const row = owner.state.structures.get(String(entityId)) as { bpRuns?: number } | undefined;
    expect(row?.bpRuns).toBe(fab.blueprint?.runs);

    owner.send('unload_blueprint', { type: 'unload_blueprint', entityId });
    await harness.advance(200);
    expect(fab.blueprint).toBeUndefined();
    const back = [...(capital.hold?.blueprints ?? []), ...(bay.hold?.blueprints ?? [])].map((b) => b.uid);
    expect(back).toEqual(['bp-test-1']);
    expect(getHoldStore().get(`bpslot:${fab.uid}`)).toBeUndefined();
  });
});
