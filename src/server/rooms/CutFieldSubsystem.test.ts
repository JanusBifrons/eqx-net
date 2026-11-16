import { describe, expect, it } from 'vitest';
import type { GameClock } from '../../core/clock/GameClock.js';
import { FIELD_WAKES_PER_TICK, cutFieldOpts, fieldRockBody, fieldRockId } from '../../core/terrain/chunkStreamer.js';
import { placementRejection } from '../../core/structures/placementRules.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { CutFieldSubsystem, toRestFrame } from './CutFieldSubsystem.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { FIELD_LAYOUT_VERSION, rocksInChunk } from '../../core/terrain/fieldLayout.js';
import type { TerrainRecordRow, TerrainRecordStore } from '../db/terrainSql.js';

function setup(recs: Record<string, Partial<SwarmEntityRecord>>) {
  const posted: WorkerCmd[] = [];
  const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
  const registry = { get: (id: string) => (recs[id] as SwarmEntityRecord | undefined) ?? null, all: () => [] } as unknown as SwarmEntityRegistry;
  const sub = new CutFieldSubsystem('t', clock, registry, {} as SwarmSpawner, {
    shipSlots: () => [], sab: () => new Float32Array(0), post: (c) => posted.push(c), evict: () => {}, broadcast: () => {},
  });
  return { sub, posted };
}

