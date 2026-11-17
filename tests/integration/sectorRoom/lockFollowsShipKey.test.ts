/**
 * RTS Part A — a lock on a ship survives its owner taking or letting go of
 * its controls (illogical-behaviour bug: "it's the same ship").
 *
 * A player ship's lock key is `p:<playerId>` while its pilot flies it and
 * `p:<shipInstanceId>` while an AI pilot flies it (`resolveLockTarget`). When
 * the owner took the controls (or let go), the key flipped and every lock on
 * the ship dropped: a pilot's lock on it, the ship's OWN weapon groups' locks
 * (they live in the pilot's `locks` vs the AI pilots' `wingmanLocks`), and AI
 * pilots' locks on its pilot through the take-controls handshake.
 *
 * Fix: the one "ship key moved" seam (`SectorRoom.shipKeyMoved` →
 * `LockSubsystem.shipKeyMoved`) at the server's re-key sites
 * (`displaceActiveHullToLingering`, `reclaimLingeringHull`).
 *
 * Failing-first: before the fix A's lock on B's hull dropped the first lock
 * step after B took the controls; B's own lock was gone the moment its hull
 * went to the AI pilot; and the battleship's lock on B was wiped while B's
 * reclaimed hull waited for `client_ready`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_CAPITAL_DUEL_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Private room paths the test drives directly (synchronous, no tick in between). */
interface RoomPeek {
  enterSpectate(playerId: string): void;
  npcLocks: { isLocked(npcId: string, pilotId: string): boolean };
}

