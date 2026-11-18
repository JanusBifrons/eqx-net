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
import { rocksInChunk, type ChunkOpts } from '../../../src/core/terrain/fieldLayout.js';
import { fieldRockBody } from '../../../src/core/terrain/chunkStreamer.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { RoutePlanner } from '../../../src/core/nav/routePlanner.js';
import { CoarseFieldMap } from '../../../src/core/nav/coarseField.js';
import { FineFieldLayer } from '../../../src/core/nav/fineField.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; }, 10_000);

const fighter = getShipKind('fighter');
const opts: ChunkOpts = { seed: 'look', battleshipLength: getShipKind('battleship').radius * 2, fighterLength: fighter.radius * 2 };

/** Two open spots either side of a big rock in a sparse chunk (the straight
 *  line between them blocked, a full fighter route round it: a `nearest`
 *  route, slice 9, ends short and the ship waits there). */
function crossing(): { ax: number; ay: number; bx: number; by: number } {
  const coarse = new CoarseFieldMap(); coarse.build(opts);
  const fine = new FineFieldLayer(opts);
  const p = new RoutePlanner(), c = shipTuning(fighter).navClearance, room = 6 * fighter.radius;
  const cx = 20, cy = 10, out = new Float64Array(128);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) fine.chunkLoaded(cx + dx, cy + dy);
  p.plan(coarse, fine, 0, 0, 0, 0, 0, out); // seed the planner's layers
  for (const r of rocksInChunk(opts, cx, cy).map(fieldRockBody).sort((a, b) => b.radius - a.radius)) {
    if (r.radius < 6 * fighter.radius) continue;
    for (let d = r.radius + 300; d < r.radius + 1500; d += 100) {
      const ax = r.x - d, bx = r.x + d;
      if (p.roomAt(ax, r.y) >= room && p.roomAt(bx, r.y) >= room && !p.segmentClear(ax, r.y, bx, r.y, c) &&
        p.plan(coarse, fine, ax, r.y, bx, r.y, c, out) > 1 && p.status === 'route') return { ax, ay: r.y, bx, by: r.y };
    }
  }
  throw new Error('no crossing');
}

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
