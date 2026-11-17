/**
 * structure-restyle 3d — outlet docks. A freight dock with EXPORT orders is an
 * outlet: a ship parked still on its bay gets the same crane cycle as an
 * unload (settle → `arm-reach` → `arm-hold` → `arm-retract`), and at hold END
 * it is LOADED from base storage with the export goods — to the brim (by
 * weight), never taking a good below its order's level (an export offers only
 * what is ABOVE the level). A mixed dock unloads its import goods, then loads
 * its export goods, in the one cycle. Aborting moves nothing; a ship with
 * nothing to deliver and nothing it can take gets no cycle.
 *
 * Dock at (0, 0), rot 0: its bay centre is world (0, 460) (`DOCK_BAY_CY`).
 * Unload rules (3b/3c) are locked by `dockCraneDwell.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { StructureRecord } from '../../../src/server/structures/StructureRegistry.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { cargoCapacityForMaxHealth, type GoodId } from '../../../src/shared-types/goods.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { holdWeight } from '../../../src/core/cargo/hold.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

type Goods = Partial<Record<GoodId, number>>;
const CARGO: Goods = { salvage: 6, alloy: 3 };

describe('SectorRoom integration — outlet docks load parked ships (structure-restyle 3d)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  /** Boot with the dock owned by `pid`; `before` stages the dock's orders and
   *  stock, then `pid` flies in at (x, y) carrying `cargo`. */
  async function boot(
    pid: string, x: number, y: number,
    before: (room: SectorRoom, dock: StructureRecord) => void,
    cargo: Goods | ((cap: number) => Goods) = CARGO,
  ): Promise<{ room: SectorRoom; dock: StructureRecord; cr: Room<SectorState>; shipId: string; cap: number }> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'freight_dock', x: 0, y: 0 }],
      prebuiltStructuresOwner: pid,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const dock = [...room._internals.structureRegistry.all()].find((r) => r.kind === 'freight_dock')!;
    before(room, dock);
    // The default hull, no fitted modules: its capacity is the kind's.
    const cap = Math.floor(cargoCapacityForMaxHealth(getShipKind(null)));
    const goods = typeof cargo === 'function' ? cargo(cap) : cargo;
    const cr = await harness.connectActive(pid, { spawnX: x, spawnY: y, initialCargo: { goods, blueprints: [] } });
    expect(await until(() => shipIdOf(cr, pid) !== '', 3_000)).toBe(true);
    const shipId = shipIdOf(cr, pid);
    expect(cr.state.ships.get(shipId)!.kind, 'the default hull (capacity above)').toBe(getShipKind(null).id);
    expect(aboard(shipId)).toEqual(goods);
    return { room, dock, cr, shipId, cap };
  }

  function shipIdOf(cr: Room<SectorState>, pid: string): string {
    for (const [, s] of cr.state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  }

  const clipOf = (dock: StructureRecord): string | undefined => dock.rigClip?.clipId;
  const aboard = (shipId: string): Goods => ({ ...(getHoldStore().get(shipId)?.hold.goods ?? {}) });
  const weightAboard = (shipId: string): number => {
    const h = getHoldStore().get(shipId)?.hold;
    return h ? holdWeight(h) : 0;
  };
  const stock = (dock: StructureRecord, ...goods: Array<[GoodId, number]>): void => {
    dock.hold = { goods: Object.fromEntries(goods), blueprints: [] };
  };

  it('an outlet loads a parked ship to the brim at hold END, through the full crane cycle', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { dock, shipId, cap } = await boot(pid, 120, 480, (_r, d) => {
      d.freightOrders = [{ good: 'alloy', mode: 'export', level: 5 }];
      stock(d, ['alloy', 5_000]);
    });
    expect(await until(() => clipOf(dock) === 'arm-reach', 5_000), 'spare export stock draws the crane').toBe(true);
    expect(await until(() => clipOf(dock) === 'arm-hold', 3_000)).toBe(true);
    expect(aboard(shipId), 'nothing loads before the hold ends').toEqual(CARGO);
    expect(await until(() => clipOf(dock) === 'arm-retract', 15_000)).toBe(true);
    const took = Math.floor((cap - 12) / 2); // 12 = 6 salvage × 1 + 3 alloy × 2
    expect(took).toBeGreaterThan(0);
    expect(aboard(shipId), 'the outlet takes nothing in; the hold fills with alloy').toEqual({ salvage: 6, alloy: 3 + took });
    expect(cap - weightAboard(shipId), 'filled to the brim (less than one alloy of room left)').toBeLessThan(2);
    expect(dock.hold?.goods.alloy).toBe(5_000 - took);
  });

  it('an outlet never takes a good below its export level', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { dock, shipId } = await boot(pid, 0, 460, (_r, d) => {
      d.freightOrders = [{ good: 'alloy', mode: 'export', level: 5 }, { good: 'ice', mode: 'export', level: 4 }];
      stock(d, ['alloy', 8], ['ice', 4]);
    });
    expect(await until(() => clipOf(dock) === 'arm-retract', 15_000)).toBe(true);
    expect(aboard(shipId), 'only the 3 alloy above the level; ice sits at its level').toEqual({ salvage: 6, alloy: 6 });
    expect(dock.hold?.goods).toEqual({ alloy: 5, ice: 4 });
    // Served once: staying parked draws no second cycle (nothing left to take).
    const retractTick = dock.rigClip!.startTick;
    await harness!.advance(3_000);
    expect(dock.rigClip!.startTick).toBe(retractTick);
  });

  it('a mixed dock unloads its import goods, then loads its export goods, in one cycle', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { dock, shipId } = await boot(pid, 0, 460, (_r, d) => {
      d.freightOrders = [{ good: 'salvage', mode: 'import', level: 50 }, { good: 'crystal', mode: 'export', level: 2 }];
      stock(d, ['crystal', 12]);
    });
    expect(await until(() => clipOf(dock) === 'arm-hold', 6_000)).toBe(true);
    expect(aboard(shipId)).toEqual(CARGO);
    expect(await until(() => clipOf(dock) === 'arm-retract', 15_000)).toBe(true);
    expect(aboard(shipId), 'salvage off, crystal on; alloy (no order) stays aboard').toEqual({ alloy: 3, crystal: 10 });
    expect(dock.hold?.goods).toEqual({ salvage: 6, crystal: 2 });
  });

  it('flying off mid-hold aborts: nothing is loaded', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const { dock, cr, shipId } = await boot(pid, 0, 460, (_r, d) => {
      d.freightOrders = [{ good: 'alloy', mode: 'export', level: 1 }];
      stock(d, ['alloy', 40]);
    });
    expect(await until(() => clipOf(dock) === 'arm-hold', 6_000)).toBe(true);
    harness!.sendThrust(cr);
    expect(await until(() => clipOf(dock) === 'arm-retract', 3_000), 'moving off aborts the hold').toBe(true);
    await harness!.advance(4_000);
    expect(aboard(shipId), 'an aborted load moves nothing').toEqual(CARGO);
    expect(dock.hold?.goods).toEqual({ alloy: 40 });
  });

  it('a full ship with nothing to deliver gets no crane cycle at an outlet', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const { dock, shipId, cap } = await boot(pid, 0, 460, (_r, d) => {
      d.freightOrders = [{ good: 'alloy', mode: 'export', level: 1 }];
      stock(d, ['alloy', 40]);
    }, (c) => ({ salvage: c }));
    await harness!.advance(3_000);
    expect(clipOf(dock), 'no room for any export and nothing it takes in').toBeUndefined();
    expect(aboard(shipId)).toEqual({ salvage: cap });
    expect(dock.hold?.goods).toEqual({ alloy: 40 });
  });
});
