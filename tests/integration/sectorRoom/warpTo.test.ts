/**
 * In-sector warp-to (Phase 4 step 4), end to end through a real SectorRoom:
 * a pilot holds a warp request for a gate pocket's rim 170 km out; the server
 * validates it, the worker spools, runs and drops the ship there. A request
 * for a point that isn't a pocket rim is ignored.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env['EQX_SOLAR_SECTORS'] = '1';

type Harness = Awaited<ReturnType<typeof import('./harness.js')['bootSectorTestServer']>>;
let boot: typeof import('./harness.js')['bootSectorTestServer'];
let sites: typeof import('../../../src/core/galaxy/sectorSites.js');
let harness: Harness | null = null;

beforeAll(async () => {
  ({ bootSectorTestServer: boot } = await import('./harness.js'));
  sites = await import('../../../src/core/galaxy/sectorSites.js');
});
afterEach(async () => { await harness?.cleanup(); harness = null; });
afterAll(() => { delete process.env['EQX_SOLAR_SECTORS']; });

async function flyWithWarp(warp: { x: number; y: number }, ms: number): Promise<{ x: number; y: number }> {
  harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false });
  const pid = randomUUID();
  const room = await harness.connectActive(pid, { spawnX: 0, spawnY: 0 });
  const server = harness.getServerRoom() as unknown as { serverTick: number; shipPoseCache: Map<string, { x: number; y: number }> };
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // A held request, one input per tick as the client sends while warping.
    room.send('input', { type: 'input', tick: server.serverTick + 2, thrust: false, turnLeft: false, turnRight: false, warpX: warp.x, warpY: warp.y });
    await new Promise((r) => setTimeout(r, 16));
  }
  return { ...server.shipPoseCache.get(pid)! };
}

describe('SectorRoom integration — warp-to (solar-system sectors)', () => {
  it('spools, runs and drops the ship on the pocket rim it asked for', { timeout: 40_000 }, async () => {
    const gate = sites.sectorSites('sol-prime').find((s) => s.kind === 'gate')!;
    const drop = sites.warpDropPoint(gate, 0, 0);
    expect(sites.isWarpDropPoint('sol-prime', drop.x, drop.y, true)).toBe(true);
    const pos = await flyWithWarp(drop, 15_000); // 3 s spool + ~8.5 s run
    expect(Math.hypot(pos.x - drop.x, pos.y - drop.y)).toBeLessThan(1500);
  });

  it('ignores a warp to a point that is not a pocket rim', { timeout: 30_000 }, async () => {
    const pos = await flyWithWarp({ x: 90_000, y: 90_000 }, 5_000);
    expect(Math.hypot(pos.x, pos.y)).toBeLessThan(200);
  });

  it('an onlooker sees the warp in the snapshot: spool, then the run (#16)', { timeout: 40_000 }, async () => {
    harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false });
    const pilot = randomUUID(), onlooker = randomUUID();
    const room = await harness.connectActive(pilot, { spawnX: 0, spawnY: 0 });
    const watch = await harness.connectActive(onlooker, { spawnX: 300, spawnY: 0 });
    const seen = new Set<number>();
    watch.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; warp?: number }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pilot && st.warp !== undefined) seen.add(st.warp);
    });
    const server = harness.getServerRoom() as unknown as { serverTick: number };
    const gate = sites.sectorSites('sol-prime').find((x) => x.kind === 'gate')!;
    const drop = sites.warpDropPoint(gate, 0, 0);
    const end = Date.now() + 6000;
    while (Date.now() < end && !seen.has(2)) {
      room.send('input', { type: 'input', tick: server.serverTick + 2, thrust: false, turnLeft: false, turnRight: false, warpX: drop.x, warpY: drop.y });
      await new Promise((r) => setTimeout(r, 16));
    }
    expect([...seen].sort()).toEqual([1, 2]);
  });
});

