/**
 * Playtest 2026-11-21 — "when a player locks their phone, their ship vanishes
 * from the game world for everyone, then reappears when they come back."
 *
 * A dropped connection (consented=false: phone locked, socket died) must leave
 * the ship IN the world for everyone else: still in state, still in every
 * observer's snapshot at its pose, still a body in physics. When the player
 * comes back (the client auto-rejoin, same playerId + shipId), they fly the
 * SAME ship id again, not a new one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

describe('SectorRoom integration — a dropped pilot’s ship stays in the world', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('stays in state, physics and observers’ snapshots; the rejoin flies the same ship id', async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();
    const a = await harness.connectActive(pidA, { shipKind: 'fighter', spawnX: 400, spawnY: 200 });
    const b = await harness.connectActive(pidB, { shipKind: 'scout', spawnX: -400, spawnY: -200 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;

    let shipA = '';
    for (const [, s] of state.ships) if (s.playerId === pidA && s.isActive) shipA = s.shipInstanceId;
    expect(shipA).not.toBe('');

    // A is holding thrust when the phone locks.
    harness.sendThrust(a);
    let thrusting = false;
    for (let i = 0; i < 10 && !thrusting; i++) {
      const snap = await harness.waitForSnapshot(b);
      thrusting = snap.states[shipA]?.lastInput?.thrust === true;
    }
    expect(thrusting, 'A holds thrust before the drop').toBe(true);

    // A's phone locks: the socket drops WITHOUT consent (no leave() handshake).
    const dropped = harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pidA });
    a.connection.close(4001, 'phone locked');
    await dropped;

    // Nobody flies it now: its held input is cleared, so it coasts to a stop
    // under normal physics instead of thrusting on forever.
    let lastThrust: boolean | undefined;
    for (let i = 0; i < 4; i++) {
      harness.sendThrust(b);
      const snap = await harness.waitForSnapshot(b);
      lastThrust = snap.states[shipA]?.lastInput?.thrust;
    }
    expect(lastThrust === true, 'dropped ship’s held thrust is cleared').toBe(false);

    // Still in state, alive.
    const hull = state.ships.get(shipA);
    expect(hull, 'ship still in state').toBeDefined();
    expect(hull!.alive).toBe(true);

    // Observers keep receiving the ship in every snapshot.
    harness.sendThrust(b);
    let seen: SnapshotMessage | null = null;
    for (let i = 0; i < 10 && seen === null; i++) {
      harness.sendThrust(b);
      const snap = await harness.waitForSnapshot(b);
      if (snap.states[shipA] !== undefined) seen = snap;
    }
    expect(seen, 'observer B still receives A’s ship').not.toBeNull();
    expect(seen!.states[shipA]!.playerId).toBe(pidA);

    // A comes back (client auto-rejoin: same playerId, its ship id). Through the
    // rejoin handshake (welcome → client_ready → arrival; seconds on a phone)
    // the ship was in the world all along, so observers keep receiving it:
    // it must not vanish and warp in again (RED before the fix: a rebind hid
    // the hull from others as a "fresh spawn" until its arrival tick).
    const a2 = await harness.connectAs(pidA, { shipId: shipA });
    await harness.events.waitFor({ tag: 'pending_join_registered', where: (d) => d['playerId'] === pidA });
    for (let i = 0; i < 5; i++) {
      harness.sendThrust(b);
      const snap = await harness.waitForSnapshot(b);
      expect(snap.states[shipA], `observer still receives A’s ship during the rejoin (snapshot ${i})`).toBeDefined();
    }
    a2.send('client_ready', { type: 'client_ready' });
    const deadline = Date.now() + 3000;
    while (state.ships.get(shipA)?.isActive !== true && Date.now() < deadline) await harness.advance(50);
    let flying = '';
    for (const [, s] of state.ships) if (s.playerId === pidA && s.isActive) flying = s.shipInstanceId;
    expect(flying, 'rejoin re-adopts the same ship').toBe(shipA);
    let countA = 0;
    for (const [, s] of state.ships) if (s.playerId === pidA) countA++;
    expect(countA, 'no second ship for A').toBe(1);

    await harness.disconnectClient(a2);
    await harness.disconnectClient(b);
  }, 30_000);

  it('in command view (hull parked) the drop keeps the hull too; the rejoin finds the same ship', async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();
    const a = await harness.connectActive(pidA, { shipKind: 'fighter', spawnX: 400, spawnY: 200 });
    const b = await harness.connectActive(pidB, { shipKind: 'scout', spawnX: -400, spawnY: -200 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let shipA = '';
    for (const [, s] of state.ships) if (s.playerId === pidA && s.isActive) shipA = s.shipInstanceId;
    expect(shipA).not.toBe('');

    // A switches to command view: the hull parks (AI-flown, isActive=false).
    a.send('command', { type: 'command' });
    await harness.events.waitFor({ tag: 'pilot_swap_displaced', where: (d) => d['playerId'] === pidA });
    expect(room._internals.lingeringSlots.has(shipA)).toBe(true);

    // Phone locks: socket drops without consent.
    a.connection.close(4001, 'phone locked');
    await harness.advance(500);

    expect(state.ships.get(shipA), 'parked hull still in state').toBeDefined();
    expect(state.ships.get(shipA)!.alive).toBe(true);
    expect(room._internals.lingeringSlots.has(shipA), 'parked hull still a physics body').toBe(true);

    let seen = false;
    for (let i = 0; i < 10 && !seen; i++) {
      harness.sendThrust(b);
      const snap = await harness.waitForSnapshot(b);
      seen = snap.states[shipA] !== undefined;
    }
    expect(seen, 'observer B still receives A’s parked hull').toBe(true);

    // A comes back with its ship id → the same ship, never a second one, and
    // observers keep receiving it through the rejoin handshake.
    const a2 = await harness.connectAs(pidA, { shipId: shipA });
    await harness.events.waitFor({ tag: 'pending_join_registered', where: (d) => d['playerId'] === pidA });
    for (let i = 0; i < 5; i++) {
      harness.sendThrust(b);
      const snap = await harness.waitForSnapshot(b);
      expect(snap.states[shipA], `observer still receives A’s hull during the rejoin (snapshot ${i})`).toBeDefined();
    }
    a2.send('client_ready', { type: 'client_ready' });
    const deadline = Date.now() + 3000;
    while (state.ships.get(shipA)?.isActive !== true && Date.now() < deadline) await harness.advance(50);
    let countA = 0;
    for (const [, s] of state.ships) if (s.playerId === pidA) countA++;
    expect(countA, 'no second ship for A').toBe(1);
    expect(state.ships.get(shipA)?.isActive).toBe(true);

    await harness.disconnectClient(a2);
    await harness.disconnectClient(b);
  }, 30_000);
});
