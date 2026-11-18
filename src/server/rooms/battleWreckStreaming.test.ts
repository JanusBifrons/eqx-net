/**
 * Wreck fields 0b (owner Q3 "keep it all"; capital-destruction.md "Battle
 * wrecks stream"): battle lineages are a chunk source of the room's one
 * streamer. No ship near ⇒ retired to its row after the linger; a ship near
 * ⇒ back at the same poses with fresh ids; a tractored piece keeps it; the
 * battle FIFO eviction retires to the row instead of deleting; boot loads
 * only the lineages near ships.
 */
import { describe, expect, it, vi } from 'vitest';
// wreckLineageSaves imports the process DB: no sqlite here.
vi.mock('../db/Database.js', () => ({ db: { prepare: () => ({ run: () => ({}), get: () => null, all: () => [] }), exec: () => {} } }));
import { CapitalWreckSubsystem, type WreckPiecePose, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { BattleWreckSaves } from './wreckLineageSaves.js';
import { lineageRowKey, type TerrainRecordStore } from '../db/terrainSql.js';
import { buildWreckPieces } from '../../core/destruction/wreckPieces.js';
import { chunkKey } from '../../core/terrain/chunkStreamer.js';
import { CHUNK_SIZE } from '../../core/terrain/fieldLayout.js';
import { fieldHullUnits, parseLineageJson } from './wreckLineageStream.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';

const LINGER = 1000;

/** An in-memory battle partition. */
function memStore(rows = new Map<number, string>()) {
  let next = 1;
  for (const k of rows.keys()) next = Math.max(next, k + 1);
  const deleted: number[] = [];
  const store: TerrainRecordStore = {
    sectorKey: 's|battle',
    load: () => [],
    put: () => {},
    warn: () => {},
    nextLineageSerial: () => next++,
    putLineage: (serial, json) => { rows.set(serial, json); },
    deleteRecord: (key) => { deleted.push(key); for (const s of rows.keys()) if (lineageRowKey(s) === key) rows.delete(s); },
    lineages: () => [...rows].map(([serial, json]) => ({ serial, json })),
  };
  return { store, rows, deleted };
}

function make(mem = memStore(), streaming = true) {
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>();
  const removed: string[] = [];
  const tractored = new Set<string>();
  const poseInto = (id: string, out: WreckPiecePose): boolean => {
    const s = spawned.get(id);
    if (s === undefined || !live.has(id)) return false;
    out.x = s.x; out.y = s.y; out.angle = s.angle; out.vx = 0; out.vy = 0; out.angvel = 0;
    return true;
  };
  let saves: BattleWreckSaves | null = null;
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
    pieceAsleep: () => true,
    lineageTouched: (root) => saves?.touch(root),
    evictRetire: (id) => saves?.evictPiece(id) ?? false,
  });
  saves = new BattleWreckSaves(() => sys.lineageState(), mem.store, { piecePoseInto: poseInto, tractored: (id) => tractored.has(id), streaming, lingerMs: LINGER });
  let n = 0;
  /** A battle hull of `kind` broken at (x, y), at rest (no held kick). */
  const lay = (kind: ShipKindId, x: number, y: number): string[] => {
    const before = new Set(spawned.keys());
    const pose = { x, y, vx: 0, vy: 0, angle: 0.3, angvel: 0 };
    const { pieces, fracture } = buildWreckPieces({ kindId: kind, pose, killWorld: null, attackerWorld: null, seed: 7 + n++, killBlowDamage: 0.5, recentDamageRate: 0.5 });
    for (const p of pieces) { p.vx = 0; p.vy = 0; p.angvel = 0; p.kickVx = 0; p.kickVy = 0; p.kickAngvel = 0; }
    sys.spawnWreck(kind, `h${n}`, pieces, fracture, 1000, pose.angle, { held: false });
    return [...spawned.keys()].filter((k) => !before.has(k) && live.has(k));
  };
  /** Live battle pieces as (wreck seed:piece index) → pose. */
  const table = () => {
    const seedOf = new Map(sys.descriptors().map((d) => [d.wreckId, d.seed]));
    const out = new Map<string, { x: number; y: number; angle: number; id: string }>();
    for (const id of live) {
      const s = spawned.get(id)!;
      out.set(`${seedOf.get(s.wreckId)}:${s.pieceIndex}`, { x: s.x, y: s.y, angle: s.angle, id });
    }
    return out;
  };
  return { sys, saves, mem, spawned, live, removed, tractored, lay, table };
}

const chunkAt = (x: number, y: number) => chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
const NONE = new Set<number>();
const X = 2.5 * CHUNK_SIZE, Y = 0.5 * CHUNK_SIZE;
/** A ship's 5 x 5 chunk ring around the wreck. */
const near = (): Set<number> => {
  const out = new Set<number>();
  const cx = Math.floor(X / CHUNK_SIZE), cy = Math.floor(Y / CHUNK_SIZE);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) out.add(chunkKey(cx + dx, cy + dy));
  return out;
};

