/**
 * Correctness lock — RESUMING a ship that is STILL LINGERING in the target
 * sector must NOT leave the player locked/broken (playtest 2026-06-10 Issue 6).
 *
 * User report (verbatim, constrains the diagnosis): "the local player spawns in
 * AS the lingering hull on their computer, and can fire and try to accelerate…
 * but nothing hits and the ship doesn't move and snaps back. To another player
 * it's just a static lingering hull." I.e. the client binds + predicts locally,
 * but server-side the hull never becomes a CLEAN active ship — input lands on an
 * orphan, every snapshot reconciles back to the static lingering pose.
 *
 * Root cause (RED before the fix): the fresh-spawn shipId-restore path
 * (`SectorRoom.onJoin`) checks only `PlayerShipStore` — never "is this hull live
 * in the room". When the requested shipId is a lingering hull it owns a
 * `lingeringSlots` entry, a `linger-<id>` worker body, AND an armed
 * ownerless-evict timer keyed by that same shipInstanceId. `state.ships.set(B)`
 * then CLOBBERS the lingering ShipState under the same key while all three
 * survive: the orphan body pins the fresh hull, and the surviving timer later
 * DELETES the now-active ship.
 *
 * The fix: evict-then-restore — if the requested hull is live in the room, run
 * the OwnerlessShipEvictor teardown (despawn linger-<id>, cancel timer, free
 * slot, markStored, delete schema entry) BEFORE the bind + restore.
 *
 * The flow this drives (the realistic "swap ships via the roster" cycle):
 *   1. PID spawns fighter B (active).
 *   2. PID disconnects → B lingers.
 *   3. PID reconnects isNewShip → scout C active, B displaced into lingeringSlots
 *      (still in state.ships; ownerlessShips[B] + linger-B survive).
 *   4. PID disconnects C → C lingers too.
 *   5. PID rejoins with shipId: B → the path must EVICT the lingering B, then
 *      restore it cleanly: no lingeringSlots[B], no armed evict timer, B active.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — resume a lingering ship by id', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('evicts the still-lingering hull before re-binding it — clean active ship, no orphan timer', async () => {
    const pid = randomUUID();

    // 1) Spawn fighter B, active.
    const client1 = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 500, spawnY: -300 });
    const state = harness.getServerRoom()!.state as SectorState;
    const internals = harness.getServerRoom()!._internals;

    let bId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { bId = s.shipInstanceId; break; }
    }
    expect(bId).not.toBe('');
    expect(state.ships.get(bId)!.kind).toBe('fighter');

    // 2) Disconnect → B lingers (ownerless-evict timer armed, keyed by bId).
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    expect(state.ships.get(bId)!.isActive).toBe(false);
    expect(internals.ownerlessShips.has(bId)).toBe(true);

    // 3) Reconnect isNewShip → scout C active; B displaced into lingeringSlots.
    const client2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout' });
    expect(internals.lingeringSlots.has(bId)).toBe(true);
    expect(internals.ownerlessShips.has(bId)).toBe(true);
    expect(state.ships.size).toBe(2);
    // B's roster row must still be resumable (owned, same sector).
    const recBeforeResume = getPlayerShipStore().get(bId);
    expect(recBeforeResume).not.toBeNull();
    expect(recBeforeResume!.lastSectorKey).toBe('sol-prime');

    // 4) Disconnect C → it lingers too (so the rejoin takes the displace →
    //    fresh-spawn-restore branch, the production roster-swap path).
    await harness.disconnectClient(client2);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });

    // 5) Rejoin requesting B by id. connectActive resolves only when a hull for
    //    pid is isActive — so this also proves the handshake completes for the
    //    restored B (it would for the clobbered hull too; the discriminators
    //    below are the lingering bookkeeping).
    const client3 = await harness.connectActive(pid, { shipId: bId });

    // The lingering bookkeeping for B is GONE (RED before the fix — the
    // fresh-spawn path never evicted it, so both stayed populated and the
    // armed timer would later delete the player's active hull).
    expect(internals.ownerlessShips.has(bId), 'evict cancelled B’s ownerless timer').toBe(false);
    expect(internals.lingeringSlots.has(bId), 'B is no longer a lingering slot').toBe(false);

    // B is the player's clean, active hull with positive health.
    const bShip = state.ships.get(bId);
    expect(bShip).toBeDefined();
    expect(bShip!.isActive).toBe(true);
    expect(bShip!.playerId).toBe(pid);
    expect(bShip!.health).toBeGreaterThan(0);
    expect(bShip!.kind).toBe('fighter');
    // Exactly one schema entry keyed by B (no clobbered duplicate).
    let bCount = 0;
    for (const [key] of state.ships) if (key === bId) bCount++;
    expect(bCount).toBe(1);

    await harness.disconnectClient(client3);
  }, 25_000);
});
