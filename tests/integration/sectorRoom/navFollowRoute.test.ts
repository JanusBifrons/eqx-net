/**
 * Navigation slice 7: an AI-flown ship told to Move across rock flies the nav
 * route round it (`tickMoveTo` asks `view.nav` for the next waypoint) and
 * touches no rock. Baseline in the same room with the routes turned off: the
 * straight line runs into the rock (contacts > 0), so the fixture is real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { crossing } from './navCrossing.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; }, 10_000);

const fighter = getShipKind('fighter');
async function flyAcross(nav: boolean): Promise<{ contacts: number; miss: number }> {
  const at = crossing();
  harness = await bootSectorTestServer({ sectorKey: null, testMode: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0 });
  const pid = randomUUID();
  const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: Math.round(at.ax), spawnY: Math.round(at.ay) });
  const room = harness.getServerRoom()! as unknown as SectorRoom;
  const int = room._internals;
  let sid = '';
  for (const [, s] of (room.state as SectorState).ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
  client.send('spectate', { type: 'spectate' });
  await harness.advance(1_500); // chunks round the hull load; the nav worker builds both layers
  if (!nav) int.aiNav.set(undefined);
  else expect(int.aiNav.get(), 'a cut-field room hands brains its routes').toBeDefined();
  const before = int.cutFieldSub!.rockContacts;
  client.send('fleet_order', { type: 'fleet_order', shipIds: [sid], kind: 'move', x: Math.round(at.bx), y: Math.round(at.by) });
  // The harness's physics world stops stepping ~10 s after boot (tick 631, with or without
  // routes; logged in the nav handoff), so the flight fits in 8 s.
  for (let i = 0; i < 32; i++) {
    await harness.advance(250);
  }
  const p = int.lingeringPoseCache.get(sid)!;
  return { contacts: int.cutFieldSub!.rockContacts - before, miss: Math.hypot(p.x - at.bx, p.y - at.by) };
}

describe('SectorRoom integration — AI follows nav routes round rock (navigation slice 7)', () => {
  it('with routes: arrives and touches no rock', async () => {
    const r = await flyAcross(true);
    console.log(`[nav follow] routed: rock contacts ${r.contacts}, ends ${r.miss.toFixed(0)} u from the goal`);
    expect(r.contacts).toBe(0);
    expect(r.miss).toBeLessThan(shipTuning(fighter).wingmanArrive * 3);
  }, 90_000);

  it('baseline without routes: the straight line hits the rock', async () => {
    const r = await flyAcross(false);
    console.log(`[nav follow] straight: rock contacts ${r.contacts}, ends ${r.miss.toFixed(0)} u from the goal`);
    expect(r.contacts).toBeGreaterThan(0);
  }, 90_000);
});
