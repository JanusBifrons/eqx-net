/**
 * RTS command layer (slice 10) — default join = COMMAND view (owner decision
 * 2026-11-14: "free camera over your fleet; your ship(s) AI-flown").
 *
 * A join with `startMode: 'command'` spawns through the normal handshake, then
 * at the arrival flip the server parks the hull through the same path as the
 * `command` message (`enterSpectate`): no active hull, the own hull lingering
 * and AI-flown (a wingman brain attached), and the client is told
 * (`control_mode`). `startMode: 'fly'` (and absent) keeps the pilot join.
 *
 * Fail-first: before slice 10 the option was ignored, so the hull stayed active
 * and no `control_mode` arrived.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

function shipsOf(state: SectorState, pid: string): { active: number; inactiveIds: string[] } {
  let active = 0;
  const inactiveIds: string[] = [];
  for (const [, s] of state.ships) {
    if (s.playerId !== pid) continue;
    if (s.isActive) active++;
    else inactiveIds.push(s.shipInstanceId);
  }
  return { active, inactiveIds };
}

describe('SectorRoom integration — RTS slice 10 command-view default join', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'galaxy-test', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it("startMode 'command' lands with no active ship; the own hull lingers, AI-flown", async () => {
    const pid = randomUUID();
    const room = await harness.connectAs(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command' });
    let controlMode: unknown = null;
    room.onMessage('control_mode', (msg: unknown) => { controlMode = msg; });
    room.send('client_ready', { type: 'client_ready' });

    await harness.events.waitFor({ tag: 'command_start', where: (d) => d['playerId'] === pid }, 5_000);
    await harness.advance(200);

    const server = harness.getServerRoom()!;
    const state = server.state as SectorState;
    const internals = server._internals;
    const { active, inactiveIds } = shipsOf(state, pid);
    expect(active, 'no active hull in command view').toBe(0);
    expect(inactiveIds.length, 'exactly one own hull, parked').toBe(1);
    const hullId = inactiveIds[0]!;
    expect(internals.lingeringSlots.has(hullId), 'the hull is a lingering slot').toBe(true);
    expect(internals.fleet.isAttached(hullId), 'the parked hull is AI-flown (wingman attached)').toBe(true);
    expect(state.ships.get(hullId)!.alive).toBe(true);
    expect(controlMode).toEqual({ type: 'control_mode', mode: 'command' });

    await harness.disconnectClient(room);
  }, 30_000);

  it("startMode 'fly' keeps the pilot join: an active hull, no command message", async () => {
    const pid = randomUUID();
    let controlMode: unknown = null;
    const room = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'fly' });
    room.onMessage('control_mode', (msg: unknown) => { controlMode = msg; });
    await harness.advance(300);

    const server = harness.getServerRoom()!;
    const state = server.state as SectorState;
    const { active } = shipsOf(state, pid);
    expect(active, 'the pilot is at the controls').toBe(1);
    expect(server._internals.lingeringSlots.size).toBe(0);
    expect(controlMode).toBeNull();

    await harness.disconnectClient(room);
  }, 30_000);

  it('no startMode keeps the pilot join (server default = fly; transit arrivals keep flying)', async () => {
    const pid = randomUUID();
    const room = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    await harness.advance(300);
    const state = harness.getServerRoom()!.state as SectorState;
    expect(shipsOf(state, pid).active).toBe(1);
    await harness.disconnectClient(room);
  }, 30_000);
});