describe('SectorRoom integration — locks follow a ship when its key moves (RTS Part A)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  const room = (): SectorRoom => harness.getServerRoom() as unknown as SectorRoom;
  const activeSidOf = (pid: string): string => {
    for (const [, s] of (room().state as SectorState).ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  };
  /** Stage of the lock on `key` in any of `id`'s groups (-1 = none). */
  const lockStage = (id: string, key: string): number => {
    for (const g of room()._internals.locksOf(id) ?? []) for (const l of g.l) if (l.t === key) return l.s;
    return -1;
  };
  const LOCKED = 2;

  async function fireUntilHit(a: ClientRoom<SectorState>, hull: string): Promise<boolean> {
    const ship = (room().state as SectorState).ships.get(hull)!;
    const hp0 = ship.health;
    for (let i = 0; i < 6; i++) {
      a.send('fire', {
        type: 'fire', tick: room()._internals.serverTick, clientShotId: `s${Date.now()}-${i}`,
        weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
      });
      await harness.advance(400);
      if (ship.health < hp0) return true;
    }
    return false;
  }

  it('A\'s lock on B\'s ship holds while B takes its controls and lets go again, and A\'s fire lands', { timeout: 40_000 }, async () => {
    const bPid = randomUUID();
    const b = (await harness.connectActive(bPid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 180, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const hull = activeSidOf(bPid);
    b.send('spectate', { type: 'spectate' });
    await waitUntil(() => room()._internals.lingeringSlots.has(hull), 3000, 'B\'s hull is parked');
    room()._internals.fleet.setStance(bPid, [hull], 'holdFire');

    const aPid = randomUUID();
    const a = (await harness.connectActive(aPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    harness.lockTarget(aPid, `p:${hull}`, 'primary');
    expect(lockStage(aPid, `p:${hull}`)).toBe(LOCKED);

    // B takes the controls: the ship is now named by B's playerId.
    b.send('pilot_ship', { type: 'pilot_ship', shipId: hull });
    b.send('client_ready', { type: 'client_ready' });
    await waitUntil(() => (room().state as SectorState).ships.get(hull)?.isActive === true, 5000, 'B flies the hull');
    await harness.advance(400); // several lock steps
    expect(lockStage(aPid, `p:${bPid}`), 'A\'s lock followed the ship to its pilot').toBe(LOCKED);
    expect(lockStage(aPid, `p:${hull}`)).toBe(-1);
    expect(await fireUntilHit(a, hull), 'A\'s locked shot hit B\'s piloted ship').toBe(true);

    // B lets go: the ship is named by its shipInstanceId again.
    b.send('spectate', { type: 'spectate' });
    await waitUntil(() => room()._internals.lingeringSlots.has(hull), 3000, 'B\'s hull is parked again');
    room()._internals.fleet.setStance(bPid, [hull], 'holdFire');
    await harness.advance(400);
    expect(lockStage(aPid, `p:${hull}`), 'A\'s lock followed the ship to its AI pilot').toBe(LOCKED);
    expect(lockStage(aPid, `p:${bPid}`)).toBe(-1);
    expect(await fireUntilHit(a, hull), 'A\'s locked shot hit B\'s AI-flown ship').toBe(true);
  });

  it('B\'s own groups\' locks survive B letting go and taking the controls back', { timeout: 40_000 }, async () => {
    const aPid = randomUUID();
    await harness.connectActive(aPid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, initialHull: 1_000_000, initialShield: 0 });
    const cPid = randomUUID();
    await harness.connectActive(cPid, { shipKind: 'fighter', spawnX: 200, spawnY: 180, initialHull: 1_000_000, initialShield: 0 });
    const bPid = randomUUID();
    const b = (await harness.connectActive(bPid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 180, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    const hull = activeSidOf(bPid);
    harness.lockTarget(bPid, `p:${aPid}`);
    expect(lockStage(bPid, `p:${aPid}`)).toBe(LOCKED);

    // B lets go (Command): the very same server step hands the ship to its AI
    // pilot, and the ship's lock goes with it.
    (room() as unknown as RoomPeek).enterSpectate(bPid);
    expect(room()._internals.fleet.isAttached(hull)).toBe(true);
    expect(lockStage(hull, `p:${aPid}`), 'the AI pilot kept the ship\'s lock').toBe(LOCKED);
    expect(lockStage(bPid, `p:${aPid}`)).toBe(-1);

    // The AI pilot is ordered onto C; it locks C instead.
    const fleet = room()._internals.fleet;
    fleet.setStance(bPid, [hull], 'aggressive');
    expect(fleet.applyOrder(bPid, [hull], { kind: 'attack', targetId: cPid })).toEqual([hull]);
    await waitUntil(() => lockStage(hull, `p:${cPid}`) === LOCKED, 5000, 'the AI pilot locks C');

    // B takes the controls back: the AI pilot's lock on C is now B's.
    b.send('pilot_ship', { type: 'pilot_ship', shipId: hull });
    await waitUntil(() => !room()._internals.lingeringSlots.has(hull), 3000, 'B reclaims the hull');
    expect(lockStage(bPid, `p:${cPid}`), 'B took over the ship\'s lock on C').toBe(LOCKED);
    expect(lockStage(bPid, `p:${aPid}`), 'no stale lock from before').toBe(-1);
  });
});

describe('SectorRoom integration — an AI pilot\'s lock on a pilot holds while they take back their ship', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    const d = SHOWCASE_CAPITAL_DUEL_OPTS;
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      peacefulDrones: d.peacefulDrones,
      prebuiltStructures: d.prebuiltStructures,
      defaultSpawnX: d.defaultSpawnX,
      defaultSpawnY: d.defaultSpawnY,
      dronePoses: [{ kind: 'battleship', x: 0, y: 0, angle: (-50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('the battleship\'s lock on a spectating pilot survives the take-controls handshake', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    const peek = server as unknown as RoomPeek;
    let shipId = '';
    for (const [, s] of server.state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    const npc = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    cr.send('test_aggro', { type: 'test_aggro' });
    await waitUntil(() => peek.npcLocks.isLocked(npc.id, pid), 10_000, 'the battleship locks the pilot');

    cr.send('spectate', { type: 'spectate' });
    await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');
    expect(peek.npcLocks.isLocked(npc.id, pid)).toBe(true);

    // Take the same ship back, but hold `client_ready`: the hull waits in the
    // world (isActive=false) for the join handshake for several lock steps.
    cr.send('pilot_ship', { type: 'pilot_ship', shipId });
    await waitUntil(() => !server._internals.lingeringSlots.has(shipId), 3000, 'the reclaim starts');
    await harness.advance(500);
    expect(server.state.ships.get(shipId)!.isActive, 'still in the handshake').toBe(false);
    expect(peek.npcLocks.isLocked(npc.id, pid), 'the battleship kept its lock through the handshake').toBe(true);
    cr.send('client_ready', { type: 'client_ready' });
    await waitUntil(() => server.state.ships.get(shipId)?.isActive === true, 5000, 'the pilot flies it');
    expect(peek.npcLocks.isLocked(npc.id, pid)).toBe(true);
  });
});
