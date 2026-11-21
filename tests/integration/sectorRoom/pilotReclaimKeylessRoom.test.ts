/**
 * Build mode / Command toggle (stills review of #1035, 2026-11-20): a room
 * with no sector key (engineering / test rooms, `?room=sector`) let the pilot
 * hand their ship to its AI pilot (`command`) but silently dropped the
 * `pilot_ship` that takes it back, so the player was stuck in Command.
 * The same ownership checks apply; only the roster (which keyless rooms do not
 * keep) is skipped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration: pilot swap in a room with no sector key', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a pilot reclaims their ship in a room with no sector key', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;
    let shipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { shipId = s.shipInstanceId; break; }
    }
    expect(shipId).not.toBe('');

    // Command: the ship is handed to its AI pilot (parked as a lingering hull).
    client.send('command', { type: 'command' });
    await harness.advance(200);
    expect(internals.lingeringSlots.has(shipId)).toBe(true);
    expect(state.ships.get(shipId)!.isActive).toBe(false);

    // Fly: take the same ship back.
    client.send('pilot_ship', { type: 'pilot_ship', shipId });
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);

    const ship = state.ships.get(shipId);
    expect(ship!.isActive, 'the ship is flown again').toBe(true);
    expect(ship!.playerId).toBe(pid);
    expect(internals.lingeringSlots.has(shipId)).toBe(false);
    expect(internals.ownerlessShips.has(shipId)).toBe(false);

    await harness.disconnectClient(client);
  }, 30_000);

  it('a keyless room still refuses another pilot\'s ship', async () => {
    const owner = randomUUID();
    const thief = randomUUID();
    const ownerClient = await harness.connectActive(owner, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const thiefClient = await harness.connectActive(thief, { shipKind: 'fighter', spawnX: 500, spawnY: 500 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === owner && s.isActive) { shipId = s.shipInstanceId; break; }
    }
    ownerClient.send('command', { type: 'command' });
    await harness.advance(200);
    expect(room._internals.lingeringSlots.has(shipId)).toBe(true);

    thiefClient.send('pilot_ship', { type: 'pilot_ship', shipId });
    thiefClient.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);

    expect(state.ships.get(shipId)!.isActive).toBe(false);
    expect(state.ships.get(shipId)!.playerId).toBe(owner);
    expect(room._internals.lingeringSlots.has(shipId)).toBe(true);

    await harness.disconnectClient(thiefClient);
    await harness.disconnectClient(ownerClient);
  }, 30_000);
});
