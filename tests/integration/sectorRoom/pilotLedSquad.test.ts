/**
 * RTS command layer, slice 4b — pilot-led squads in a real room.
 *
 * The fleet names ships by shipInstanceId; `pilotShipOf` must too, or a squad
 * member the owner flies is never recognised as the squad's leader.
 *
 * Flow: park three fighters (two displaced by fresh spawns, the third by
 * Spectate), form them into a squad, then `pilot_ship` one of them. The other
 * two form up on the piloted ship as it flies. Spectate again: the ship the
 * owner flew stays in the squad and leads it as AI.
 *
 * RTS Part B slice 10: the members' AI pilots fly as a loose pack on the
 * leader (`setFlockFollow`), so "forms on A" reads the AI pilot brain's flock
 * leader instead of the old wingman brain's formation slot; the distance
 * check is unchanged (same spacing, same on-station radius).
 *
 * Failing-first: before 4b `pilotShipOf` returned the playerId (never a squad
 * member's id) and reclaim detached the hull out of its squad, so the squad
 * dissolved below two members and nobody formed up on the pilot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import {
  FleetStatusMessageSchema,
  decodeFleetStatusRow,
  type FleetStatusRowWire,
} from '../../../src/shared-types/messages/fleetStatusMessages.js';

interface Pose { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }

describe('SectorRoom integration — pilot-led squads (RTS slice 4b)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('members form up on the ship the owner pilots; on release it leads the squad as AI', async () => {
    const pid = randomUUID();
    let client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;
    const fleet = internals.fleet;
    const activeOf = (): string => {
      for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };

    // Three hulls: A and B displaced by fresh spawns, C parked by Spectate.
    const A = activeOf();
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    client = await harness.connectActive(pid, { isNewShip: true, shipKind: 'fighter', spawnX: 3500, spawnY: 0 });
    const B = activeOf();
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    client = await harness.connectActive(pid, { isNewShip: true, shipKind: 'fighter', spawnX: -3500, spawnY: 0 });
    const C = activeOf();
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(new Set([A, B, C]).size).toBe(3);
    for (const id of [A, B, C]) expect(fleet.isAttached(id), `${id} is AI-flown`).toBe(true);

    expect(fleet.formSquad(pid, [A, B, C])).not.toBeNull();
    const sqId = fleet.squadOf(A)!.id;

    // The owner takes A's helm.
    client.send('pilot_ship', { type: 'pilot_ship', shipId: A });
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);
    expect(state.ships.get(A)?.isActive, 'the owner flies A').toBe(true);
    expect(fleet.isAttached(A)).toBe(false);
    expect(fleet.squadOf(A)?.id, 'A stays in its squad while piloted').toBe(sqId);
    expect(fleet.squad(sqId)!.leaderId, 'the piloted ship leads').toBe(A);
    for (const id of [B, C]) {
      expect(fleet.squadFollowOf(id), `${id} follows A`).toBe(A);
      expect(internals.aiBrainOf(id)?.getFlockLeaderId?.(), `${id}'s AI pilot packs on A`).toBe(A);
    }

    // Fly A north for a while; B and C (3500 u away) close on their slots round it.
    const r = room as unknown as {
      entityPoseInto: (id: string, out: Pose) => boolean;
    };
    const pose: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    const at = (id: string): { x: number; y: number } => {
      expect(r.entityPoseInto(id, pose)).toBe(true);
      return { x: pose.x, y: pose.y };
    };
    const startA = at(A);
    const startGap = Math.max(
      Math.hypot(at(B).x - startA.x, at(B).y - startA.y),
      Math.hypot(at(C).x - startA.x, at(C).y - startA.y),
    );
    for (let i = 0; i < 40; i++) {
      harness.sendThrust(client);
      await harness.advance(50);
    }
    // Release the throttle (the worker holds the last input): A coasts on.
    client.send('input', { type: 'input', tick: 0, thrust: false, turnLeft: false, turnRight: false });
    const spacing = fleet.brainOf(B)!.stationSpacing;
    expect(startGap, 'members start far from their slots').toBeGreaterThan(spacing * 4);
    // On station a wedge slot-1/2 member sits rank·spacing·√2 from the leader.
    const onStation = spacing * Math.SQRT2 + spacing * 0.5;
    let gap = Infinity;
    for (let i = 0; i < 100 && gap > onStation; i++) {
      await harness.advance(250);
      const a = at(A);
      gap = Math.max(Math.hypot(at(B).x - a.x, at(B).y - a.y), Math.hypot(at(C).x - a.x, at(C).y - a.y));
    }
    const endA = at(A);
    expect(Math.hypot(endA.x - startA.x, endA.y - startA.y), 'A moved under its pilot').toBeGreaterThan(50);
    expect(gap, `members on station within ${onStation.toFixed(0)} u of A (were ${startGap.toFixed(0)} u)`)
      .toBeLessThanOrEqual(onStation);

    // Release: Spectate parks A; it rejoins as the squad's AI leader.
    client.send('spectate', { type: 'spectate' });
    await harness.advance(500);
    expect(fleet.isAttached(A), 'A is AI-flown again').toBe(true);
    expect(fleet.squadOf(A)?.id).toBe(sqId);
    expect(fleet.squad(sqId)!.leaderId).toBe(A);
    expect(fleet.squadFollowOf(A), 'the AI leader follows nobody').toBeNull();
    expect(internals.aiBrainOf(A)?.getFlockLeaderId?.()).toBeNull();
    for (const id of [B, C]) expect(internals.aiBrainOf(id)?.getFlockLeaderId?.()).toBe(A);

    await harness.disconnectClient(client);
  }, 90_000);

  it('escorting the ship the owner flies: the client\'s playerId maps to its shipInstanceId', async () => {
    const pid = randomUUID();
    let client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const fleet = room._internals.fleet;
    const activeOf = (): string => {
      for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };
    const parked = activeOf();
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    client = await harness.connectActive(pid, { isNewShip: true, shipKind: 'fighter', spawnX: 800, spawnY: 0 });
    const flown = activeOf();
    expect(fleet.isAttached(parked)).toBe(true);

    const status: FleetStatusRowWire[][] = [];
    client.onMessage('fleet_status', (raw: unknown) => {
      const p = FleetStatusMessageSchema.safeParse(raw);
      if (p.success) status.push(p.data.s.map(decodeFleetStatusRow));
    });

    // The client names its own active ship by playerId (its fleet selection).
    client.send('set_mode', { type: 'set_mode', shipIds: [parked], mode: 'escort', escortId: pid });
    await harness.advance(300);
    const brain = fleet.brainOf(parked)!;
    expect(brain.mode).toBe('escort');
    expect(brain.escortId, 'escorts the flown ship by its shipInstanceId').toBe(flown);
    // The status stream hands it back under the id the client knows.
    status.length = 0;
    room._internals.sendFleetStatus();
    await harness.advance(200);
    const row = status.at(-1)?.find((s) => s.id === parked);
    expect(row?.escortId, 'status names the flown ship by playerId').toBe(pid);

    await harness.disconnectClient(client);
  }, 60_000);
});
