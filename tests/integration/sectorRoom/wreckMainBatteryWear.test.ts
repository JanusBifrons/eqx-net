/**
 * Wreck wear and knock under a real main battery (owner on the re-split
 * clip, 2026-11-15: "It's splitting stuff like almost instantly ... no time
 * for me to understand wtf is going on" and "It's also pushing the scrap
 * away ... scrap should weigh a lot and be very resistant to sliding").
 *
 * A pilot lance battlecruiser (heavy-beam main battery) 5 km out from the
 * biggest piece of a dead battleship, facing it with the rest of the wreck
 * behind the piece, locks it (`lockTarget`, `instantLock`) and holds the
 * main battery's trigger. Measured in game ticks (capital-destruction.md §S4
 * "Re-split"):
 *   - the biggest piece cracks after about 10 s of sustained fire;
 *   - from rest, the hits leave it creeping well under 5 u/s and barely
 *     turning;
 *   - its smallest child (the integrity floor) still lasts ~3 s.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';

const WRECK_KIND = 4;
const TICK_HZ = 60;

describe('SectorRoom integration: a main battery wears a capital wreck piece slowly and barely moves it', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a lance main battery takes ~10 s to crack the biggest battleship piece; it barely drifts or spins; the floor is ~3 s', async () => {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, pilotCapitals: true, traverseTicksCap: 0, lockTimeCapS: 0,
      dronePoses: [{ kind: 'battleship', x: 0, y: 2500, angle: 0 }],
    });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, {
      shipKind: 'battlecruiser-lance', spawnX: 5500, spawnY: 2500, initialHull: 1_000_000, initialShield: 0, instantLock: true,
    });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const internal = room._internals;
    const now = (): number => room._internals.serverTick;
    internal.setWreckSeed(5);
    await harness.advance(150);
    const bs = [...internal.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(bs, 'the battleship is there').toBeDefined();
    const p = internal.swarmPose(bs.id)!;
    for (let i = 0; i < 4 && internal.swarmRegistry.get(bs.id); i++) internal.applyDamage(bs.id, 'test-kill', 1e9, p.x, p.y);
    for (let i = 0; i < 40 && internal.wreckDescriptors().length === 0; i++) await harness.advance(50);
    expect(internal.wreckDescriptors().length, 'the battleship broke up').toBeGreaterThan(0);
    await harness.advance(WRECK_CRACK_MS + 500);

    const pieces = () => [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
    const size = (id: string) => internal.wreckIntegrity(id) ?? 0;
    const big = pieces().reduce((a, b) => (size(b.id) > size(a.id) ? b : a));
    // The lance 5 km out from the piece, on the far side from the rest of the
    // wreck and facing it, so no other piece is in the line of fire.
    const at = internal.wreckState(big.id)!;
    const ox = at.x - p.x, oy = at.y - p.y;
    const ol = Math.hypot(ox, oy) || 1;
    const lx = at.x + (ox / ol) * 5000, ly = at.y + (oy / ol) * 5000;
    internal.postToWorker({ type: 'SET_POSITION', entityId: pid, x: lx, y: ly, angle: Math.atan2(ox / ol, -oy / ol), vx: 0, vy: 0, angvel: 0 });
    await harness.advance(200);

    // Fire on a piece from rest (the wreck's parting motion zeroed, so every
    // u/s it gains is the hits' knock) until it breaks or `maxS` game s pass.
    const grind = async (id: string, maxS: number) => {
      // Every piece at rest: a neighbour still parting would bump this one.
      for (const k of pieces()) {
        const st0 = internal.wreckState(k.id);
        if (st0) internal.postToWorker({ type: 'SET_POSITION', entityId: k.id, x: st0.x, y: st0.y, angle: st0.angle, vx: 0, vy: 0, angvel: 0 });
      }
      harness.lockTarget(pid, id);
      const i0 = size(id);
      let firstHit = -1;
      let gone = -1;
      let maxDv = 0;
      let maxW = 0;
      const t0 = now();
      const wallBy = Date.now() + 100_000;
      while (now() - t0 < maxS * TICK_HZ && Date.now() < wallBy) {
        // Hold the main battery trigger (what the client fire control sends).
        client.send('fire', { type: 'fire', tick: now(), clientShotId: `m${now()}`, weapon: 'heavy_beam', dirAngle: 0, slotId: 'main' });
        await harness.advance(50);
        const tick = now();
        if (!internal.swarmRegistry.get(id)) { gone = tick; break; }
        const st = internal.wreckState(id)!;
        if (firstHit < 0 && size(id) < i0) firstHit = tick;
        // Drift and spin built up by up to 10 s of fire.
        if (firstHit >= 0 && tick - firstHit <= 10 * TICK_HZ) {
          maxDv = Math.max(maxDv, Math.hypot(st.vx, st.vy));
          maxW = Math.max(maxW, Math.abs(st.angvel));
        }
      }
      expect(firstHit, `the main battery hit ${id}`).toBeGreaterThanOrEqual(0);
      return { splitS: gone >= 0 ? (gone - firstHit) / TICK_HZ : Number.POSITIVE_INFINITY, maxDv, maxW, iMax: i0 };
    };

    const r = await grind(big.id, 25);
    console.log(`[wreck wear] battleship biggest piece (I_max ${r.iMax.toFixed(0)}): split after ${r.splitS.toFixed(2)} s of lance main-battery fire; drift ${r.maxDv.toFixed(2)} u/s, spin ${r.maxW.toFixed(4)} rad/s over the first ${Math.min(10, r.splitS).toFixed(1)} s`);
    expect(r.splitS, 'about 10 s of sustained fire cracks a big piece').toBeGreaterThan(7);
    expect(r.splitS).toBeLessThan(14);
    expect(r.maxDv, 'the hits barely move the piece').toBeLessThan(1.5);
    expect(r.maxW, 'the hits barely turn the piece').toBeLessThan(0.02);

    // Its smallest child (at the integrity floor) still takes ~3 s.
    await harness.advance(100);
    const child = internal.wreckDescriptors().find((d) => d.parentWreck !== undefined);
    expect(child, 'the piece split into a child wreck').toBeDefined();
    const kids = pieces().filter((k) => k.wreckId === child!.wreckId);
    const small = kids.reduce((x, y) => (size(y.id) < size(x.id) ? y : x));
    const c = await grind(small.id, 12);
    console.log(`[wreck wear] its smallest child (I_max ${c.iMax.toFixed(0)}): gone after ${c.splitS.toFixed(2)} s`);
    expect(c.splitS, 'no piece cracks in under ~3 s').toBeGreaterThan(2.7);
  }, 240_000);
});
