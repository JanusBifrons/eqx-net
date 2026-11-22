/**
 * Smoke-test report (2026-11-21, fresh world): a player cycled a powered
 * Shipyard's recipe from Interceptor to Mining Skiff ("Change what this
 * makes" × N, each a `set_recipe`), then tapped Load. The starter skiff copy
 * went into the slot ("2 runs left (1 building)"); minutes later the slot read
 * "None loaded", the yard idled and the player saw no Mining Skiff.
 *
 * The real messages, the real starter copies in the ship hold (the place a
 * fresh player keeps them), the Capital's mineral bank as the only input. A
 * copy's runs may only leave the slot as built hulls: every run spent is one
 * Mining Skiff in the owner's fleet (or a crate in storage), never nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore, getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { RECIPES, recipesFor, type RecipeId } from '../../../src/shared-types/recipes.js';
import { starterJunkCopies } from '../../../src/server/economy/starterGrant.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — Shipyard builds from the starter skiff copy', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('cycling the recipe to Mining Skiff and loading the starter copy builds a skiff per run; the copy never just vanishes', { timeout: 90_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -380 },
        { kind: 'connector', x: 450, y: -350 },
        { kind: 'reactor', x: 650, y: 50 },
        { kind: 'shipyard', x: 0, y: -790 },
      ],
      prebuiltStructuresOwner: owner,
      defaultSpawnX: 0,
      defaultSpawnY: 1500,
    });
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: 1500, shipKind: 'fighter' });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const internals = room._internals;
    const all = [...internals.structureRegistry.all()];
    const yard = all.find((r) => r.kind === 'shipyard')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    const reactor = all.find((r) => r.kind === 'reactor')!;
    const yardEid = internals.swarmRegistry.get(yard.id)!.entityId;
    capital.minerals = 5000;
    capital.hold = { goods: { fuel: 200 }, blueprints: [] };
    reactor.hold = undefined;

    // The starter copies sit in the flown ship's hold (starterGrant).
    let shipId = '';
    for (const [, s] of (room.state as SectorState).ships) if (s.playerId === owner && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    const copies = starterJunkCopies(() => 0.5);
    const skiffCopy = copies.find((b) => b.product === 'hull:mining-skiff')!;
    const runs0 = skiffCopy.runs ?? 0;
    getHoldStore().put({
      holderUid: shipId, holderType: 'ship', ownerId: owner, sectorKey: null, x: null, y: null,
      hold: { goods: {}, blueprints: copies }, expiresAt: null,
    }, false);

    // "Change what this makes" until it reads Build Mining Skiff.
    const list = recipesFor('shipyard');
    const from = list.indexOf((yard.recipe ?? 'build_interceptor') as RecipeId);
    for (let k = 1; k <= list.length; k++) {
      const recipe = list[(from + k) % list.length]!;
      cr.send('set_recipe', { type: 'set_recipe', entityId: yardEid, recipe });
      if (recipe === 'build_mining_skiff') break;
    }
    await harness.advance(300);
    expect(yard.recipe).toBe('build_mining_skiff');
    const results: Array<{ ok: boolean; message: string }> = [];
    cr.onMessage('blueprint_result', (m: { ok: boolean; message: string }) => results.push(m));
    const load = async (): Promise<void> => {
      cr.send('load_blueprint', { type: 'load_blueprint', entityId: yardEid });
      await harness.advance(300);
    };
    await load();
    expect(yard.blueprint?.product, 'the starter copy is in the slot').toBe('hull:mining-skiff');
    internals.pulseStructureGrid();
    expect(yard.prodLoaded, 'the first skiff is building ("2 runs left (1 building)")').toBe(true);

    // The player taps Load / Swap again while it builds (there is no other
    // skiff copy anywhere), twice. Each tap hands the building cycle back.
    await load();
    internals.pulseStructureGrid();
    await load();
    expect(results.at(-1)?.ok, 'a Load that finds no blueprint says so').toBe(false);
    expect(results.at(-1)?.message ?? '', 'and names what it looked for').toMatch(/Mining Skiff/);

    const skiffs = (): number => getPlayerShipStore().listByPlayer(owner).filter((r) => r.kind === 'mining-skiff').length;
    const crates = (): number => all.reduce((n, s) => n + (s.hold?.packed ?? []).filter((p) => p.product === 'hull:mining-skiff').length, 0);
    for (let i = 0; i < RECIPES.build_mining_skiff.cyclePulses * (runs0 + 2); i++) internals.pulseStructureGrid();

    // Value only moves: each run of the copy became a skiff (live, or a
    // crate), or is still in the slot / back in stock. Minerals pay per skiff.
    const left = yard.blueprint?.product === 'hull:mining-skiff' ? (yard.blueprint.runs ?? 0) : 0;
    const inStock = (getHoldStore().get(shipId)?.hold.blueprints ?? [])
      .filter((b) => b.product === 'hull:mining-skiff').reduce((n, b) => n + (b.runs ?? 0), 0);
    const built = skiffs() + crates();
    expect({ built, runs: built + left + inStock }, 'no run of the starter copy is lost').toEqual({ built: runs0, runs: runs0 });
    expect(capital.minerals, 'one bill per skiff').toBe(5000 - built * (RECIPES.build_mining_skiff.inputs.minerals ?? 0));
  });
});
