/**
 * Macro terrain C2 (deep sleep), two-sided (#15): the pose the server keeps
 * for a moved field rock is the pose the client draws it at and builds its
 * predWorld body at. Server: a saved record loads into `CutFieldSubsystem`,
 * whose welcome carries it (`cutField.moved`). Client: `CutFieldClient` takes
 * the welcome and sends the chunk with it; `CutFieldLayer` moves the rock's
 * fan there. Mapping each drawn vertex back with the server's `toRestFrame`
 * must give the outline the field cut, so the two sides agree on centre,
 * angle sign and y flip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mesh } from 'pixi.js';

// A GL program needs a canvas; node has none.
vi.mock('../../src/client/render/field/fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import type { GameClock } from '../../src/core/clock/GameClock.js';
import type { PhysicsWorld, ShipPhysicsState } from '../../src/core/physics/World.js';
import { cutFieldOpts, fieldRockBody, fieldRockId } from '../../src/core/terrain/chunkStreamer.js';
import { FIELD_LAYOUT_VERSION, rocksInChunk } from '../../src/core/terrain/fieldLayout.js';
import type { PackedChunk } from '../../src/core/terrain/packedChunk.js';
import type { SwarmEntityRegistry } from '../../src/server/net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../../src/server/spawn/SwarmSpawner.js';
import type { TerrainRecordStore } from '../../src/server/db/terrainSql.js';
import { CutFieldSubsystem, toRestFrame } from '../../src/server/rooms/CutFieldSubsystem.js';
import { WelcomeSchema } from '../../src/shared-types/messages/snapshotMessages.js';
import { CutFieldClient } from '../../src/client/net/CutFieldClient.js';
import { CutFieldLayer } from '../../src/client/render/field/CutFieldLayer.js';

let client: CutFieldClient | null = null;
afterEach(() => { client?.stop(); client = null; });

describe('cut-field moved pose: server keeps = client draws (C2, #15)', () => {
  const CX = -8, CY = 6;
  const rock = rocksInChunk(cutFieldOpts('look'), CX, CY).reduce((a, b) => (b.size > a.size ? b : a));
  const body = fieldRockBody(rock);
  const pose = { x: body.x + 340, y: body.y - 210, angle: 0.7 };

  it('the welcome pose moves the drawn rock and its predWorld body to exactly that pose', () => {
    // Server: the saved record, loaded at start, into the welcome.
    const store: TerrainRecordStore = {
      sectorKey: 's', put: () => {}, warn: () => {},
      load: () => [{ rockKey: rock.key, layoutVersion: FIELD_LAYOUT_VERSION, pool: null, consumed: false, pose }],
    };
    const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
    const registry = { get: () => null, all: () => [] } as unknown as SwarmEntityRegistry;
    const sub = new CutFieldSubsystem('look', clock, registry, {} as SwarmSpawner, {
      shipSlots: () => [], sab: () => new Float32Array(0), post: () => {}, evict: () => {}, broadcast: () => {}, records: store,
    });
    const welcome = { type: 'welcome', playerId: 'p', serverTick: 0, sectorKey: null, shipInstanceId: '', ...sub.welcome };
    sub.dispose();
    const parsed = WelcomeSchema.parse(welcome);

    // Client: cut the chunk with the welcome's poses; the ship sits on the moved rock.
    const sent: Array<{ cx: number; cy: number; outlines: Float32Array | null; ore?: Float32Array | null; bodies?: PackedChunk | null; moved?: Float64Array | null }> = [];
    const pred = new Map<string, ShipPhysicsState>();
    const pw = {
      spawnObstacle: (id: string, x: number, y: number) => { pred.set(id, { x, y, angle: 0, vx: 0, vy: 0 }); },
      fixBody: () => {},
      setShipStateAsleep: (id: string, s: ShipPhysicsState) => { pred.set(id, { ...s }); },
      despawnShip: (id: string) => { pred.delete(id); },
    } as unknown as PhysicsWorld;
    client = new CutFieldClient({
      gameClock: { now: () => 0 }, predWorld: () => pw, localPose: () => ({ x: pose.x, y: pose.y }),
      draw: { setFieldChunk: (cx, cy, outlines, ore, bodies, moved) => { sent.push({ cx, cy, outlines, ore, bodies, moved }); } },
    });
    client.setSeed(parsed.cutField!.seed, parsed.cutField!.consumed, parsed.cutField!.moved);
    for (let i = 0; i < 80 && !sent.some((c) => c.cx === CX && c.cy === CY); i++) client.step();
    client.step(); // stream predWorld bodies
    const chunk = sent.find((c) => c.cx === CX && c.cy === CY)!;
    expect(chunk, 'the moved rock\'s chunk was cut').toBeDefined();
    // The same numbers the server keeps, no rounding on the way.
    expect(Array.from(chunk.moved!)).toEqual([rock.index, pose.x, pose.y, pose.angle]);
    // predWorld: the body sits at the moved pose, turned.
    expect(pred.get(fieldRockId(rock.key))).toMatchObject({ x: pose.x, y: pose.y, angle: pose.angle });

    // Layer: the rock's drawn vertices map back onto the outline the field cut.
    const layer = new CutFieldLayer();
    layer.setChunk(chunk.cx, chunk.cy, chunk.outlines, chunk.ore ?? null, chunk.bodies ?? null, chunk.moved ?? null);
    const p = (layer.chunkLayer.children[0] as Mesh).geometry.positions;
    const o = chunk.outlines!;
    let s = 0, v = 0;
    for (let r = 0; r < rock.index; r++) { v += o[s]! + 1; s += 1 + o[s]! * 2; }
    const n = o[s]!;
    const back = { x: 0, y: 0 };
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const gx = p[(v + 1 + k) * 2]!, gy = -p[(v + 1 + k) * 2 + 1]!;
      toRestFrame(body.x, body.y, pose.x, pose.y, pose.angle, gx, gy, back);
      worst = Math.max(worst, Math.hypot(back.x - o[s + 1 + k * 2]!, back.y - o[s + 2 + k * 2]!));
    }
    expect(worst, 'drawn outline maps back onto the cut outline (float32 slack)').toBeLessThan(0.05);
    // And it really moved: its first vertex is not where the field cut it.
    expect(Math.hypot(p[(v + 1) * 2]! - o[s + 1]!, -p[(v + 1) * 2 + 1]! - o[s + 2]!)).toBeGreaterThan(100);
    layer.clear();
  });
});
