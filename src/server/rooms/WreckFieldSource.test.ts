/**
 * Wreck fields slice 3b: the wreck field as a chunk source. A needed chunk
 * loads its hulls asleep through THE wreck spawn path, a hull key is live at
 * most once, untouched hulls retire after the linger, touched ones stay
 * (slice 4), the field cap makes a hull wait, and the budget units are
 * measured here against a rock chunk cut.
 */
import { describe, expect, it, vi } from 'vitest';
// WreckFieldSource restores through wreckLineageSaves, which imports the process DB: no sqlite here.
vi.mock('../db/Database.js', () => ({ db: { prepare: () => ({ run: () => ({}), get: () => null, all: () => [] }), exec: () => {} } }));
import { CapitalWreckSubsystem, type WreckPiecePose, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { FIELD_HULL_UNITS, WRECK_FIELD_ROW_VERSION, WreckFieldSource, fieldHullPieces, fieldHullUnits } from './WreckFieldSource.js';
import type { RockRecordStore, TerrainRecordRow } from '../db/terrainSql.js';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';
type TerrainRecordPutOp = Extract<PersistOp, { type: 'TERRAIN_RECORD_PUT' }>;
import { CHUNK_SIZE } from '../../core/terrain/fieldLayout.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { shipBodyMass, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { wreckField, hullsInChunk, wreckFieldHullFracture, type WreckField, type WreckFieldHull } from '../../core/terrain/wreckFieldLayout.js';
import { wreckBodyParams, wreckPieceGeometry } from '../../core/destruction/wreckPieces.js';
import { chunkKey, cutFieldOpts, fieldRockBody } from '../../core/terrain/chunkStreamer.js';
import { rocksInChunk } from '../../core/terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { GameClock } from '../../core/clock/GameClock.js';
import { placementRejection } from '../../core/structures/placementRules.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import { CutFieldSubsystem } from './CutFieldSubsystem.js';

const SIDES = ['ashen-league', 'vel-concord'] as const;
const FIELD: WreckField = wreckField({ seed: 'source', x: 0, y: 0, sides: SIDES });

/** The chunk holding the most hulls (and its hulls). */
function densest(field: WreckField): { cx: number; cy: number; hulls: readonly WreckFieldHull[] } {
  let best = { cx: 0, cy: 0, hulls: [] as readonly WreckFieldHull[] };
  for (const h of field.hulls) {
    const hs = hullsInChunk(field, h.cx, h.cy);
    if (hs.length > best.hulls.length) best = { cx: h.cx, cy: h.cy, hulls: hs };
  }
  return best;
}

/** An in-memory field partition: rows by key, every put kept. */
function memStore(rows = new Map<number, TerrainRecordRow>()) {
  const puts: TerrainRecordPutOp[] = [];
  const warns: unknown[] = [];
  const store: RockRecordStore = {
    sectorKey: 's|wrecks:source',
    load: () => [...rows.values()],
    put: (op) => {
      puts.push(op);
      rows.set(op.rockKey, { rockKey: op.rockKey, layoutVersion: op.layoutVersion, pool: op.pool, consumed: op.consumed, pose: op.pose, lineage: op.lineage ?? null });
    },
    warn: (o) => { warns.push(o); },
  };
  return { store, rows, puts, warns };
}

function make(field = FIELD, linger = 1000, mem = memStore()) {
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>();
  const awake = new Set<string>();
  const removed: string[] = [];
  const warns: unknown[] = [];
  const moved = new Map<string, { x: number; y: number }>();
  const tractored = new Set<string>();
  /** A live piece's pose as the SAB would give it (moved, angle wrapped). */
  const poseInto = (id: string, out: WreckPiecePose): boolean => {
    const s = spawned.get(id);
    if (s === undefined || !live.has(id)) return false;
    const m = moved.get(id);
    out.x = m?.x ?? s.x; out.y = m?.y ?? s.y; out.angle = Math.atan2(Math.sin(s.angle), Math.cos(s.angle));
    out.vx = 0; out.vy = 0; out.angvel = 0;
    return true;
  };
  let src: WreckFieldSource | null = null;
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 1000,
    wreckKindOf: () => 'fighter',
    positionOf: () => null,
    spawnPiece: (s) => { spawned.set(s.id, s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); removed.push(id); sys.pieceGone(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? spawned.get(id)!.angle : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: (id) => {
      const s = spawned.get(id);
      return s !== undefined && live.has(id) ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel } : null;
    },
    piecePoseInto: poseInto,
    dropSalvage: () => 'pod',
    lineageTouched: (root) => src?.touched(root),
  });
  src = new WreckFieldSource(field, {
    wrecks: () => sys,
    piecePoseInto: poseInto,
    pieceAwake: (id) => awake.has(id),
    tractored: (id) => tractored.has(id),
    warn: (o) => { warns.push(o); },
    records: mem.store,
  }, linger);
  return { sys, src, spawned, live, awake, removed, warns, moved, tractored, mem };
}

