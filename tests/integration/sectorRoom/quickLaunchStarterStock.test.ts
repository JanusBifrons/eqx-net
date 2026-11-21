/**
 * Quick Launch starter crate — a brand-new pilot who joins with
 * `startMode: 'command'` (the Quick Launch path) gets the starter Capital crate
 * in their hull's hold, and Build can see it: `packed_stock` counts it while the
 * hull is PARKED (Command / Build view), not only while it is flown.
 *
 * Fail-first: `packed_stock` read only the ACTIVE hull's hold, so the parked
 * hull's crate answered `{}` and Build showed "Capital · needs packed".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { getStarterGrantEconomy, setStarterGrantEconomy, STARTER_CAPITAL_PRODUCT } from '../../../src/server/economy/starterGrant.js';
import type { IPersistenceSink } from '../../../src/core/contracts/IPersistenceSink.js';

describe('SectorRoom integration — Quick Launch (command start) starter crate', () => {
  let harness: SectorTestHarness;
  let prevEcon: ReturnType<typeof getStarterGrantEconomy>;

  beforeEach(async () => {
    prevEcon = getStarterGrantEconomy();
    const sink = { enqueueCritical: () => undefined, enqueue: () => undefined } as unknown as IPersistenceSink;
    setStarterGrantEconomy(new EconomyStore({ persistence: () => sink }));
    harness = await bootSectorTestServer({ sectorKey: 'galaxy-test', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    setStarterGrantEconomy(prevEcon);
    if (harness) await harness.cleanup();
  }, 10_000);

  it("startMode 'command': packed_stock counts the starter Capital in the parked hull", async () => {
    const pid = randomUUID();
    const room = await harness.connectAs(pid, { shipKind: 'fighter', isNewShip: true, spawnX: 0, spawnY: 0, startMode: 'command' });
    const replies: Array<{ counts: Record<string, number> }> = [];
    room.onMessage('packed_stock', (msg: { counts: Record<string, number> }) => { replies.push(msg); });
    room.onMessage('*', () => undefined);
    room.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({ tag: 'command_start', where: (d) => d['playerId'] === pid }, 5_000);
    await harness.advance(200);

    room.send('packed_stock_query', { type: 'packed_stock_query' });
    const deadline = Date.now() + 3000;
    while (replies.length === 0 && Date.now() < deadline) await harness.advance(40);
    expect(replies.length, 'a packed_stock reply').toBeGreaterThan(0);
    expect(replies[0]!.counts[STARTER_CAPITAL_PRODUCT], 'the starter crate counts in Command / Build view').toBe(1);

    await harness.disconnectClient(room);
  }, 30_000);
});
