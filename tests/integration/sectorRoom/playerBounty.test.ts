/**
 * Living World P4c-2 / economy v2 W1 (plan peppy-jumping-pinwheel) — PLAYER
 * BOUNTIES through a real SectorRoom and the real `place_bounty` message.
 * Credits are VIRTUAL: the bounty is paid from the placer's WALLET (anywhere,
 * no storage needed) and collected into the killer's WALLET.
 *
 *  1. placing a bounty debits bounty + 25 % fee from the placer's wallet; the
 *     board records exactly the bounty (the fee is burned);
 *  2. the rules reject: a short wallet (nothing moves), a low-level target, a
 *     self-bounty, a second bounty on the same pilot;
 *  3. when another pilot destroys the target, the bounty lands in the KILLER's
 *     wallet; the placer can't claim their own bounty; then the pair cooldown
 *     blocks an instant re-place; guests are full players throughout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getPersistence, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { BountyBoard, setBountyBoard } from '../../../src/server/economy/BountyBoard.js';
import { pvpBountyCost, type BountyResult } from '../../../src/shared-types/contracts.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('SectorRoom integration — player bounties (P4c-2, wallet)', () => {
  let harness: SectorTestHarness;
  let board: BountyBoard;
  const levels = new Map<string, number>();
  let clock = 1_000_000;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    levels.clear();
    clock = 1_000_000;
    board = new BountyBoard(getWallet(), getPersistence, {
      maxShipLevel: (pid) => levels.get(pid) ?? 1,
      nameOf: (pid) => `Pilot-${pid.slice(0, 4)}`,
      lastSectorOf: () => 'sol-prime',
    }, () => clock);
    setBountyBoard(board);
  }, 15_000);
  afterEach(async () => {
    setBountyBoard(null);
    if (harness) await harness.cleanup();
  }, 10_000);

  it('debits the wallet, burns the fee, enforces the rules, pays the killer\'s wallet', { timeout: 60_000 }, async () => {
    const placer = randomUUID();
    const target = randomUUID();
    const killer = randomUUID();
    // No storage anywhere: a bounty is paid from the wallet (guests too).
    const pc = await harness.connectActive(placer, { spawnX: 0, spawnY: 0, initialWallet: 600 });
    await harness.connectActive(target, { spawnX: 600, spawnY: 0 });
    await harness.connectActive(killer, { spawnX: -600, spawnY: 0 });
    const r = room(pc.roomId);
    const wallet = getWallet();
    levels.set(target, 3);

    const results: BountyResult[] = [];
    pc.onMessage('bounty_result', (m: BountyResult) => results.push(m));
    const placeBounty = async (targetPlayerId: string, amount: number): Promise<BountyResult> => {
      const n = results.length;
      pc.send('place_bounty', { type: 'place_bounty', targetPlayerId, amount });
      expect(await until(() => results.length > n, 4000)).toBe(true);
      return results[results.length - 1]!;
    };

    // Rules: self, short wallet (nothing moves), low-level target.
    expect((await placeBounty(placer, 100)).ok).toBe(false);
    expect((await placeBounty(target, 1000)).ok).toBe(false);
    expect(wallet.balance(placer)).toBe(600);
    levels.set(target, 2);
    expect((await placeBounty(target, 100)).ok).toBe(false);
    levels.set(target, 3);

    // Success: a 400 bounty costs 500 (400 + 25 % fee); the board holds 400.
    const ok = await placeBounty(target, 400);
    expect(ok.ok, ok.message).toBe(true);
    expect(wallet.balance(placer)).toBe(600 - pvpBountyCost(400));
    expect(board.amountOf(target, placer)).toBe(400);
    // One bounty per pilot pair.
    expect((await placeBounty(target, 100)).ok).toBe(false);

    // The placer killing the target can't claim their own bounty.
    r.eventBus().emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: target, shooterId: placer });
    expect(board.amountOf(target, placer)).toBe(400);

    // Another pilot's kill collects it, into THEIR wallet.
    r.eventBus().emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: target, shooterId: killer });
    expect(board.amountOf(target, placer)).toBe(0);
    expect(wallet.balance(killer)).toBe(400);

    // The pair cooldown blocks an instant re-place; it lapses after 24 h.
    wallet.credit(placer, 200, 'test_seed'); // 100 left + 200 ≥ the 125¢ cost
    expect((await placeBounty(target, 100)).ok).toBe(false);
    clock += 24 * 60 * 60_000 + 1;
    expect((await placeBounty(target, 100)).ok).toBe(true);
  });
});