/** The live piece ids of the hull at `key` (by lineage root). */
function hullPieces(t: ReturnType<typeof make>, key: number): string[] {
  const out: string[] = [];
  for (const w of t.sys.descriptors()) {
    if (w.parentWreck !== undefined) continue;
    if (t.src.hullKeyOf(w.wreckId) === key) t.sys.forEachLineagePiece(w.wreckId, (id) => out.push(id));
  }
  return out;
}

describe('WreckFieldSource (wreck fields 3b)', () => {
  const d = densest(FIELD);
  const key = chunkKey(d.cx, d.cy);
  const needed = new Set([key]);
  const none = new Set<number>();

  it('a needed chunk loads its hulls asleep, cool, owned, at rest: piece count = the layout estimate', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const est = d.hulls.reduce((n, h) => n + wreckPieceGeometry(wreckFieldHullFracture(h)).length, 0);
    expect(d.hulls.length).toBeGreaterThan(0);
    expect(t.spawned.size).toBe(est);
    expect(t.sys.liveFieldCount()).toBe(est);
    for (const s of t.spawned.values()) {
      expect(s.sleeping).toBe(true);
      expect([s.vx, s.vy, s.angvel]).toEqual([0, 0, 0]);
    }
    const desc = t.sys.descriptors();
    for (const w of desc) {
      expect(w.deathTick).toBeUndefined();
      expect(SIDES as readonly string[]).toContain(w.owner);
    }
    expect(t.src.stats.hullsLive).toBe(d.hulls.length);
  });

  it('re-entry never double-spawns; untouched hulls retire after the linger and come back', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const n = t.spawned.size;
    t.src.step(none, 100, 500); // inside the linger: kept
    t.src.step(needed, 100, 600);
    expect(t.spawned.size).toBe(n);
    t.src.step(none, 100, 700);
    t.src.step(none, 100, 1800); // past the linger
    expect(t.removed.length).toBe(n);
    expect(t.sys.liveFieldCount()).toBe(0);
    expect(t.src.stats.hullsLive).toBe(0);
    t.src.step(needed, 100, 2000);
    expect(t.sys.liveFieldCount()).toBe(n);
  });

  it('slice 4: a touched hull unloads into ONE lineage row and reloads from it at the stored poses, never also from the seed', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const n = t.sys.liveFieldCount();
    const hk = d.hulls[0]!.key;
    const ids = hullPieces(t, hk);
    expect(ids.length).toBeGreaterThan(1);
    // Touch: move one piece, and lose another (a piece gone).
    const first = t.spawned.get(ids[0]!)!;
    t.moved.set(first.id, { x: first.x + 37, y: first.y - 11 });
    t.live.delete(ids[1]!); t.sys.pieceGone(ids[1]!);
    t.src.step(none, 100, 5000); // home chunk past the linger, no piece near
    const rows = t.mem.puts.filter((p) => p.rockKey === hk);
    expect(rows.length).toBe(1);
    expect(rows[0]!.consumed).toBe(false);
    expect(rows[0]!.layoutVersion).toBe(WRECK_FIELD_ROW_VERSION);
    expect(t.mem.puts.length).toBe(1); // untouched hulls write nothing
    expect(t.src.rowOf(hk)).toBe('lineage');
    expect(t.src.stats.hullsUnloaded).toBe(1);
    expect(t.sys.liveFieldCount()).toBe(0);
    expect(t.sys.descriptors().length).toBe(0); // no orphaned ancestor
    // Back: the touched hull comes from its row.
    const before = new Set(t.spawned.keys());
    t.src.step(needed, 100, 6000);
    expect(t.src.stats.hullsRestored).toBe(1);
    expect(t.src.stats.hullsLive).toBe(d.hulls.length);
    expect(t.sys.liveFieldCount()).toBe(n - 1); // the lost piece stays lost; no seed copy
    const back = hullPieces(t, hk);
    expect(back.length).toBe(ids.length - 1);
    for (const id of back) expect(before.has(id)).toBe(false); // fresh ids
    const at = back.map((id) => t.spawned.get(id)!);
    expect(at.some((s) => Math.abs(s.x - (first.x + 37)) < 1e-9 && Math.abs(s.y - (first.y - 11)) < 1e-9)).toBe(true);
    for (const s of at) expect(s.sleeping).toBe(true);
    for (const w of t.sys.descriptors()) expect(w.deathTick).toBeUndefined();
    // Restart: a new source reads the row back through loadRecords.
    const t2 = make(FIELD, 1000, memStore(t.mem.rows));
    t2.src.step(needed, 100, 0);
    expect(t2.src.stats.hullsRestored).toBe(1);
    expect(t2.sys.liveFieldCount()).toBe(n - 1);
  });

  it('slice 4: a held (tractored) piece, or a piece in a needed chunk, keeps the whole lineage loaded', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const hk = d.hulls[0]!.key;
    const ids = hullPieces(t, hk);
    const p0 = t.spawned.get(ids[0]!)!;
    t.moved.set(p0.id, { x: p0.x + 5, y: p0.y });
    t.tractored.add(p0.id);
    t.src.step(none, 100, 5000);
    t.src.step(none, 100, 9000);
    expect(hullPieces(t, hk).length).toBe(ids.length);
    expect(t.mem.puts.length).toBe(0);
    // Let go, but the piece now lies in another chunk a ship needs.
    t.tractored.delete(p0.id);
    const far = { x: (d.cx + 6.5) * CHUNK_SIZE, y: (d.cy + 0.5) * CHUNK_SIZE };
    t.moved.set(p0.id, far);
    const farNeeded = new Set([chunkKey(d.cx + 6, d.cy)]);
    t.src.step(farNeeded, 100, 12000);
    t.src.step(farNeeded, 100, 20000);
    expect(hullPieces(t, hk).length).toBe(ids.length);
    // Nothing near for the linger: it unloads.
    t.src.step(none, 100, 20500);
    expect(hullPieces(t, hk).length).toBe(ids.length);
    t.src.step(none, 100, 21100);
    expect(hullPieces(t, hk).length).toBe(0);
    expect(t.src.rowOf(hk)).toBe('lineage');
  });

  it('slice 4: a fully consumed hull writes a consumed row at once and never comes back', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const hk = d.hulls[0]!.key;
    for (const id of hullPieces(t, hk)) { t.live.delete(id); t.sys.pieceGone(id); }
    t.src.step(needed, 100, 100);
    expect(t.src.rowOf(hk)).toBe('consumed');
    const row = t.mem.puts.find((p) => p.rockKey === hk)!;
    expect(row.consumed).toBe(true);
    expect(row.lineage ?? null).toBeNull();
    expect(t.src.stats.hullsConsumed).toBe(1);
    t.src.step(none, 100, 5000);
    t.src.step(needed, 100, 6000);
    expect(t.src.stats.hullsLive).toBe(d.hulls.length - 1);
    expect(hullPieces(t, hk).length).toBe(0);
  });

  it('slice 4: a stale-version row is ignored with a warning (the seed hull spawns)', () => {
    const rows = new Map<number, TerrainRecordRow>();
    const hk = d.hulls[0]!.key;
    rows.set(hk, { rockKey: hk, layoutVersion: WRECK_FIELD_ROW_VERSION - 1, pool: null, consumed: true, pose: null, lineage: null });
    const mem = memStore(rows);
    const t = make(FIELD, 1000, mem);
    expect(mem.warns.length).toBe(1);
    t.src.step(needed, 100, 0);
    expect(t.src.stats.hullsLive).toBe(d.hulls.length);
  });

  it('owner Q2 print: the speed a fighter ram gives a capital-section field piece and a fighter-sized piece', () => {
    const fighter = getShipKind('fighter');
    const mF = shipBodyMass(fighter), vF = fighter.maxSpeed;
    // Rapier averages restitution: ship colliders 0.3, wreck-piece (obstacle) colliders 0.8.
    const e = (0.3 + 0.8) / 2;
    const dv = (mP: number) => ((1 + e) * mF * vF) / (mF + mP);
    const cap = FIELD.hulls.find((h) => getShipKind(h.kindId).sizeClass === 'capital');
    const fig = FIELD.hulls.find((h) => fieldHullUnits(h.kindId) === FIELD_HULL_UNITS.fighter);
    const line = (label: string, h: WreckFieldHull | undefined, pick: 'max' | 'min') => {
      if (h === undefined) return `${label}: none in this field`;
      const ps = fieldHullPieces(h).pieces;
      const p = ps.reduce((a, b) => ((pick === 'max' ? b.mass > a.mass : b.mass < a.mass) ? b : a));
      const body = wreckBodyParams(h.kindId);
      const tn = shipTuning(getShipKind(h.kindId));
      return `${label} (${h.kindId}, piece mass ${p.mass.toFixed(1)}): ram dv ${dv(p.mass).toFixed(2)} u/s; settle-to-sleep ${body.settleSpeed.toFixed(2)} u/s; hit wakeDv ${(DESTRUCTION_PROFILES[tn.destruction].knockWakeScale * tn.wreckKnockMax).toFixed(2)} u/s`;
    };
    console.log(`[wreck-field Q2] fighter mass ${mF.toFixed(2)} at top speed ${vF.toFixed(1)} u/s, restitution ${e}; ${line('capital section', cap, 'max')}; ${line('fighter-sized piece', fig, 'max')}`);
    expect(mF).toBeGreaterThan(0);
  });

  it('the field cap makes a hull wait (sampled warn), and it loads once there is room', () => {
    const t = make();
    t.sys.fieldCapOverride = 1;
    t.src.step(needed, 100, 0);
    expect(t.spawned.size).toBe(0);
    expect(t.src.stats.capRefusals).toBeGreaterThan(0);
    expect(t.warns.length).toBe(1);
    t.sys.fieldCapOverride = undefined;
    t.src.step(needed, 100, 1000); // still waiting
    expect(t.spawned.size).toBe(0);
    t.src.step(needed, 100, 2500);
    expect(t.src.stats.hullsLive).toBe(d.hulls.length);
  });

  it('a step spends at most the budget (one hull always goes)', () => {
    const t = make();
    const spent = t.src.step(needed, 0.05, 0);
    expect(spent).toBeLessThanOrEqual(0.05);
    expect(t.src.stats.hullsLive).toBe(1);
    expect(t.src.step(needed, 0, 1)).toBe(0);
    expect(t.src.stats.hullsLive).toBe(1);
  });

  it('budget units: a field hull load vs a rock chunk cut (print; units derived from it)', () => {
    const p50 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const opts = cutFieldOpts('look');
    const rock: number[] = [];
    let rocks = 0;
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const cut = rocksInChunk(opts, 13 + (i % 5), Math.floor(i / 5) - 2) // around x 60 000: inside the ring (cutFieldStreaming);
      for (const r of cut) fieldRockBody(r);
      rock.push(performance.now() - t0);
      rocks += cut.length;
    }
    const byClass: Record<keyof typeof FIELD_HULL_UNITS, number[]> = { capital: [], subcap: [], fighter: [] };
    for (const h of FIELD.hulls) {
      const k = getShipKind(h.kindId);
      const cls = k.sizeClass === 'capital' ? 'capital' : fieldHullUnits(h.kindId) === FIELD_HULL_UNITS.subcap ? 'subcap' : 'fighter';
      if (byClass[cls].length >= 24) continue;
      const t = make();
      const t0 = performance.now();
      const { pieces, fracture } = fieldHullPieces(h);
      t.sys.spawnWreck(h.kindId, 'm', pieces, fracture, k.maxHealth, h.angle, { held: false, origin: 'field', sleeping: true, cool: true, owner: h.owner });
      byClass[cls].push(performance.now() - t0);
    }
    const r = p50(rock);
    const line = (c: keyof typeof FIELD_HULL_UNITS) => {
      const xs = byClass[c];
      return xs.length === 0 ? `${c}: none` : `${c}: p50 ${p50(xs).toFixed(2)} ms = ${(p50(xs) / r).toFixed(2)} units (set ${FIELD_HULL_UNITS[c]}, n=${xs.length})`;
    };
    console.log(`[wreck-field budget] rock chunk cut p50 ${r.toFixed(2)} ms = 1 unit (${rocks} rocks in 25 chunks); ${line('capital')}; ${line('subcap')}; ${line('fighter')}`);
    expect(rocks).toBeGreaterThan(0);
  });
});

