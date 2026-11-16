/**
 * Macro terrain C2 (deep sleep): a field rock that was woken and moved keeps
 * its pose when its chunk unloads (no ship near) and comes back there, fixed,
 * when the chunk loads again, not at the pose the field cut it in. Two-sided
 * (#15): the client cuts the chunk from the seed and would draw the rock at its
 * cut pose, so the moved rock rides the swarm wire with its rock key (the
 * client then drops it from its chunk mesh and draws it from the wire): the
 * real `decodeSwarmPacket` must see it at the server's pose.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { decodeSwarmPacket } from '../../../src/client/net/BinarySwarmDecoder.js';
import type { RenderMirror } from '../../../src/core/contracts/IRenderer.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

const HOME = { x: 60_000, y: 0 };
const AWAY = { x: -60_000, y: 0 }; // the far side of the field: HOME's chunks unload

describe('SectorRoom integration — cut-field deep sleep (C2)', () => {
  it('a moved rock comes back where it was moved to, and the client sees it there', { timeout: 120_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, testMode: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0, defaultSpawnX: HOME.x, defaultSpawnY: HOME.y });
    const pid = randomUUID();
    const client = await harness.connectAs(pid);
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    client.onMessage('swarm', (buf: Uint8Array) => decodeSwarmPacket(buf, mirror));
    client.send('client_ready', { type: 'client_ready' });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const sub = int.cutFieldSub!;

    // A field rock with some room between it and the pilot.
    let rock: { id: string; fieldKey?: number; restX?: number; restY?: number } | undefined;
    const deadline = Date.now() + 20_000;
    while (!rock && Date.now() < deadline) {
      await harness.advance(500);
      for (const r of int.swarmRegistry.all()) {
        if (r.fieldRock === true && r.restX !== undefined && Math.hypot(r.restX - HOME.x, r.restY! - HOME.y) > 1_500) { rock = r; break; }
      }
    }
    expect(rock?.fieldKey, 'a field rock streamed in').toBeTypeOf('number');
    const key = rock!.fieldKey!, id = rock!.id;
    const rest = { x: rock!.restX!, y: rock!.restY! };

    // Wake it and shove it: a new pose and a turn.
    expect(sub.wakeRock(id, 'test', int.serverTick)).toBe(true);
    await harness.advance(100);
    int.postToWorker({ type: 'SET_POSITION', entityId: id, x: rest.x + 120, y: rest.y - 80, angle: 0.4, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(500);

    // Every ship goes away; follow the rock's last pose until its chunk unloads.
    int.postToWorker({ type: 'SET_POSITION', entityId: pid, x: AWAY.x, y: AWAY.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    let last = int.swarmPose(id)!;
    const gone = Date.now() + 40_000;
    while (int.swarmRegistry.get(id) && Date.now() < gone) {
      last = int.swarmPose(id) ?? last;
      await harness.advance(250);
    }
    expect(int.swarmRegistry.get(id), 'its chunk unloaded').toBeFalsy();
    expect(Math.hypot(last.x - rest.x, last.y - rest.y) + Math.abs(last.angle), 'it had moved off its cut pose').toBeGreaterThan(5);
    // Forget what the client saw while it was awake: only the reloaded rock counts.
    for (const [k, e] of mirror.swarm ?? []) if (e.fieldKey === key) mirror.swarm!.delete(k);

    // Back home: the chunk reloads and the rock is where it was left.
    int.postToWorker({ type: 'SET_POSITION', entityId: pid, x: HOME.x, y: HOME.y, angle: 0, vx: 0, vy: 0, angvel: 0 });
    const back = Date.now() + 20_000;
    while (!int.swarmRegistry.get(id) && Date.now() < back) await harness.advance(250);
    await harness.advance(500);
    const pose = int.swarmPose(id);
    expect(pose, 'its chunk reloaded').not.toBeNull();
    expect(pose!.x).toBeCloseTo(last.x, 0);
    expect(pose!.y).toBeCloseTo(last.y, 0);
    expect(pose!.angle).toBeCloseTo(last.angle, 2);
    // Its ore is still laid out where it was cut (rest frame unchanged).
    expect(int.swarmRegistry.get(id)!.restX).toBeCloseTo(rest.x, 3);
    expect(int.swarmRegistry.get(id)!.restY).toBeCloseTo(rest.y, 3);

    // The client: the rock rides the wire by its key at the server's pose.
    const seen = Date.now() + 5_000;
    const onWire = (): { x: number; y: number } | undefined => [...(mirror.swarm?.values() ?? [])].find((e) => e.fieldKey === key);
    while (!onWire() && Date.now() < seen) { harness.sendThrust(client); await harness.advance(100); }
    const wire = onWire();
    expect(wire, 'the moved rock rides the swarm wire with its key').toBeDefined();
    expect(wire!.x).toBeCloseTo(last.x, 0);
    expect(wire!.y).toBeCloseTo(last.y, 0);
  });
});
