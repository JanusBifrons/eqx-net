/**
 * RTS command layer, slices 6b + 7 — fleet commands over the wire and the
 * owner-only `fleet_status` stream.
 *
 * Flow: client A spectates (its hull parks as a wingman), then sends a real
 * `fleet_order` move message: the hull flies there. Client B's order for A's
 * hull is ignored (owner-checked per id). `set_mode` patrol with a route shows
 * up in the status as patrol. A malformed payload is recorded, not thrown.
 * The status stream reaches A with its ship and tells B nothing about it.
 *
 * Failing-first: before slice 6b there were no `fleet_order` / `set_mode`
 * handlers, so the hull never moved and the mode stayed defend.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import {
  FleetStatusMessageSchema,
  decodeFleetStatusRow,
  type FleetStatusRowWire,
} from '../../../src/shared-types/messages/fleetStatusMessages.js';

describe('SectorRoom integration — fleet command messages + fleet_status (RTS 6b/7)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('owner orders move the parked hull; others are ignored; status is owner-only', async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();
    const a = await harness.connectActive(pidA, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const b = await harness.connectActive(pidB, { shipKind: 'fighter', spawnX: 3000, spawnY: 3000 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;

    let shipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pidA && s.isActive) { shipId = s.shipInstanceId; break; }
    }
    expect(shipId).not.toBe('');

    let last: { x: number; y: number } | null = null;
    a.onMessage('snapshot', (snap: unknown) => {
      const e = (snap as SnapshotMessage).states[shipId];
      if (e) last = { x: e.x, y: e.y };
    });
    const statusA: FleetStatusRowWire[][] = [];
    const statusB: FleetStatusRowWire[][] = [];
    const collect = (out: FleetStatusRowWire[][]) => (raw: unknown) => {
      const p = FleetStatusMessageSchema.safeParse(raw);
      expect(p.success, 'fleet_status passes its schema').toBe(true);
      if (p.success) out.push(p.data.s.map(decodeFleetStatusRow));
    };
    a.onMessage('fleet_status', collect(statusA));
    b.onMessage('fleet_status', collect(statusB));

    // `command` is an alias of `spectate`: it parks the hull as a wingman.
    a.send('command', { type: 'command' });
    await harness.advance(300);
    expect(internals.lingeringSlots.has(shipId), 'command parks the hull').toBe(true);
    expect(internals.fleet.isAttached(shipId)).toBe(true);

    // B tries to move A's hull: ignored.
    b.send('fleet_order', { type: 'fleet_order', shipIds: [shipId], kind: 'move', x: -900, y: 0 });
    await harness.advance(100);
    expect(internals.fleet.brainOf(shipId)!.order, 'a foreign order is dropped').toBeNull();

    // A orders its hull 800 u east (and lists its own playerId, the "active
    // ship" id a selection may carry: silently dropped, it is not attached).
    a.send('fleet_order', { type: 'fleet_order', shipIds: [pidA, shipId], kind: 'move', x: 800, y: 0 });
    await harness.advance(100);
    const order = internals.fleet.brainOf(shipId)!.order;
    expect(order?.kind, 'the owner order is accepted').toBe('move');

    // Status: A gets its hull with the move destination; B gets an empty list.
    internals.sendFleetStatus();
    await harness.advance(100);
    const lastA = statusA.at(-1)!;
    expect(lastA.map((r) => r.id)).toEqual([shipId]);
    expect(lastA[0]!.orderKind).toBe('move');
    expect(lastA[0]!.orderX).toBe(800);
    expect(lastA[0]!.orderY).toBe(0);
    expect(lastA[0]!.hullPct).toBeGreaterThan(0);
    for (const rows of statusB) expect(rows.find((r) => r.id === shipId), 'B never hears about A’s hull').toBeUndefined();
    // B parks its own hull too: B's stream lists exactly that hull, never A's.
    let shipB = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pidB && s.isActive) { shipB = s.shipInstanceId; break; }
    }
    b.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    internals.sendFleetStatus();
    await harness.advance(100);
    expect(statusB.at(-1)!.map((r) => r.id), 'B gets only its own hull').toEqual([shipB]);
    expect(statusA.at(-1)!.map((r) => r.id), 'A still gets only its own hull').toEqual([shipId]);
    for (const rows of statusB) expect(rows.find((r) => r.id === shipId)).toBeUndefined();

    // The hull flies there.
    let arrived = false;
    for (let i = 0; i < 80 && !arrived; i++) {
      await harness.advance(250);
      arrived = internals.fleet.brainOf(shipId)!.order === null;
    }
    expect(arrived, 'the move order completes').toBe(true);
    const at = last as { x: number; y: number } | null;
    expect(at).not.toBeNull();
    expect(Math.hypot(at!.x - 800, at!.y), 'the hull moved to the ordered point').toBeLessThan(200);

    // Patrol with a route.
    a.send('set_mode', { type: 'set_mode', shipIds: [shipId], mode: 'patrol', route: [[800, 0], [800, 600], [200, 600]] });
    await harness.advance(100);
    expect(internals.fleet.statusFor(pidA)[0]?.mode).toBe('patrol');
    internals.sendFleetStatus();
    await harness.advance(100);
    const patrolRow = statusA.at(-1)![0]!;
    expect(patrolRow.mode).toBe('patrol');
    expect(patrolRow.route).toEqual([[800, 0], [800, 600], [200, 600]]);

    // Stance + squad round-trip through the handlers.
    a.send('set_stance', { type: 'set_stance', shipIds: [shipId], stance: 'holdFire' });
    await harness.advance(100);
    expect(internals.fleet.statusFor(pidA)[0]?.stance).toBe('holdFire');

    // Malformed: recorded, not thrown; the room keeps running.
    const malformed = (room as unknown as { malformed: { countFor(s: string): number } }).malformed;
    const before = malformed.countFor(a.sessionId);
    a.send('fleet_order', { type: 'fleet_order', shipIds: [shipId], kind: 'move' }); // move without x/y
    a.send('set_mode', { type: 'set_mode', shipIds: [], mode: 'patrol' });
    await harness.advance(100);
    expect(malformed.countFor(a.sessionId)).toBe(before + 2);
    expect(internals.fleet.statusFor(pidA)[0]?.mode, 'the malformed set_mode changed nothing').toBe('patrol');

    await harness.disconnectClient(a);
    await harness.disconnectClient(b);
  }, 60_000);
});
