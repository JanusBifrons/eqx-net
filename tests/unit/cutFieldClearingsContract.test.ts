/**
 * Macro terrain F4 (galaxy sectors), two-sided (#15): the clearings the server
 * cuts its field with are the clearings the client cuts with. Server: a
 * `CutFieldSubsystem` built with a sector's clearings puts them on the
 * welcome (`cutField.clearings`). Client: the welcome goes through the real
 * parse (`parseWelcome`), into `CutFieldClient.setSeed`, and out to the
 * background cutter (the bake worker's `cutChunk`, a structured clone). The
 * ChunkOpts and the rocks cut on both sides must match.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { GameClock } from '../../src/core/clock/GameClock.js';
import type { PhysicsWorld } from '../../src/core/physics/World.js';
import { cutFieldOpts } from '../../src/core/terrain/chunkStreamer.js';
import { CHUNK_SIZE, rocksInChunk, type ChunkOpts, type FieldClearing } from '../../src/core/terrain/fieldLayout.js';
import { packChunk } from '../../src/core/terrain/packedChunk.js';
import { GALAXY_SECTORS } from '../../src/core/galaxy/galaxy.js';
import { sectorCutField } from '../../src/core/galaxy/sectorSites.js';
import type { SwarmEntityRegistry } from '../../src/server/net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../../src/server/spawn/SwarmSpawner.js';
import { CutFieldSubsystem } from '../../src/server/rooms/CutFieldSubsystem.js';
import { MAX_WELCOME_CLEARINGS } from '../../src/shared-types/messages/snapshotMessages.js';
import { parseWelcome } from '../../src/client/net/parseWelcome.js';
import { CutFieldClient } from '../../src/client/net/CutFieldClient.js';

const fields = GALAXY_SECTORS.map((s) => sectorCutField(s.key, true)).filter((f) => f !== null && f.clearings.length > 0);
const FIELD = fields[0]!;

function server(seed: string, clearings?: readonly FieldClearing[]): { sub: CutFieldSubsystem; opts: ChunkOpts } {
  const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
  const registry = { get: () => null, all: () => [] } as unknown as SwarmEntityRegistry;
  const sub = new CutFieldSubsystem(seed, clock, registry, {} as SwarmSpawner, {
    shipSlots: () => [], sab: () => new Float32Array(0), post: () => {}, evict: () => {}, broadcast: () => {},
  }, clearings);
  return { sub, opts: (sub as unknown as { opts: ChunkOpts }).opts };
}

/** The welcome as the client receives it: built by the server, parsed. */
function welcomeOf(sub: CutFieldSubsystem) {
  const msg = parseWelcome(structuredClone({ type: 'welcome', playerId: 'p', serverTick: 0, sectorKey: 's', shipInstanceId: '', ...sub.welcome }));
  expect(msg, 'the welcome parses').not.toBeNull();
  return msg!.cutField!;
}

/** A client whose background cutter records the field it is handed and cuts
 *  from a structured clone of it, as the bake worker does. */
function clientRig(at: { x: number; y: number }) {
  const handed: ChunkOpts[] = [];
  const c = new CutFieldClient({
    gameClock: { now: () => 0 }, predWorld: () => ({ spawnObstacle: () => {}, fixBody: () => {}, lockBody: () => {}, despawnShip: () => {} }) as unknown as PhysicsWorld,
    localPose: () => at, draw: { setFieldChunk: () => {} },
    cutter: () => ({
      cutChunk: (field, cx, cy) => {
        handed.push(field);
        const f = structuredClone(field);
        return Promise.resolve(packChunk(rocksInChunk(f, cx, cy), f.seed));
      },
    }),
  });
  return { c, handed };
}

let live: CutFieldClient | null = null;
afterEach(() => { live?.stop(); live = null; });

