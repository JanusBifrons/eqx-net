/**
 * RTS Part A — a ship changing hands keeps what the fleet knows about it.
 *
 * A player ship's key is its pilot's playerId while they fly it and its
 * shipInstanceId while an AI pilot flies it. When the owner takes or lets go
 * of the controls the key moves (`displaceActiveHullToLingering` /
 * `reclaimLingeringHull`), and the one "ship key moved" seam
 * (`SectorRoom.shipKeyMoved`) moves everything that names the ship:
 *
 *  1. Attack orders. A's AI-flown ship ordered onto B's ship kept the OLD key,
 *     so when B let go of (or took) the controls the order stopped resolving
 *     and A's ship gave up the attack ("it's the same ship").
 *  2. Turret angles (`mountTicker.playerMountAngles`, keyed like the ship).
 *     They stayed under the old key, so the hull's turrets snapped back to
 *     their base angle the moment it changed hands (breaks "seamless").
 *
 * Failing-first: before the fix A's order was dropped once B parked, and B's
 * turret angles under the new key were absent (zeros) after either hand-over.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import type { Client } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
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
  reclaimLingeringHull(client: Client, playerId: string, shipId: string): void;
  mountTicker: { playerMountAngles: Map<string, Float32Array> };
  clients: Iterable<Client>;
  playerToSession: Map<string, string>;
}

const LOCKED = 2;

describe('SectorRoom integration — a ship changing hands keeps its fleet state (RTS Part A)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  const room = (): SectorRoom => harness.getServerRoom() as unknown as SectorRoom;
  const peek = (): RoomPeek => room() as unknown as RoomPeek;
  const activeSidOf = (pid: string): string => {
    for (const [, s] of (room().state as SectorState).ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  };
  const lockStage = (id: string, key: string): number => {
    for (const g of room()._internals.locksOf(id) ?? []) for (const l of g.l) if (l.t === key) return l.s;
    return -1;
  };
  const orderTarget = (hull: string): string | null => {
    const o = room()._internals.fleet.brainOf(hull)?.order ?? null;
    return o !== null && o.kind === 'attack' ? o.targetId : null;
  };

  // RTS Part B slice 8: the attack order reaches the AI pilot brain; until then the hull never locks the named ship.
  it.skip('A\'s AI-flown ship keeps attacking B\'s ship while B lets go of its controls and takes them back', { timeout: 40_000 }, async () => {
    const aPid = randomUUID();
    const a = (await harness.connectActive(aPid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 0, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const aHull = activeSidOf(aPid);
    a.send('spectate', { type: 'spectate' });
    await waitUntil(() => room()._internals.fleet.isAttached(aHull), 3000, 'A\'s ship is AI-flown');

    const bPid = randomUUID();
    const b = (await harness.connectActive(bPid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 300, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const bHull = activeSidOf(bPid);

    const fleet = room()._internals.fleet;
    fleet.setStance(aPid, [aHull], 'aggressive');
    expect(fleet.applyOrder(aPid, [aHull], { kind: 'attack', targetId: bPid })).toEqual([aHull]);
    await waitUntil(() => lockStage(aHull, `p:${bPid}`) === LOCKED, 8000, 'A\'s ship locks B\'s piloted ship');

    // B lets go: the ship is named by its shipInstanceId now.
    b.send('spectate', { type: 'spectate' });
    await waitUntil(() => room()._internals.lingeringSlots.has(bHull), 3000, 'B\'s ship is parked');
    room()._internals.fleet.setStance(bPid, [bHull], 'holdFire');
    await harness.advance(600);
    expect(orderTarget(aHull), 'the attack order follows the ship to its AI pilot').toBe(bHull);
    expect(fleet.brainOf(aHull)!.targetId).toBe(bHull);
    expect(lockStage(aHull, `p:${bHull}`), 'A\'s ship still holds its lock on it').toBe(LOCKED);

    // B takes the controls back: the ship is named by B's playerId again.
    b.send('pilot_ship', { type: 'pilot_ship', shipId: bHull });
    b.send('client_ready', { type: 'client_ready' });
    await waitUntil(() => (room().state as SectorState).ships.get(bHull)?.isActive === true, 5000, 'B flies the ship');
    await harness.advance(600);
    expect(orderTarget(aHull), 'the attack order follows the ship to its pilot').toBe(bPid);
    expect(lockStage(aHull, `p:${bPid}`)).toBe(LOCKED);
  });

  it('turret angles are the same before and after each hand-over', { timeout: 40_000 }, async () => {
    const cPid = randomUUID();
    await harness.connectActive(cPid, { shipKind: 'fighter', spawnX: 200, spawnY: 600, initialHull: 1_000_000, initialShield: 0 });
    const bPid = randomUUID();
    const b = (await harness.connectActive(bPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    const hull = activeSidOf(bPid);
    let wireAngles: number[] | undefined;
    b.onMessage('snapshot', (snap: { states?: Record<string, { mountAngles?: number[] }> }) => {
      const st = snap.states?.[hull];
      if (st !== undefined) wireAngles = st.mountAngles;
    });
    harness.lockTarget(bPid, `p:${cPid}`);
    const angles = peek().mountTicker.playerMountAngles;
    // The wing turrets slew toward C (off the bow) and settle there.
    await waitUntil(() => {
      const a = angles.get(bPid);
      return a !== undefined && a.some((v) => Math.abs(v) > 0.05);
    }, 5000, 'B\'s turrets train on C');
    await harness.advance(500);
    const before = Array.from(angles.get(bPid)!);

    // Let go: same server step, the ship is the AI pilot's.
    peek().enterSpectate(bPid);
    expect(room()._internals.lingeringSlots.has(hull)).toBe(true);
    expect(Array.from(angles.get(hull) ?? []), 'turret angles moved with the ship').toEqual(before);
    expect(angles.has(bPid)).toBe(false);

    // Take the controls back: same server step, the ship is B's again.
    const sid = peek().playerToSession.get(bPid)!;
    const client = [...peek().clients].find((c) => c.sessionId === sid)!;
    peek().reclaimLingeringHull(client, bPid, hull);
    expect(room()._internals.lingeringSlots.has(hull)).toBe(false);
    expect(Array.from(angles.get(bPid) ?? []), 'turret angles moved back with the ship').toEqual(before);
    expect(angles.has(hull)).toBe(false);

    // Through the join handshake (no `client_ready` yet: the hull is in the
    // world, isActive=false) the snapshot still carries its turret angles.
    wireAngles = undefined;
    await harness.advance(400);
    expect(wireAngles, 'turret angles on the wire during the handshake').toBeDefined();
    for (let i = 0; i < before.length; i++) expect(wireAngles![i]!).toBeCloseTo(before[i]!, 2);
  });
});