describe('WreckFieldSource.dormantObstacles (wreck fields 7: placement sees unloaded hulls)', () => {
  const d = densest(FIELD);
  const needed = new Set([chunkKey(d.cx, d.cy)]);
  const none = new Set<number>();
  const hull = d.hulls.reduce((a, b) => (b.footprint > a.footprint ? b : a));
  const box = (x: number, y: number, r = 10) => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  /** The one-streamer host with the field as its only source. */
  function host(src: WreckFieldSource) {
    const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
    const registry = { get: () => null, all: () => [] } as unknown as SwarmEntityRegistry;
    return new CutFieldSubsystem(null, clock, registry, {} as SwarmSpawner, {
      shipSlots: () => [], sab: () => new Float32Array(0), post: () => {}, evict: () => {}, broadcast: () => {},
    }, undefined, [src]);
  }

  it('a far placement over an UNLOADED hull is refused through the host query (wrecks on only); clear beside it is accepted', () => {
    const t = make();
    const seed = fieldHullPieces(hull).pieces;
    const big = seed.reduce((a, b) => (b.radius > a.radius ? b : a));
    const out: GridObstacle[] = [];
    host(t.src).dormantObstacles(box(big.x, big.y), out, true);
    expect(out).toContainEqual(expect.objectContaining({ x: big.x, y: big.y, radius: big.radius, angle: big.angle }));
    expect(out.find((o) => o.x === big.x)!.parts).toEqual(big.parts);
    expect(placementRejection('connector', big.x, big.y, [], out)).toBe('overlap-obstacle');
    // Wrecks off (link line of sight, landing): the host gives no hull.
    const off: GridObstacle[] = [];
    host(t.src).dormantObstacles(box(big.x, big.y), off);
    expect(off).toEqual([]);
    // Clear of every hull's footprint: nothing, and the placement stands.
    const far = { x: FIELD.x + 400_000, y: FIELD.y + 400_000 };
    const clear: GridObstacle[] = [];
    host(t.src).dormantObstacles(box(far.x, far.y, 200), clear, true);
    expect(clear).toEqual([]);
    expect(placementRejection('connector', far.x, far.y, [], clear)).toBeNull();
    console.log(`[wreck-fields 7] dormant hull ${hull.kindId}: ${seed.length} piece(s), ${out.length} reach the box`);
    // Cost of one placement query over an unloaded capital hull (seed fracture per call).
    const cap = FIELD.hulls.find((h) => getShipKind(h.kindId).sizeClass === 'capital')!;
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) { const t0 = performance.now(); t.src.dormantObstacles(box(cap.x, cap.y, 200), []); ms.push(performance.now() - t0); }
    ms.sort((p, q) => p - q);
    console.log(`[wreck-fields 7] placement query over an unloaded ${cap.kindId}: p50 ${ms[4]!.toFixed(2)} ms`);
  });

  it('a loaded hull gives nothing (its live pieces are already obstacles); a consumed one nothing; a saved one its row poses', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const near = box(hull.x, hull.y, hull.footprint);
    const live: GridObstacle[] = [];
    t.src.dormantObstacles(near, live);
    expect(live).toEqual([]);
    // Touch (move a piece) and unload: a lineage row at the moved pose.
    const ids = hullPieces(t, hull.key);
    const first = t.spawned.get(ids[0]!)!;
    t.moved.set(first.id, { x: first.x + 37, y: first.y - 11 });
    t.src.touched(t.sys.descriptors().find((w) => t.src.hullKeyOf(w.wreckId) === hull.key)!.wreckId);
    t.src.step(none, 100, 5000);
    expect(t.src.rowOf(hull.key)).toBe('lineage');
    const saved: GridObstacle[] = [];
    t.src.dormantObstacles(near, saved);
    const mine = saved.filter((o) => Math.hypot(o.x - hull.x, o.y - hull.y) < hull.footprint);
    expect(mine.length).toBe(ids.length);
    expect(mine.some((o) => Math.abs(o.x - (first.x + 37)) < 1e-9 && Math.abs(o.y - (first.y - 11)) < 1e-9)).toBe(true);
    // Every piece gone: consumed, nothing.
    const t2 = make();
    t2.src.step(needed, 100, 0);
    for (const id of hullPieces(t2, hull.key)) { t2.live.delete(id); t2.sys.pieceGone(id); }
    t2.src.step(none, 100, 5000);
    expect(t2.src.rowOf(hull.key)).toBe('consumed');
    const gone: GridObstacle[] = [];
    t2.src.dormantObstacles(near, gone);
    expect(gone.filter((o) => Math.hypot(o.x - hull.x, o.y - hull.y) < hull.footprint * 0.5)).toEqual([]);
  });
});