describe('battle wrecks stream (wreck fields 0b)', () => {
  it('no ship near: retired to its row after the linger; a ship near: back at the same poses with fresh ids', () => {
    const t = make();
    const ids = t.lay('destroyer', X, Y);
    expect(ids.length).toBeGreaterThan(1);
    const before = t.table();
    t.saves.step(near(), 4, 0);
    t.saves.step(NONE, 4, 500);
    expect(t.live.size, 'still inside the linger').toBe(ids.length);
    t.saves.step(NONE, 4, 500 + LINGER);
    expect(t.live.size, 'retired').toBe(0);
    expect(t.sys.descriptors()).toHaveLength(0);
    expect(t.mem.rows.size, 'one row kept').toBe(1);
    const rec = parseLineageJson([...t.mem.rows.values()][0]!).rec!;
    expect(rec.pieces).toHaveLength(ids.length);
    expect(t.saves.savedUnloaded()).toBe(1);
    expect(t.saves.stats.retired).toBe(1);

    // Far chunks: nothing comes back.
    t.saves.step(new Set([chunkAt(X + 20 * CHUNK_SIZE, Y)]), 4, 3000);
    expect(t.live.size).toBe(0);
    // A ship near: the lineage returns where it was, with fresh ids.
    t.saves.step(near(), 4, 3500);
    const after = t.table();
    expect(after.size).toBe(before.size);
    for (const [k, b] of before) {
      const a = after.get(k)!;
      expect(a, `piece ${k}`).toBeDefined();
      expect(a.id).not.toBe(b.id);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
      expect(Math.abs(a.angle - b.angle)).toBeLessThan(1e-6);
    }
    expect(t.saves.savedUnloaded()).toBe(0);
    expect(t.saves.stats.restored).toBe(1);
    expect(t.mem.rows.size, 'the row keeps its serial').toBe(1);
    // Restored ids are fresh: a second retire overwrites the same row.
    t.saves.step(NONE, 4, 3500 + LINGER);
    expect(t.live.size).toBe(0);
    expect(t.mem.rows.size).toBe(1);
  });

  it('a restore counts work units: a budget of one destroyer restores one per step', () => {
    const t = make();
    t.lay('destroyer', X, Y);
    t.lay('destroyer', X + 300, Y);
    t.saves.step(NONE, 4, 0);
    t.saves.step(NONE, 4, LINGER);
    expect(t.saves.savedUnloaded()).toBe(2);
    t.saves.step(near(), fieldHullUnits('destroyer'), 2000);
    expect(t.saves.stats.restored).toBe(1);
    expect(t.saves.stats.unitsThisStep).toBeGreaterThan(0);
    t.saves.step(near(), fieldHullUnits('destroyer'), 2250);
    expect(t.saves.stats.restored).toBe(2);
  });

  it('a tractored piece keeps its whole lineage loaded', () => {
    const t = make();
    const ids = t.lay('destroyer', X, Y);
    t.tractored.add(ids[0]!);
    t.saves.step(NONE, 4, 0);
    t.saves.step(NONE, 4, 5 * LINGER);
    expect(t.live.size).toBe(ids.length);
    t.tractored.clear();
    t.saves.step(NONE, 4, 6 * LINGER);
    t.saves.step(NONE, 4, 7 * LINGER);
    expect(t.live.size).toBe(0);
  });

  it('streaming: the battle FIFO eviction retires the oldest lineage to its row (nothing deleted for good)', () => {
    const t = make();
    t.sys.subcapCapOverride = 4;
    const a = t.lay('fighter', X, Y);
    t.lay('fighter', X + 500, Y);
    t.lay('fighter', X + 1000, Y);
    expect(t.sys.liveSubcapCount()).toBeLessThanOrEqual(4);
    expect(a.some((id) => t.live.has(id)), 'the oldest lineage left').toBe(false);
    expect(t.saves.stats.evicted).toBeGreaterThan(0);
    expect(t.mem.deleted).toHaveLength(0);
    const saved = [...t.mem.rows.values()].reduce((n, j) => n + parseLineageJson(j).rec!.pieces.length, 0);
    expect(saved + t.sys.liveSubcapCount(), 'saved + live = every piece').toBe(t.spawned.size);
    // A ship near waits while the cap is full, so no restore evicts.
    t.saves.step(near(), 4, 0);
    expect(t.saves.stats.capWaits).toBeGreaterThan(0);
    expect(t.sys.liveSubcapCount()).toBeLessThanOrEqual(4);
  });

  it('not streaming (a test room): eviction deletes, as before', () => {
    const t = make(memStore(), false);
    t.sys.subcapCapOverride = 3;
    for (let i = 0; i < 4; i++) t.lay('fighter', X + 500 * i, Y);
    expect(t.sys.liveSubcapCount()).toBe(3);
    expect(t.saves.stats.evicted).toBe(0);
    expect(t.mem.rows.size).toBe(0);
  });

  it('boot loads only the lineages near ships', () => {
    const first = make();
    first.lay('destroyer', X, Y);
    first.lay('destroyer', X + 40 * CHUNK_SIZE, Y);
    first.saves.flush(true);
    expect(first.mem.rows.size).toBe(2);

    const t = make(memStore(new Map(first.mem.rows)));
    expect(t.saves.loadRows()).toBe(2);
    expect(t.live.size, 'nothing at boot').toBe(0);
    t.saves.step(near(), 4, 0);
    expect(t.saves.stats.restored).toBe(1);
    expect(t.saves.savedUnloaded()).toBe(1);
    for (const id of t.live) expect(Math.abs(t.spawned.get(id)!.x - X)).toBeLessThan(CHUNK_SIZE);

    // Not streaming: every row at boot (test rooms, unchanged).
    const all = make(memStore(new Map(first.mem.rows)), false);
    expect(all.saves.loadRows()).toBe(2);
    expect(all.live.size).toBe(first.live.size);
  });
});
