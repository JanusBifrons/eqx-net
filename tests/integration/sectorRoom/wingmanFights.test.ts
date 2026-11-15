/**
 * RTS command layer, slice 5 — wingmen fight.
 *
 * A parked (lingering) hull flown by its wingman brain locks and fires through
 * the PLAYER weapon pipeline (`wingmanLocks` → `WeaponMountTicker.tickHull` →
 * `PlayerFireResolver.fireHull`), gated by its stance:
 *   - aggressive + hunt: damages a drone hostile to its owner;
 *   - a neutral drone is left alone (hostility is the owner's, never invented);
 *   - holdFire never fires;
 *   - a wingman's hit makes the drone hostile to the OWNER (the per-player
 *     hostility ledger), not to the hull's shipInstanceId;
 *   - defensive: fires back at whatever just hit it.
 *
 * Failing-first: before slice 5 nothing ever fired from a lingering hull, so
 * every "damages" assertion stayed at full health, and a hit attributed to the
 * hull marked the drone hostile to its shipInstanceId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { mountWeaponReach } from '../../../src/core/combat/mountReach.js';

type Internals = SectorRoom['_internals'];

describe('SectorRoom integration — wingmen fight (RTS slice 5)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  /** Join as a fighter at the origin (nose +y), park it, return its ids. */
  async function parkFighter(): Promise<{ pid: string; sid: string; client: Awaited<ReturnType<SectorTestHarness['connectActive']>>; internals: Internals }> {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    expect(sid).not.toBe('');
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const internals = room._internals;
    expect(internals.fleet.isAttached(sid), 'the parked hull has a wingman').toBe(true);
    return { pid, sid, client, internals };
  }

  /** A point straight ahead of the parked fighter, inside its guns' reach. */
  function aheadInReach(): { x: number; y: number } {
    const kind = getShipKind('fighter');
    let reach = 0;
    for (const m of kind.mounts ?? []) reach = Math.max(reach, mountWeaponReach(m));
    return { x: 0, y: Math.max(80, reach * 0.5) };
  }

  /** Health lost by the drone so far (a killed drone counts as all of it). */
  function lost(internals: Internals, id: string, start: number): number {
    const h = internals.swarmHealth.get(id);
    return h === undefined ? start : start - h;
  }

  // RTS Part B slice 6: hunt + attitude: engage what is hostile to the OWNER; until then a drone is only an enemy by retaliation.
  it('aggressive + hunt: the wingman damages a drone hostile to its owner', async () => {
    const { pid, sid, client, internals } = await parkFighter();
    const p = aheadInReach();
    expect(internals.spawnTestDrone('foe', p.x, p.y, 'fighter')).toBe(true);
    const start = internals.swarmHealth.get('foe')!;
    client.send('test_aggro', { type: 'test_aggro' });
    await harness.advance(100);
    expect(internals.npcHostileTo('foe', pid), 'precondition: the drone is hostile to the owner').toBe(true);

    expect(internals.fleet.setStance(pid, [sid], 'aggressive')).toEqual([sid]);
    expect(internals.fleet.setMode(pid, [sid], 'hunt')).toEqual([sid]);

    let dmg = 0;
    for (let i = 0; i < 40 && dmg <= 0; i++) {
      await harness.advance(250);
      dmg = lost(internals, 'foe', start);
    }
    expect(dmg, 'the wingman damaged the hostile drone').toBeGreaterThan(0);
    await harness.disconnectClient(client);
  }, 60_000);

  it('a neutral drone is ignored, and holdFire never fires even at a hostile one', async () => {
    const { pid, sid, client, internals } = await parkFighter();
    const p = aheadInReach();
    expect(internals.spawnTestDrone('neutral', p.x, p.y, 'fighter')).toBe(true);
    const start = internals.swarmHealth.get('neutral')!;
    internals.fleet.setStance(pid, [sid], 'aggressive');
    internals.fleet.setMode(pid, [sid], 'hunt');
    await harness.advance(3000);
    expect(internals.npcHostileTo('neutral', pid), 'still neutral').toBe(false);
    expect(lost(internals, 'neutral', start), 'a neutral drone is never shot').toBe(0);

    // Now it is hostile, but the wingman holds fire.
    internals.fleet.setStance(pid, [sid], 'holdFire');
    client.send('test_aggro', { type: 'test_aggro' });
    await harness.advance(3000);
    expect(internals.npcHostileTo('neutral', pid)).toBe(true);
    expect(lost(internals, 'neutral', start), 'holdFire never fires').toBe(0);
    await harness.disconnectClient(client);
  }, 60_000);

  it("a wingman's hit makes the drone hostile to the OWNER, not to the hull id", async () => {
    const { pid, sid, client, internals } = await parkFighter();
    expect(internals.spawnTestDrone('victim', 3000, 3000, 'fighter')).toBe(true);
    expect(internals.npcHostileTo('victim', pid)).toBe(false);
    internals.applyDamage('victim', sid, 1);
    expect(internals.npcHostileTo('victim', pid), 'hostile to the owner').toBe(true);
    expect(internals.npcHostileTo('victim', sid), 'never to the hull id').toBe(false);
    await harness.disconnectClient(client);
  }, 30_000);

  // RTS Part B slice 4: retaliation is the shared AI's: damage → `aiController.markHostile(hull, shooter)`.
  it('defensive: the wingman fires back at a neutral drone that hit it', async () => {
    const { pid, sid, client, internals } = await parkFighter();
    const p = aheadInReach();
    expect(internals.spawnTestDrone('pest', p.x, p.y, 'fighter')).toBe(true);
    const start = internals.swarmHealth.get('pest')!;
    // Default stance is Defensive; the drone is neutral and outside the
    // guard radius test only matters for hostiles, so nothing fires yet.
    expect(internals.fleet.brainOf(sid)!.stance).toBe('defensive');
    await harness.advance(1500);
    expect(lost(internals, 'pest', start), 'defensive does not start a fight').toBe(0);

    // The drone hits the hull: the wingman returns fire.
    internals.applyDamage(sid, 'pest', 1);
    let dmg = 0;
    for (let i = 0; i < 40 && dmg <= 0; i++) {
      await harness.advance(250);
      dmg = lost(internals, 'pest', start);
    }
    expect(dmg, 'the wingman returned fire').toBeGreaterThan(0);
    expect(internals.npcHostileTo('pest', pid), 'and the drone is now hostile to the owner').toBe(true);
    await harness.disconnectClient(client);
  }, 60_000);
});
