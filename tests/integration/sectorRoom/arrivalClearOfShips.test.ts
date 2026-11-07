/**
 * Phone run 2026-11-07 (sector trip Sol Prime -> Vega Reach): "I arrived
 * inside the base instead of in front like I normally do". Every trip lands
 * at the same point (0, 0); earlier test pilots had left parked hulls there,
 * and the join only stepped around STRUCTURES, so the ship landed on top of
 * the hulls and the physics shoved it away (into the base). A join or an
 * arrival must land clear of other ships and parked hulls too, like an
 * in-sector warp already does.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tuningFor } from '../../../src/shared-types/shipScale/lookup.js';

type Harness = Awaited<ReturnType<typeof import('./harness.js')['bootSectorTestServer']>>;
let boot: typeof import('./harness.js')['bootSectorTestServer'];
let harness: Harness | null = null;

beforeAll(async () => { ({ bootSectorTestServer: boot } = await import('./harness.js')); });
afterEach(async () => { await harness?.cleanup(); harness = null; });

/** A trip arrival carries a transit token (an unknown one still marks the
 *  join as an arrival; it only proves identity when it is real). */
const ARRIVAL = 'trip-arrival';


type Server = { initialSpawnPositions: Map<string, { x: number; y: number }>; lingeringPoseCache: Map<string, { x: number; y: number }>; shipPoseCache: Map<string, { x: number; y: number }> };

describe('SectorRoom integration — arrivals land clear of other ships', () => {
  it('a second pilot joining at the same point lands clear of the first', { timeout: 30_000 }, async () => {
    harness = await boot({ sectorKey: 'vega-reach', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false });
    const a = randomUUID(), b = randomUUID();
    await harness.connectActive(a, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    await harness.connectActive(b, { spawnX: 0, spawnY: 0, shipKind: 'fighter', transitToken: ARRIVAL });
    const server = harness.getServerRoom() as unknown as Server;
    const pa = server.initialSpawnPositions.get(a)!, pb = server.initialSpawnPositions.get(b)!;
    expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeGreaterThanOrEqual(tuningFor('fighter').spawnClearance);
  });

  it('a pilot lands clear of a hull parked on the arrival point', { timeout: 30_000 }, async () => {
    harness = await boot({ sectorKey: 'vega-reach', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false });
    const parked = randomUUID(), pilot = randomUUID();
    const room = await harness.connectActive(parked, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    await harness.disconnectClient(room); // the hull lingers where it was
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === parked });
    const server = harness.getServerRoom() as unknown as Server;
    // A dropped pilot's hull stays parked under their id.
    const hull = server.shipPoseCache.get(parked)!;
    expect(hull).toBeDefined();
    await harness.connectActive(pilot, { spawnX: 0, spawnY: 0, shipKind: 'fighter', transitToken: ARRIVAL });
    const p = server.initialSpawnPositions.get(pilot)!;
    expect(Math.hypot(p.x - hull.x, p.y - hull.y)).toBeGreaterThanOrEqual(tuningFor('fighter').spawnClearance);
  });

  it('an ordinary join keeps its exact placement (tests stage collisions)', { timeout: 30_000 }, async () => {
    harness = await boot({ sectorKey: 'vega-reach', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false });
    const a = randomUUID(), b = randomUUID();
    await harness.connectActive(a, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    await harness.connectActive(b, { spawnX: 0, spawnY: 30, shipKind: 'fighter' });
    const server = harness.getServerRoom() as unknown as Server;
    expect(server.initialSpawnPositions.get(b)).toEqual({ x: 0, y: 30 });
  });
});
