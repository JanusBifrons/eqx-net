/**
 * In-sector warp-to (Phase 4 step 4), end to end through a real SectorRoom:
 * a pilot holds a warp request for a gate pocket's rim 170 km out; the server
 * validates it, the worker spools, runs and drops the ship there. A request
 * for a point that isn't a pocket rim is ignored.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

type Harness = Awaited<ReturnType<typeof import('./harness.js')['bootSectorTestServer']>>;
let boot: typeof import('./harness.js')['bootSectorTestServer'];
let sites: typeof import('../../../src/core/galaxy/sectorSites.js');
let harness: Harness | null = null;

beforeAll(async () => {
  ({ bootSectorTestServer: boot } = await import('./harness.js'));
  sites = await import('../../../src/core/galaxy/sectorSites.js');
});
afterEach(async () => { await harness?.cleanup(); harness = null; });

async function flyWithWarp(warp: { x: number; y: number }, ms: number): Promise<{ x: number; y: number }> {
  harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false, solarSectors: true });
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

  // User 2026-11-08 ("does it only ever fly right?!"): the filmed pick was the
  // gate due east. A pocket to the south-west must be reached too.
  it('flies any direction: a south-west pocket, not just east', { timeout: 40_000 }, async () => {
    const belt = sites.sectorSites('sol-prime').find((s) => s.kind === 'belt' && s.x < 0 && s.y < 0)!;
    const drop = sites.warpDropPoint(belt, 0, 0);
    const pos = await flyWithWarp(drop, 13_000);
    expect(pos.x).toBeLessThan(-10_000);
    expect(pos.y).toBeLessThan(-10_000);
    expect(Math.hypot(pos.x - drop.x, pos.y - drop.y)).toBeLessThan(1500);
  });

  it('ignores a warp to a point that is not a pocket rim', { timeout: 30_000 }, async () => {
    const pos = await flyWithWarp({ x: 90_000, y: 90_000 }, 5_000);
    expect(Math.hypot(pos.x, pos.y)).toBeLessThan(200);
  });

  it('an onlooker sees the spool, the run (to hide the ship) and the arrival (#16)', { timeout: 40_000 }, async () => {
    harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false, solarSectors: true });
    const pilot = randomUUID(), onlooker = randomUUID();
    const room = await harness.connectActive(pilot, { spawnX: 0, spawnY: 0 });
    const watch = await harness.connectActive(onlooker, { spawnX: 300, spawnY: 0 });
    const seen = new Set<number>();
    let ownRun = false;
    watch.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; warp?: number }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pilot && st.warp !== undefined) seen.add(st.warp);
    });
    // The pilot's own client still gets its own ship on the run (it predicts it).
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; warp?: number }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pilot && st.warp === 2) ownRun = true;
    });
    const server = harness.getServerRoom() as unknown as { serverTick: number };
    const gate = sites.sectorSites('sol-prime').find((x) => x.kind === 'gate')!;
    const drop = sites.warpDropPoint(gate, 0, 0);
    const end = Date.now() + 16_000;
    while (Date.now() < end && !seen.has(3)) {
      room.send('input', { type: 'input', tick: server.serverTick + 2, thrust: false, turnLeft: false, turnRight: false, warpX: drop.x, warpY: drop.y });
      await new Promise((r) => setTimeout(r, 16));
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(ownRun).toBe(true);
  });

  it('lands at the nearest clear spot when something sits on the drop point', { timeout: 40_000 }, async () => {
    const gate = sites.sectorSites('sol-prime').find((s) => s.kind === 'gate')!;
    const drop = sites.warpDropPoint(gate, 0, 0);
    // An immovable structure squarely on the drop point.
    const block = { x: drop.x, y: drop.y, radius: 250 };
    harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false, solarSectors: true, structurePoses: [block] });
    const pid = randomUUID();
    const room = await harness.connectActive(pid, { spawnX: 0, spawnY: 0 });
    const server = harness.getServerRoom() as unknown as { serverTick: number; shipPoseCache: Map<string, { x: number; y: number; vx: number; vy: number }> };
    // The landing pose: the first slow sample near the drop point (before any
    // collision could shove the ship out).
    let landed: { x: number; y: number } | null = null;
    const end = Date.now() + 15_000;
    while (Date.now() < end && landed === null) {
      room.send('input', { type: 'input', tick: server.serverTick + 2, thrust: false, turnLeft: false, turnRight: false, warpX: drop.x, warpY: drop.y });
      await new Promise((r) => setTimeout(r, 16));
      const p = server.shipPoseCache.get(pid)!;
      if (Math.hypot(p.x - drop.x, p.y - drop.y) < 3000 && Math.hypot(p.vx, p.vy) < 1000) landed = { x: p.x, y: p.y };
    }
    expect(landed).not.toBeNull();
    const fromBlock = Math.hypot(landed!.x - block.x, landed!.y - block.y);
    expect(fromBlock).toBeGreaterThan(block.radius + 20);
    expect(fromBlock).toBeLessThan(2000);
  });

  it('a ship joining the sector arrives with the same drop effect (warp 3), not the old shader', { timeout: 30_000 }, async () => {
    harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false, solarSectors: true });
    const watch = await harness.connectActive(randomUUID(), { spawnX: 0, spawnY: 0 });
    const joiner = randomUUID();
    let arrived = false;
    watch.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; warp?: number }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === joiner && st.warp === 3) arrived = true;
    });
    await harness.connectActive(joiner, { spawnX: 400, spawnY: 0 });
    const end = Date.now() + 3000;
    while (Date.now() < end && !arrived) await new Promise((r) => setTimeout(r, 20));
    expect(arrived).toBe(true);
  });

  it('a ship still joining (client not ready) is not shown to anyone else yet', { timeout: 30_000 }, async () => {
    // Showcase review 2026-11-07: a joining ship was sent to others as a
    // PARKED hull while its client loaded, so it popped in with no effect,
    // then blinked out and back when it became active.
    harness = await boot({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], galaxyBases: false, alienGates: false, solarSectors: true });
    const watch = await harness.connectActive(randomUUID(), { spawnX: 0, spawnY: 0 });
    const joiner = randomUUID();
    let seenEarly = false;
    watch.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === joiner) seenEarly = true;
    });
    await harness.connectAs(joiner, { spawnX: 400, spawnY: 0 }); // no client_ready
    await new Promise((r) => setTimeout(r, 1500));
    expect(seenEarly).toBe(false);
  });
});