describe('cut-field clearings: server cuts = client cuts (F4, #15)', () => {
  it('every galaxy sector\'s clearings fit on the welcome', () => {
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f!.clearings.length).toBeLessThanOrEqual(MAX_WELCOME_CLEARINGS);
  });

  it('the welcome carries the clearings and the client cuts with the server\'s ChunkOpts', () => {
    const { sub, opts } = server(FIELD.seed, FIELD.clearings);
    const wire = welcomeOf(sub);
    sub.dispose();
    expect(wire.clearings).toEqual(FIELD.clearings);

    const k = FIELD.clearings[0]!;
    const { c, handed } = clientRig({ x: k.x, y: k.y });
    live = c;
    c.setSeed(wire.seed, wire.consumed, wire.moved, wire.clearings);
    c.step();
    expect(handed.length).toBeGreaterThan(0);
    expect(handed[0]).toEqual(opts);
    expect(structuredClone(handed[0])).toEqual(opts); // survives postMessage to the worker
  });

  it('the clearings change the rocks, and both sides cut the same ones', () => {
    const { sub, opts } = server(FIELD.seed, FIELD.clearings);
    const wire = welcomeOf(sub);
    sub.dispose();
    const clientOpts = cutFieldOpts(wire.seed, wire.clearings);
    const keys = (o: ChunkOpts, cx: number, cy: number) => rocksInChunk(o, cx, cy).map((r) => r.key);
    let differs = 0;
    for (const k of FIELD.clearings) {
      const cx = Math.floor(k.x / CHUNK_SIZE), cy = Math.floor(k.y / CHUNK_SIZE);
      const served = keys(opts, cx, cy);
      expect(keys(structuredClone(clientOpts), cx, cy)).toEqual(served);
      if (served.join() !== keys(cutFieldOpts(FIELD.seed), cx, cy).join()) differs++;
    }
    expect(differs, 'a clearing changes what is cut (else this test bites nothing)').toBeGreaterThan(0);
  });

  it('a field with no clearings sends none and cuts exactly as before (test rooms)', () => {
    const { sub, opts } = server('look');
    expect(sub.welcome).toEqual({ cutField: { seed: 'look' } });
    sub.dispose();
    expect(opts).toEqual(cutFieldOpts('look'));
    expect('clearings' in opts).toBe(false);
    expect(server('look', []).opts).toEqual(cutFieldOpts('look'));
  });

  it('a welcome with the same seed but other clearings re-cuts the field', () => {
    const k = FIELD.clearings[0]!;
    const { c, handed } = clientRig({ x: k.x, y: k.y });
    live = c;
    c.setSeed(FIELD.seed);
    c.step();
    expect(handed.at(-1)!.clearings).toBeUndefined();
    c.setSeed(FIELD.seed, [], [], FIELD.clearings);
    c.step();
    expect(handed.at(-1)!.clearings).toEqual(FIELD.clearings);
    // Inline cutting (no pool): an equal set keeps the loaded chunks, another drops them.
    const inline = new CutFieldClient({
      gameClock: { now: () => 0 }, predWorld: () => null, localPose: () => ({ x: k.x, y: k.y }), draw: { setFieldChunk: () => {} },
    });
    live?.stop(); live = inline;
    inline.setSeed(FIELD.seed, [], [], FIELD.clearings);
    for (let i = 0; i < 3; i++) inline.step();
    const loaded = inline.chunksLoaded;
    expect(loaded).toBeGreaterThan(0);
    inline.setSeed(FIELD.seed, [], [], FIELD.clearings.map((q) => ({ ...q })));
    expect(inline.chunksLoaded, 'equal clearings: no restart').toBe(loaded);
    inline.setSeed(FIELD.seed, [], [], FIELD.clearings.slice(1));
    expect(inline.chunksLoaded, 'other clearings: restarted').toBe(0);
  });

  it('the server refuses more clearings than the welcome carries', () => {
    const many = Array.from({ length: MAX_WELCOME_CLEARINGS + 1 }, (_, i) => ({ x: i * 10_000, y: 0, r: 1000 }));
    expect(() => server('look', many)).toThrow(/clearings/);
  });
});
