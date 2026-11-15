/**
 * RTS Part B slice 6 — Hunt and the Aggressive / Defensive attitudes reach
 * the AI pilot brain that flies an owned hull (`modeSet` / `stanceSet` hooks
 * → `applyHullMode` / `applyHullStance`), and an Aggressive ship engages what
 * is hostile to its OWNER (`view.hostileToPlayer` → the room's `npcHostileTo`).
 * The brain rules themselves are locked in `HostileDroneBehaviour.hunt.test.ts`.
 *
 * Failing first: before this slice a hull engaged an owner-hostile drone only
 * once that drone had hit it (retaliation), Hunt kept the guard leash, and the
 * stance never reached the brain.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — Hunt and attitudes for owned ships (RTS Part B slice 6)', () => {
  let harness: SectorTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function park(): Promise<{ pid: string; sid: string; client: Awaited<ReturnType<SectorTestHarness['connectActive']>>; room: SectorRoom; brain: HostileDroneBehaviour }> {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    expect(sid).not.toBe('');
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const brain = room._internals.aiBrainOf(sid) as HostileDroneBehaviour;
    expect(brain).not.toBeNull();
    return { pid, sid, client, room, brain };
  }

  it('Aggressive + Hunt: the hull goes for a drone hostile to its owner before that drone has hit it', async () => {
    const { pid, sid, client, room, brain } = await park();
    const state = room.state as SectorState;
    client.send('set_stance', { type: 'set_stance', shipIds: [sid], stance: 'aggressive' });
    client.send('set_mode', { type: 'set_mode', shipIds: [sid], mode: 'hunt' });
    await harness!.advance(200);
    expect(brain.isHunting(), 'Hunt reached the AI pilot brain').toBe(true);
    expect(brain.getGuardRadius(), 'Hunt lifts the guard leash').toBe(0);

    const ship = state.ships.get(sid)!;
    const hp0 = ship.health;
    const sh0 = ship.shield;
    expect(room._internals.spawnTestDrone('foe', 0, 900, 'fighter')).toBe(true);
    client.send('test_aggro', { type: 'test_aggro' });
    let picked = false;
    for (let i = 0; i < 40 && !picked; i++) {
      await harness!.advance(25);
      picked = brain.getTargetId() === 'foe';
    }
    expect(room._internals.npcHostileTo('foe', pid), 'precondition: hostile to the owner').toBe(true);
    expect(picked, 'the hull never picked the owner-hostile drone').toBe(true);
    expect(ship.health === hp0 && ship.shield === sh0, 'it only answered after being hit (retaliation, not attitude)').toBe(true);
    await harness!.disconnectClient(client);
  }, 30_000);

  it('Defensive (the default) holds back from an owner-hostile drone; Aggressive engages it', async () => {
    const { sid, client, room, brain } = await park();
    const ship = (room.state as SectorState).ships.get(sid)!;
    const hp0 = ship.health;
    const sh0 = ship.shield;
    const hit = (): boolean => ship.health < hp0 || ship.shield < sh0;
    expect(room._internals.spawnTestDrone('foe', 0, 900, 'fighter')).toBe(true);
    client.send('test_aggro', { type: 'test_aggro' });
    await harness!.advance(300);
    expect(room._internals.fleet.ordersOf(sid)!.stance).toBe('defensive');
    // The default guard radius is the fighter's; put the drone inside it so
    // only the attitude decides.
    const r = brain.getGuardRadius();
    expect(r).toBeGreaterThan(900);
    expect(hit(), 'precondition: not hit yet').toBe(false);
    expect(brain.getTargetId(), 'Defensive started a fight').toBeNull();
    client.send('set_stance', { type: 'set_stance', shipIds: [sid], stance: 'aggressive' });
    let picked = false;
    for (let i = 0; i < 40 && !picked; i++) {
      await harness!.advance(25);
      picked = brain.getTargetId() === 'foe';
    }
    expect(picked, 'Aggressive did not engage the owner-hostile drone').toBe(true);
    expect(hit(), 'it only answered after being hit (retaliation, not attitude)').toBe(false);
    await harness!.disconnectClient(client);
  }, 30_000);
});
