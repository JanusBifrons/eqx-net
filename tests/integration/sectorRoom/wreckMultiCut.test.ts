/**
 * Fracture v12 multi-cut in a real room (owner 2026-11-15: "three main
 * turrets burn a wreck piece at slightly different points and angles, but
 * when it runs out it splits along only ONE beam's line"; the decision, "one
 * cut per beam"; capital-destruction.md "Multi-cut").
 *
 * A pilot lance battlecruiser (three heavy-beam main turrets) locks the
 * biggest piece of a dead battleship and holds the main battery until the
 * piece cracks. Each turret's beam burns its own line (`BurnLines`, through
 * the room's real hit path: `applyDamage` → `onWreckHit` with the shooter);
 * on the crack the piece breaks along at least two of them (the child
 * descriptor's main cut plus `extraCuts`), and the client's
 * `WreckGeometryStore`, fed the room's descriptors after a serialise round
 * trip, rebuilds every child body bit for bit (#15, #16).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';
import { WreckGeometryStore } from '../../../src/client/net/wreckGeometryStore.js';
import type { WreckDescriptor } from '../../../src/shared-types/messages/wreckDescriptor.js';

const WRECK_KIND = 4;

describe('SectorRoom integration: a lance main battery splits a wreck piece along every beam', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('three main turrets on one piece: on the crack ≥ 2 cut lines apply, and the client rebuilds every child', async () => {
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
    // The lance 2.5 km out, on the far side from the rest of the wreck and
    // broadside on, so its three turrets' beams cross the piece at their own
    // points and angles (bow on, the turrets line up along the keel and their
    // beams run down one line: one cut, merged) and no other piece is in the
    // line of fire.
    const at = internal.wreckState(big.id)!;
    const ox = at.x - p.x, oy = at.y - p.y;
    const ol = Math.hypot(ox, oy) || 1;
    const lx = at.x + (ox / ol) * 2500, ly = at.y + (oy / ol) * 2500;
    internal.postToWorker({ type: 'SET_POSITION', entityId: pid, x: lx, y: ly, angle: Math.atan2(ox / ol, -oy / ol) + Math.PI / 2, vx: 0, vy: 0, angvel: 0 });
    for (const k of pieces()) {
      const st0 = internal.wreckState(k.id);
      if (st0) internal.postToWorker({ type: 'SET_POSITION', entityId: k.id, x: st0.x, y: st0.y, angle: st0.angle, vx: 0, vy: 0, angvel: 0 });
    }
    await harness.advance(300);
    harness.lockTarget(pid, big.id);

    const rootIds = new Set(internal.wreckDescriptors().map((d) => d.wreckId));
    const t0 = now();
    const wallBy = Date.now() + 150_000;
    while (internal.swarmRegistry.get(big.id) && now() - t0 < 60 * 60 && Date.now() < wallBy) {
      // Hold the main battery trigger (what the client fire control sends).
      client.send('fire', { type: 'fire', tick: now(), clientShotId: `m${now()}`, weapon: 'heavy_beam', dirAngle: 0, slotId: 'main' });
      await harness.advance(50);
    }
    console.log(`[wreck multi-cut] ${((now() - t0) / 60).toFixed(1)} game s, integrity ${size(big.id).toFixed(0)}`);
    expect(internal.swarmRegistry.get(big.id), 'the piece cracked').toBeFalsy();
    await harness.advance(100);

    const wire = JSON.parse(JSON.stringify(internal.wreckDescriptors())) as WreckDescriptor[];
    const child = wire.find((d) => d.parentWreck !== undefined && !rootIds.has(d.wreckId));
    expect(child, 'the piece broke into a child wreck').toBeDefined();
    const lines = 1 + (child!.extraCuts?.length ?? 0);
    console.log(`[wreck multi-cut] lance main battery: the piece broke along ${lines} beam lines into ${pieces().filter((r) => r.wreckId === child!.wreckId).length} pieces`);
    expect(child!.cutKind, 'a heavy-beam cut').toBe('slice');
    expect(lines, 'two or more of the turrets\' lines cut the piece').toBeGreaterThanOrEqual(2);

    // The client: the same descriptors give the same child bodies.
    const store = new WreckGeometryStore();
    store.apply(wire);
    const kids = pieces().filter((r) => r.wreckId === child!.wreckId);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    for (const k of kids) {
      const g = store.piece(child!.wreckId, k.componentIndex);
      expect(g, `child piece ${k.componentIndex} rebuilt`).not.toBeNull();
      expect(g!.parts).toStrictEqual(internal.wreckParts(k.id));
    }
  }, 240_000);
});