describe('CutFieldSubsystem.wakeRock (a mining laser waking a field rock)', () => {
  it('wakes a sleeping field rock once and unfixes its body', () => {
    const recs: Record<string, Partial<SwarmEntityRecord>> = { r: { fieldRock: true } };
    const { sub, posted } = setup(recs);
    expect(sub.wakeRock('r', 'laser', 1)).toBe(true);
    expect(recs['r']!.fieldAwake).toBe(true);
    expect(sub.wakeRock('r', 'laser', 1)).toBe(true);
    expect(posted).toEqual([{ type: 'UNFIX_BODY', entityId: 'r' }]);
  });

  it('refuses anything that is not a field rock', () => {
    const { sub, posted } = setup({ a: {} });
    expect(sub.wakeRock('a', 'laser', 1)).toBe(false);
    expect(sub.wakeRock('missing', 'laser', 1)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('shares the per-tick wake cap, and the next tick wakes again', () => {
    const recs: Record<string, Partial<SwarmEntityRecord>> = {};
    for (let i = 0; i <= FIELD_WAKES_PER_TICK; i++) recs[`r${i}`] = { fieldRock: true };
    const { sub } = setup(recs);
    for (let i = 0; i < FIELD_WAKES_PER_TICK; i++) expect(sub.wakeRock(`r${i}`, 'laser', 5)).toBe(true);
    expect(sub.wakeRock(`r${FIELD_WAKES_PER_TICK}`, 'laser', 5)).toBe(false);
    expect(sub.wakeRock(`r${FIELD_WAKES_PER_TICK}`, 'laser', 6)).toBe(true);
  });
});

describe('toRestFrame (F1b: an awake rock samples its ore where it was cut)', () => {
  it('maps a point on a moved, turned rock back onto the same spot of the rock as cut', () => {
    const rest = { x: 1_000, y: -500 }, local = { x: 30, y: -12 };
    const pose = { x: 1_340, y: -260 }, a = 0.9;
    // The point `local` on the rock, in the world after the rock moved and turned by `a`.
    const wx = pose.x + local.x * Math.cos(a) - local.y * Math.sin(a);
    const wy = pose.y + local.x * Math.sin(a) + local.y * Math.cos(a);
    const p = toRestFrame(rest.x, rest.y, pose.x, pose.y, a, wx, wy, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(rest.x + local.x, 9);
    expect(p.y).toBeCloseTo(rest.y + local.y, 9);
  });

  it('is the identity for a rock still at rest', () => {
    expect(toRestFrame(5, 6, 5, 6, 0, 17, -3, { x: 0, y: 0 })).toEqual({ x: 17, y: -3 });
  });
});

describe('CutFieldSubsystem change record (mined pool, consumed rocks)', () => {
  /** A real streamer over a fake spawner: one ship in the `look` field's lane,
   *  flown away (its chunks unload after the linger) and back (they re-cut). */
  function field(store?: TerrainRecordStore) {
    let now = 0;
    const recs = new Map<string, SwarmEntityRecord>();
    const sent: number[] = [];
    const sab = new Float32Array(slotBase(1));
    const clock = { now: () => now, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
    const registry = { get: (id: string) => recs.get(id) ?? null, all: () => [] } as unknown as SwarmEntityRegistry;
    const spawner = {
      spawnAsteroid: (a: { id: string; fieldKey: number }) => {
        recs.set(a.id, { id: a.id, fieldRock: true, fieldKey: a.fieldKey, resources: 100, resourcesMax: 100 } as SwarmEntityRecord);
        return true;
      },
    } as unknown as SwarmSpawner;
    const sub = new CutFieldSubsystem('look', clock, registry, spawner, {
      shipSlots: () => [0], sab: () => sab, post: () => {}, evict: (rec) => { recs.delete(rec.id); }, broadcast: (_t, m) => { sent.push(m.k); }, records: store,
    });
    const at = (x: number, y: number) => { sab[slotBase(0) + SLOT_X_OFF] = x; sab[slotBase(0) + SLOT_Y_OFF] = y; };
    const settle = () => { for (let i = 0; i < 40; i++) sub.streamer.step(); };
    const away = () => { at(9e6, 9e6); now += 60_000; settle(); };
    const back = () => { at(-30_120, 26_501); now += 1; settle(); };
    /** Fly away until everything unloads, then come back and re-cut. */
    const awayAndBack = () => {
      away();
      expect(recs.size, 'all chunks unloaded').toBe(0);
      back();
    };
    at(-30_120, 26_501); settle();
    return { sub, recs, sent, away, back, awayAndBack, byKey: (k: number) => [...recs.values()].find((r) => r.fieldKey === k) };
  }

  /** C4 — a save (`terrain_records`) holding `rows`; records what the field
   *  writes and warns. */
  function store(rows: TerrainRecordRow[] = []) {
    const puts: PersistOp[] = [];
    const warns: unknown[] = [];
    const s: TerrainRecordStore = { sectorKey: 'sec', load: () => rows, put: (op) => { puts.push(op); }, warn: (f) => { warns.push(f); } };
    return { s, puts, warns };
  }

  it('a mined rock keeps what is left in it across an unload and re-cut', () => {
    const { recs, awayAndBack } = field();
    const [mined, untouched] = [...recs.values()];
    expect(mined && untouched).toBeTruthy();
    mined!.resources = 37;
    awayAndBack();
    expect(recs.get(mined!.id)!.resources).toBe(37);
    expect(recs.get(untouched!.id)!.resources).toBe(100);
  });

  it('a consumed rock is never cut whole again', () => {
    const { sub, recs, sent, awayAndBack } = field();
    const gone = [...recs.values()][0]!;
    expect(sub.welcome).toEqual({ cutField: { seed: 'look' } });
    sub.markConsumed(gone.fieldKey!);
    sub.markConsumed(gone.fieldKey!);
    expect(sub.isConsumed(gone.fieldKey!)).toBe(true);
    // Clients hear it once now (field_consumed), and a joiner from the welcome (#16).
    expect(sent).toEqual([gone.fieldKey]);
    expect(sub.welcome).toEqual({ cutField: { seed: 'look', consumed: [gone.fieldKey] } });
    const before = recs.size;
    awayAndBack();
    expect(recs.has(gone.id)).toBe(false);
    expect(recs.size).toBe(before - 1);
  });

  it('markConsumed saves the rock once, consumed with no pool', () => {
    const st = store();
    const { sub, recs } = field(st.s);
    const key = [...recs.values()][0]!.fieldKey!;
    sub.markConsumed(key);
    sub.markConsumed(key);
    expect(st.puts).toEqual([{ type: 'TERRAIN_RECORD_PUT', sectorKey: 'sec', rockKey: key, layoutVersion: FIELD_LAYOUT_VERSION, pool: null, consumed: true, ts: 0 }]);
  });

  it('a mined rock is saved when its chunk unloads, and only when its pool changed', () => {
    const st = store();
    const { recs, away, back } = field(st.s);
    const [mined] = [...recs.values()];
    mined!.resources = 37;
    away();
    expect(st.puts).toEqual([{ type: 'TERRAIN_RECORD_PUT', sectorKey: 'sec', rockKey: mined!.fieldKey, layoutVersion: FIELD_LAYOUT_VERSION, pool: 37, consumed: false, ts: 60_000 }]);
    back(); away(); // re-cut at 37, untouched, unloaded again: nothing new to save
    expect(st.puts).toHaveLength(1);
    expect(st.warns).toEqual([]);
  });

  it('a field started from a save refuses its consumed rocks and caps a mined rock (a restart)', () => {
    const first = field();
    const [gone, mined, other] = [...first.recs.values()];
    first.sub.dispose();
    const st = store([
      { rockKey: gone!.fieldKey!, layoutVersion: FIELD_LAYOUT_VERSION, pool: null, consumed: true },
      { rockKey: mined!.fieldKey!, layoutVersion: FIELD_LAYOUT_VERSION, pool: 12, consumed: false },
    ]);
    const { sub, recs, byKey } = field(st.s);
    expect(sub.isConsumed(gone!.fieldKey!)).toBe(true);
    expect(byKey(gone!.fieldKey!)).toBeUndefined();
    expect(byKey(mined!.fieldKey!)!.resources).toBe(12);
    expect(byKey(other!.fieldKey!)!.resources).toBe(100);
    expect(recs.size).toBe(first.recs.size - 1);
    // The loaded consumed keys reach joiners through the welcome.
    expect(sub.welcome).toEqual({ cutField: { seed: 'look', consumed: [gone!.fieldKey] } });
    expect(st.puts).toEqual([]);
  });

  it('rows from another field layout are ignored, with one warning', () => {
    const first = field();
    const [a, b] = [...first.recs.values()];
    const st = store([
      { rockKey: a!.fieldKey!, layoutVersion: FIELD_LAYOUT_VERSION + 1, pool: null, consumed: true },
      { rockKey: b!.fieldKey!, layoutVersion: FIELD_LAYOUT_VERSION - 1, pool: 5, consumed: false },
    ]);
    const { sub, byKey } = field(st.s);
    expect(sub.isConsumed(a!.fieldKey!)).toBe(false);
    expect(byKey(a!.fieldKey!)).toBeDefined();
    expect(byKey(b!.fieldKey!)!.resources).toBe(100);
    expect(st.warns).toEqual([{ sectorKey: 'sec', stale: 2, layoutVersion: FIELD_LAYOUT_VERSION }]);
  });
});

describe('CutFieldSubsystem.oreAtRest (pieces of a broken-up rock)', () => {
  it('samples the field where the point was before the piece moved', async () => {
    const { oreAt, oreSeed } = await import('../../core/terrain/fieldOre.js');
    const { SLICED } = await import('../../core/terrain/fieldLayout.js');
    const { sub } = setup({});
    // A point that holds ore in field 't' (search the field near its centre).
    let rx = 0, ry = 0, best = -1;
    const c = { ice: 0, crystal: 0 };
    for (let x = -60_000; x <= 60_000; x += 1_500) for (let y = -60_000; y <= 60_000; y += 1_500) {
      oreAt(oreSeed('t'), SLICED.radius, x, y, c);
      if (c.ice + c.crystal > best) { best = c.ice + c.crystal; rx = x; ry = y; }
    }
    expect(best).toBeGreaterThan(0.2);
    const want = oreAt(oreSeed('t'), SLICED.radius, rx, ry, { ice: 0, crystal: 0 });
    // The parent's rest centre sits (100, -70) from that point. It now sits at
    // (500, 500), turned +90°, so the rest offset (-100, 70) is world (-70, -100).
    const got = sub.oreAtRest(rx + 100, ry - 70, 500, 500, Math.PI / 2, 430, 400, { ice: 0, crystal: 0 });
    // Unturned, the same world point samples somewhere else.
    const wrong = sub.oreAtRest(rx + 100, ry - 70, 500, 500, 0, 430, 400, { ice: 0, crystal: 0 });
    expect(wrong.ice + wrong.crystal).not.toBeCloseTo(best, 6);
    expect(got.ice).toBeCloseTo(want.ice, 9);
    expect(got.crystal).toBeCloseTo(want.crystal, 9);
  });
});

describe('CutFieldSubsystem.dormantObstacles (C5: placement sees unloaded field rocks)', () => {
  const o = cutFieldOpts('look');
  const rock = rocksInChunk(o, -8, 6).reduce((a, b) => (b.size > a.size ? b : a));
  const body = fieldRockBody(rock);
  const box = { x0: body.x - 100, y0: body.y - 100, x1: body.x + 100, y1: body.y + 100 };
  function sub(live: Set<string>) {
    const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
    const registry = { get: (id: string) => (live.has(id) ? ({ id } as SwarmEntityRecord) : null), all: () => [] } as unknown as SwarmEntityRegistry;
    return new CutFieldSubsystem('look', clock, registry, {} as SwarmSpawner, {
      shipSlots: () => [], sab: () => new Float32Array(0), post: () => {}, evict: () => {}, broadcast: () => {},
    });
  }

  it('gives a rock with no body as an obstacle, so placement on it is refused', () => {
    const out: GridObstacle[] = [];
    sub(new Set()).dormantObstacles(box, out);
    expect(out).toContainEqual({ x: body.x, y: body.y, radius: body.radius });
    expect(placementRejection('capital', body.x, body.y, [], out)).toBe('overlap-obstacle');
  });

  it('skips a broken-up rock and a live one (the registry already gives it)', () => {
    const s = sub(new Set());
    s.markConsumed(rock.key);
    const consumed: GridObstacle[] = [];
    s.dormantObstacles(box, consumed);
    expect(consumed).not.toContainEqual({ x: body.x, y: body.y, radius: body.radius });
    const live: GridObstacle[] = [];
    sub(new Set([fieldRockId(rock.key)])).dormantObstacles(box, live);
    expect(live).not.toContainEqual({ x: body.x, y: body.y, radius: body.radius });
  });
});
