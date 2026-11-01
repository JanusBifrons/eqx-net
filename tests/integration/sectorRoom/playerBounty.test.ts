/**
 * Living World P4c-2 (plan peppy-jumping-pinwheel) — PLAYER BOUNTIES through a
 * real SectorRoom and the real `place_bounty` message.
 *
 *  1. placing a bounty takes bounty + 25 % fee from the placer's banked credits
 *     in ONE move; the escrow holds exactly the bounty (the fee is burned);
 *  2. the rules reject: a short balance (nothing moves), a low-level target, a
 *     guest placer, a self-bounty, a second bounty on the same pilot;
 *  3. when another signed-in pilot destroys the target, the escrow is paid into
 *     the KILLER's ship hold and deleted (one atomic group); the placer can't
 *     claim their own bounty; then the pair cooldown blocks an instant re-place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { BountyBoard, bountyUid, setBountyBoard } from '../../../src/server/economy/BountyBoard.js';
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

describe('SectorRoom integration — player bounties (P4c-2)', () => {
  let harness: SectorTestHarness;
  const users = new Map<string, string>();
  const levels = new Map<string, number>();
  let clock = 1_000_000;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    users.clear();
    levels.clear();
    clock = 1_000_000;
    setBountyBoard(new BountyBoard(getHoldStore, {
      userIdOf: (pid) => users.get(pid) ?? null,
      maxShipLevel: (pid) => levels.get(pid) ?? 1,
      nameOf: (pid) => (users.has(pid) ? `Pilot-${pid.slice(0, 4)}` : null),
      lastSectorOf: () => 'sol-prime',
    }, () => clock));
  }, 15_000);
  afterEach(async () => {
    setBountyBoard(null);
    if (harness) await harness.cleanup();
  }, 10_000);

  it('escrows the bounty, burns the fee, enforces the rules, pays the killer', { timeout: 60_000 }, async () => {
    const placer = randomUUID();
    const target = randomUUID();
    const killer = randomUUID();
    const pc = await harness.connectActive(placer, { spawnX: 0, spawnY: 0 });
    await harness.connectActive(target, { spawnX: 600, spawnY: 0 });
    await harness.connectActive(killer, { spawnX: -600, spawnY: 0 });
    const r = room(pc.roomId);
    const internal = r._internals;
    const p2u = (r as unknown as { playerToUser: Map<string, string | null> }).playerToUser;
    for (const [pid, uid] of [[placer, 'u-placer'], [target, 'u-target'], [killer, 'u-killer']] as const) {
      users.set(pid, uid);
      p2u.set(pid, uid);
    }
    levels.set(target, 3);

    const results: BountyResult[] = [];
    pc.onMessage('bounty_result', (m: BountyResult) => results.push(m));
    const placeBounty = async (targetPlayerId: string, networkEntityId: number, amount: number): Promise<BountyResult> => {
      const n = results.length;
      pc.send('place_bounty', { targetPlayerId, networkEntityId, amount });
      expect(await until(() => results.length > n, 4000)).toBe(true);
      return results[results.length - 1]!;
    };

    // The placer's Capital with 600¢ banked.
    pc.send('place_structure', { type: 'place_structure', kind: 'capital', x: 150, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === placer), 5000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === placer)!;
    cap.hold = { goods: {}, credits: 600, blueprints: [] };
    const capEid = internal.swarmRegistry.get(cap.id)!.entityId;

    // Rules: self, short balance (nothing moves), low-level target.
    expect((await placeBounty(placer, capEid, 100)).ok).toBe(false);
    expect((await placeBounty(target, capEid, 1000)).ok).toBe(false);
    expect(cap.hold!.credits).toBe(600);
    levels.set(target, 2);
    expect((await placeBounty(target, capEid, 100)).ok).toBe(false);
    levels.set(target, 3);

    // Success: 400 bounty costs 500 (400 + 25 % fee); escrow holds exactly 400.
    const ok = await placeBounty(target, capEid, 400);
    expect(ok.ok, ok.message).toBe(true);
    expect(cap.hold!.credits).toBe(600 - pvpBountyCost(400));
    const escrow = getHoldStore().get(bountyUid(target, placer));
    expect(escrow?.holderType).toBe('bounty');
    expect(escrow?.hold.credits).toBe(400);
    // One bounty per pilot pair.
    expect((await placeBounty(target, capEid, 100)).ok).toBe(false);

    // A guest placer is refused.
    p2u.set(placer, null);
    expect((await placeBounty(target, capEid, 100)).ok).toBe(false);
    p2u.set(placer, 'u-placer');

    // The placer killing the target can't claim their own bounty.
    r.eventBus().emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: target, shooterId: placer });
    expect(getHoldStore().get(bountyUid(target, placer))?.hold.credits).toBe(400);

    // Another pilot's kill collects it, into THEIR ship hold.
    const target2 = target; // the bounty is on the PLAYER, not one hull
    const state = r.state as SectorState;
    let killerShip = '';
    for (const [, s] of state.ships) if (s.playerId === killer && s.isActive) killerShip = s.shipInstanceId;
    r.eventBus().emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: target2, shooterId: killer });
    expect(getHoldStore().get(bountyUid(target, placer))).toBeUndefined();
    expect(getHoldStore().get(killerShip)?.hold.credits).toBe(400);

    // The pair cooldown blocks an instant re-place; it lapses after 24 h.
    expect((await placeBounty(target, capEid, 100)).ok).toBe(false);
    clock += 24 * 60 * 60_000 + 1;
    cap.hold!.credits += 200; // 100 left + 200 ≥ the 125¢ cost of a 100¢ bounty
    expect((await placeBounty(target, capEid, 100)).ok).toBe(true);
  });
});
