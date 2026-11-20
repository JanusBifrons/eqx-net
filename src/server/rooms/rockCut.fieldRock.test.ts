/**
 * Field rock cut, slice 1C-b: the mining laser breaks a cut-FIELD rock like
 * an ordinary rock (`RockCutter` through `onWreckHit`). Locks: the rock wakes
 * as a body while it is mined; its break marks it consumed (once, by its
 * field rock key); its wreck's rock ref carries that key (shape 0, no field
 * options on the wire) and rebuilds from the field layout; without the
 * room's field options a field rock is not cut at all.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { rockViewOf } from './rockCut.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { rocksInChunk } from '../../core/terrain/fieldLayout.js';
import { cutFieldOpts, fieldRockBody, fieldRockId } from '../../core/terrain/chunkStreamer.js';
import { rebuildWreckPieces } from '../../core/destruction/wreckDescriptorGeometry.js';
import { WreckRockRefSchema } from '../../shared-types/messages/wreckDescriptor.js';

const FIELD = cutFieldOpts('test-seed');
const ROCK = rocksInChunk(FIELD, 15, 0)[0]!; // in the field ring
const BODY = fieldRockBody(ROCK);
const ID = fieldRockId(ROCK.key);

function make(field: typeof FIELD | null = FIELD) {
  let tick = 1000;
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>([ID]);
  const rec = { id: ID, kind: 0, radius: BODY.radius, fieldRock: true, fieldKey: ROCK.key, resources: 500 } as unknown as SwarmEntityRecord;
  const reg = { get: (id: string) => (id === ID && live.has(ID) ? rec : null) };
  const pose = { x: BODY.x, y: BODY.y, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const woken: string[] = [];
  const consumed: number[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: () => null,
    positionOf: () => null,
    spawnPiece: (s) => { spawned.set(s.id, s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); sys.pieceGone(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? (spawned.get(id)?.angle ?? 0) : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: (id) => {
      if (id === ID) return live.has(ID) ? pose : null;
      const s = spawned.get(id);
      return s !== undefined && live.has(id) ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel } : null;
    },
    dropSalvage: () => {},
    rockOf: (id) => rockViewOf(reg, id, field),
    wakeFieldRock: (id) => { woken.push(id); },
    fieldRockBroken: (key) => { consumed.push(key); },
  });
  sys.forcedSeed = 11;
  const mine = (): number => {
    let hits = 0;
    for (; hits < 400 && live.has(ID); hits++) {
      sys.onWreckHit(ID, BODY.x + 6, BODY.y - BODY.radius, 0, 1, 5_000, 'mining_laser');
      tick++;
    }
    return hits;
  };
  return { sys, spawned, live, woken, consumed, mine };
}

describe('field rock cut (slice 1C-b)', () => {
  it('a mining laser breaks a field rock', () => {
    const r = make();
    const hits = r.mine();
    expect(r.live.has(ID), 'the field rock broke and left').toBe(false);
    expect(hits).toBeGreaterThan(1);
    expect(r.woken.length, 'it woke as a body while mined').toBeGreaterThan(0);
    expect(new Set(r.woken)).toEqual(new Set([ID]));
    const pieces = [...r.live].filter((id) => r.spawned.has(id));
    expect(pieces.length).toBeGreaterThanOrEqual(2);
  });

  it('a broken field rock is marked consumed', () => {
    const r = make();
    r.mine();
    expect(r.consumed).toEqual([ROCK.key]);
    // Without the room's field options a field rock is never cut.
    const none = make(null);
    expect(none.mine()).toBe(400);
    expect(none.live.has(ID)).toBe(true);
    expect(none.consumed).toEqual([]);
    expect(none.woken).toEqual([]);
  });

  it('the field rock ref carries its field key', () => {
    const r = make();
    r.mine();
    const desc = r.sys.descriptors().find((d) => d.rock?.id === ID)!;
    expect(desc).toBeDefined();
    expect(desc.rock).toMatchObject({ id: ID, shape: 0, r: BODY.radius, fk: ROCK.key });
    expect(desc.rock).not.toHaveProperty('field');
    expect(WreckRockRefSchema.safeParse(desc.rock).success).toBe(true);
    // Every side rebuilds the same pieces from its own field options.
    const a = rebuildWreckPieces(desc, FIELD);
    expect(a.length).toBe([...r.live].filter((id) => r.spawned.get(id)?.wreckId === desc.wreckId).length);
    expect(rebuildWreckPieces(desc, cutFieldOpts('test-seed'))).toEqual(a);
  });
});
