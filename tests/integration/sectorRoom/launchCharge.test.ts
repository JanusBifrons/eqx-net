/**
 * Join flow stage 2 — paying for a launch, through a real SectorRoom.
 *
 * With launch prices switched on (test room option `launchCosts`), a fresh
 * spawn of a capital is paid for at the hull gate: from the wallet, with one
 * of the pilot's free launches, or into debt down to the floor; past the floor
 * the pilot launches in a Fighter instead. Resuming an owned hull is free.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { getTradeSink } from '../../../src/server/economy/tradeSink.js';
import { DEBT_FLOOR, FREE_LAUNCHES_START, LAUNCH_COST } from '../../../src/shared-types/launch.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — launch charging (join flow stage 2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('pays, spends a free launch, goes into debt, refuses past the floor, and resumes free', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      enforceHullGate: true, launchCosts: true, tradeEnabled: true,
    });
    const kindOf = (pid: string): string => {
      const room = harness.getServerRoom() as unknown as SectorRoom;
      for (const [, s] of (room.state as SectorState).ships) if (s.playerId === pid && s.isActive) return s.kind;
      return '';
    };
    const sink = getTradeSink();
    expect(sink?.freeLaunches).toBeDefined();
    const wallet = getWallet();
    const launch = async (pid: string, kind: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const c = await harness.connectActive(pid, { spawnX: 0, spawnY: 0, shipKind: kind, isNewShip: true, ...extra });
      const got = kindOf(pid);
      await c.leave();
      await harness.advance(300);
      return got;
    };

    // Pay: `initialWallet` seeds BEFORE the charge, so it pays for the launch.
    const payer = randomUUID();
    expect(await launch(payer, 'destroyer', { initialWallet: 10_000 })).toBe('destroyer');
    expect(wallet.balance(payer)).toBe(10_000 - LAUNCH_COST.destroyer!);
    expect(sink!.freeLaunches!(payer)).toBe(FREE_LAUNCHES_START);

    // Token: a new pilot with no credits launches a battleship on a free launch.
    const rookie = randomUUID();
    expect(await launch(rookie, 'battleship')).toBe('battleship');
    expect(wallet.balance(rookie)).toBe(0);
    expect(sink!.freeLaunches!(rookie)).toBe(FREE_LAUNCHES_START - 1);

    // Debt: free launches spent ⇒ the price goes on the wallet, below zero.
    while (sink!.spendFreeLaunch!(rookie));
    expect(await launch(rookie, 'destroyer')).toBe('destroyer');
    expect(wallet.balance(rookie)).toBe(-LAUNCH_COST.destroyer!);

    // Refuse: past the debt floor ⇒ a Fighter, nothing charged.
    wallet.debitAllowingDebt(rookie, wallet.balance(rookie) - DEBT_FLOOR - 1, DEBT_FLOOR, 'test');
    expect(wallet.balance(rookie)).toBe(DEBT_FLOOR + 1);
    expect(await launch(rookie, 'battleship')).toBe('fighter');
    expect(wallet.balance(rookie)).toBe(DEBT_FLOOR + 1);

    // Resume: an owned capital parked here relaunches free.
    const owned = getPlayerShipStore().create({ playerId: rookie, userId: null, kind: 'battleship', sectorKey: 'sol-prime', x: 300, y: 300, health: 500 });
    const c = await harness.connectActive(rookie, { spawnX: 0, spawnY: 0, shipId: owned.shipId });
    expect(kindOf(rookie)).toBe('battleship');
    expect(wallet.balance(rookie)).toBe(DEBT_FLOOR + 1);
    await c.leave();
  });
});
