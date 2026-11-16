/**
 * Macro terrain v2 C2 (ramming, behind the `cutField` room option). Field
 * rocks are mountains (`fieldRockMass`): a rock wakes only to a body at least
 * as heavy as itself (`fieldRockWakes`). A battleship driven into a lane wall
 * wakes none of the rocks heavier than it; a heavy rock driven into the pile
 * wakes the lighter rocks it hits (chain wake), never a heavier one. Same
 * pose as the `cut-field-ram` showcase shot, closer in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { fieldRockId, fieldRockMass } from '../../../src/core/terrain/chunkStreamer.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipBodyMass } from '../../../src/shared-types/shipScale/tuning.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

// A lane wall in the `look` field (showcase/shots/cutField.ts) and the
// heading straight into it.
const WALL = { x: -30_002, y: 27_191 };
const HEAD = { x: (-30_120 - WALL.x) / 700, y: (26_501 - WALL.y) / 700 };
const BACK = 2_400;
/** A heavy rock in that wall (r 972, ~11 battleship masses) and the
 *  direction to a lighter neighbour (r 508) it is driven into. */
const HEAVY = { key: 2022047748, x: -29947, y: 24987 };
const TOWARD = { x: 1, y: 0 };

function awakeFieldRocks(int: SectorRoom['_internals']): { id: string; radius: number }[] {
  const out: { id: string; radius: number }[] = [];
  for (const r of int.swarmRegistry.all()) if (r.fieldRock === true && r.fieldAwake === true) out.push({ id: r.id, radius: r.radius });
  return out;
}

describe('SectorRoom integration — cut-field ramming', () => {
  it('a ramming battleship wakes no rock heavier than itself', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, testMode: true, pilotCapitals: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0 });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, {
      shipKind: 'battleship', initialHull: 1_000_000, initialAngle: 2.972,
      spawnX: Math.round(WALL.x - HEAD.x * BACK), spawnY: Math.round(WALL.y - HEAD.y * BACK),
    });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const start = { ...int.playerPose(pid)! };
    const thrust = setInterval(() => {
      client.send('input', { type: 'input', tick: 0, thrust: true, turnLeft: false, turnRight: false, boost: true });
    }, 50);
    try {
      for (let i = 0; i < 60; i++) await harness.advance(250);
    } finally {
      clearInterval(thrust);
    }
    const ship = int.playerPose(pid)!;
    // It drove into the wall under full thrust (before the mass rule this
    // ram woke field:2005270529, a rock of r 5 722).
    expect(Math.hypot(ship.x - start.x, ship.y - start.y), 'it drove in').toBeGreaterThan(100);
    const bsMass = shipBodyMass(getShipKind('battleship'));
    for (const r of awakeFieldRocks(int)) expect(fieldRockMass(r.radius), `${r.id} woke`).toBeLessThanOrEqual(bsMass);
  });

  it('a heavy rock driven into the pile wakes the lighter rocks it hits', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, testMode: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0 });
    // A pilot parked in the lane keeps the wall's chunks loaded.
    await harness.connectActive(randomUUID(), { spawnX: Math.round(WALL.x - HEAD.x * BACK), spawnY: Math.round(WALL.y - HEAD.y * BACK) });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const sub = int.cutFieldSub!;
    const id = fieldRockId(HEAVY.key);
    const deadline = Date.now() + 20_000;
    while (!int.swarmRegistry.get(id) && Date.now() < deadline) await harness.advance(250);
    const heavy = int.swarmRegistry.get(id);
    expect(heavy, 'the heavy rock streamed in').toBeTruthy();
    expect(sub.wakeRock(id, 'test', int.serverTick)).toBe(true);
    await harness.advance(100);
    const v = 150;
    int.postToWorker({ type: 'SET_POSITION', entityId: id, x: HEAVY.x, y: HEAVY.y, angle: 0, vx: TOWARD.x * v, vy: TOWARD.y * v, angvel: 0 });
    const chain = await harness.events.waitFor(
      { tag: 'field_rock_woke', where: (d) => (d as { by: string }).by === id },
      { timeoutMs: 20_000 },
    );
    expect(String((chain.data as { id: string }).id)).toMatch(/^field:/);
    const heavyMass = fieldRockMass(heavy!.radius);
    for (const e of harness.events.all({ tag: 'field_rock_woke' })) {
      const d = e.data as { id: string; by: string };
      const by = int.swarmRegistry.get(d.by), woke = int.swarmRegistry.get(d.id);
      if (by?.fieldRock !== true || !woke) continue;
      expect(fieldRockMass(woke.radius), `${d.id} woken by ${d.by}`).toBeLessThanOrEqual(fieldRockMass(by.radius));
    }
    expect(heavyMass).toBeGreaterThan(shipBodyMass(getShipKind('battleship')));
  });
});
