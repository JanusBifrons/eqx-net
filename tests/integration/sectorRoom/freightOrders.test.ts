/**
 * T4b (plan soft-leaping-truffle v3) — standing orders on a player's own
 * Freight Dock, over the real `set_freight_orders` message.
 *
 *  - The owner sets orders; they land on the dock and come back in its
 *    `cargo_state` (the panel's truth, #16).
 *  - The dock joins convoy planning (`npcBaseTrade`) as a player base: rates
 *    shaped by its orders, flagged as a player so it only trades with NPCs.
 *  - Nobody else can set orders on it.
 * The convoy flight and the wallet side are unit-tested over fake rooms
 * (ConvoyDirector.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { CargoState } from '../../../src/shared-types/messages/cargoMessages.js';
import { TARGET_MINUTES } from '../../../src/core/economy/convoys.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function ask(cr: Room, replies: CargoState[], entityId: number): Promise<CargoState> {
  const n = replies.length;
  cr.send('cargo_query', { type: 'cargo_query', entityId });
  return until(() => replies.length > n, 4000).then(() => replies[replies.length - 1]!);
}

describe('SectorRoom integration — Freight Dock standing orders (T4b)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('the owner sets orders; they show in cargo_state and join convoy planning; others cannot', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }, { kind: 'freight_dock', x: 0, y: 700 }],
      prebuiltStructuresOwner: pid,
    });
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 960 });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const room = harness.getServerRoom()!;
    const dock = [...room._internals.structureRegistry.all()].find((r) => r.kind === 'freight_dock')!;
    const entityId = room._internals.swarmRegistry.get(dock.id)!.entityId;

    const orders = [{ good: 'alloy', mode: 'import', level: 200 }, { good: 'fuel', mode: 'export', level: 50 }];
    cr.send('set_freight_orders', { type: 'set_freight_orders', entityId, orders });
    expect(await until(() => dock.freightOrders?.length === 2, 3_000)).toBe(true);

    const view = await ask(cr, replies, entityId);
    expect(view.open, view.message).toBe(true);
    expect(view.orders).toEqual(orders);

    const mine = room.npcBaseTrade().find((b) => b.owner === pid);
    expect(mine, 'the dock joins convoy planning').toBeDefined();
    expect(mine!.player).toEqual({ imports: ['alloy'], exports: ['fuel'] });
    expect(mine!.view.uses.alloy).toBeCloseTo(200 / TARGET_MINUTES, 6);
    expect(Object.keys(mine!.view.stock).sort()).toEqual(['alloy', 'fuel']);

    // A stranger can't set orders on it.
    const other = await harness.connectActive(randomUUID(), { spawnX: 0, spawnY: 1000 });
    other.send('set_freight_orders', { type: 'set_freight_orders', entityId, orders: [] });
    await harness.advance(300);
    expect(dock.freightOrders).toHaveLength(2);
  });
});
