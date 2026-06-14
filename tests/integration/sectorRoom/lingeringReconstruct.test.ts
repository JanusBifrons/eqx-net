/**
 * Phase 5 (persistence v5) — lingering hulls persist across a server restart.
 *
 * "remove the lingering hull being removed from the sector EVER. No timeout any
 * more, it lingers FOREVER where you left it." On boot, `SectorRoom` reconstructs
 * each persisted lingering hull in-world (a real `isActive=false` ship + slot +
 * `linger-<id>` worker body + lingering bookkeeping), so a disconnected /
 * displaced ship reappears where it was left, visible to others and reclaimable
 * — until the owner abandons it (→ wreck). This exercises the reconstruction
 * against a REAL room (the unit round-trip in
 * SectorPersistence.structures.test.ts covers the persist↔hydrate wiring).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';

const PID_A = randomUUID();
const PID_B = randomUUID();
const PID_C = randomUUID();

const SECTOR = 'sol-prime';

describe('SectorRoom integration — lingering-hull reconstruction on boot (v5)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: SECTOR, droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('reconstructs a persisted lingering hull in-world (isActive=false, in lingeringSlots)', async () => {
    // A real room + physics worker (getServerRoom materialises once a client joins).
    await harness.connectActive(PID_A, { shipKind: 'fighter' });
    await harness.advance(150);
    const room = harness.getServerRoom() as unknown as SectorRoom;
    expect(room).toBeTruthy();

    // A persisted roster row for a disconnected player's ship in this sector —
    // the reconstruction gate requires the roster row to exist (else it's been
    // abandoned and the wreck flow owns it).
    const rec = getPlayerShipStore().create({
      playerId: PID_B,
      userId: null,
      kind: 'fighter',
      sectorKey: SECTOR,
      x: 111,
      y: 222,
      health: 400,
    });

    room._internals.restoreLingeringHulls([
      {
        shipInstanceId: rec.shipId,
        playerId: PID_B,
        kind: 'fighter',
        x: 111,
        y: 222,
        vx: 1,
        vy: 2,
        angle: 0.3,
        angvel: 0.01,
        health: 400,
        shieldDown: false,
      },
    ]);

    const ship = room.state.ships.get(rec.shipId);
    expect(ship).toBeDefined();
    expect(ship!.isActive).toBe(false); // a LINGERING hull, not an active one
    expect(ship!.alive).toBe(true);
    expect(ship!.playerId).toBe(PID_B);
    expect(ship!.health).toBe(400);
    expect(ship!.shield).toBeGreaterThan(0); // shieldDown:false → shield restored
    expect(room._internals.lingeringSlots.has(rec.shipId)).toBe(true);
  }, 20_000);

  it('does NOT reconstruct a hull whose roster row is gone (abandoned → wreck owns it)', async () => {
    await harness.connectActive(PID_A, { shipKind: 'fighter' });
    await harness.advance(150);
    const room = harness.getServerRoom() as unknown as SectorRoom;

    // No roster row for this shipInstanceId → it was abandoned before shutdown.
    room._internals.restoreLingeringHulls([
      {
        shipInstanceId: `gone-${PID_C}`,
        playerId: PID_C,
        kind: 'fighter',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        angle: 0,
        angvel: 0,
        health: 400,
        shieldDown: false,
      },
    ]);

    expect(room.state.ships.has(`gone-${PID_C}`)).toBe(false);
    expect(room._internals.lingeringSlots.has(`gone-${PID_C}`)).toBe(false);
  }, 20_000);
});
