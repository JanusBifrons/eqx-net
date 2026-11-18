/**
 * Wreck fields slice 3b: the wreck field as a chunk source. A needed chunk
 * loads its hulls asleep through THE wreck spawn path, a hull key is live at
 * most once, untouched hulls retire after the linger, touched ones stay
 * (slice 4), the field cap makes a hull wait, and the budget units are
 * measured here against a rock chunk cut.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { FIELD_HULL_UNITS, WreckFieldSource, fieldHullPieces, fieldHullUnits } from './WreckFieldSource.js';
import { wreckField, hullsInChunk, wreckFieldHullFracture, type WreckField, type WreckFieldHull } from '../../core/terrain/wreckFieldLayout.js';
import { wreckPieceGeometry } from '../../core/destruction/wreckPieces.js';
import { chunkKey, cutFieldOpts, fieldRockBody } from '../../core/terrain/chunkStreamer.js';
import { rocksInChunk } from '../../core/terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

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

function make(field = FIELD, linger = 1000) {
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>();
  const awake = new Set<string>();
  const removed: string[] = [];
  const warns: unknown[] = [];
  const moved = new Map<string, { x: number; y: number }>();
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
    dropSalvage: () => 'pod',
    lineageTouched: (root) => src?.touched(root),
  });
  src = new WreckFieldSource(field, {
    wrecks: () => sys,
    piecePoseInto: (id, out) => {
      const s = spawned.get(id);
      if (s === undefined || !live.has(id)) return false;
      const m = moved.get(id);
      out.x = m?.x ?? s.x; out.y = m?.y ?? s.y; out.angle = Math.atan2(Math.sin(s.angle), Math.cos(s.angle)); // wrapped, as the SAB out.vx = 0; out.vy = 0; out.angvel = 0;
      return true;
    },
    pieceAwake: (id) => awake.has(id),
    warn: (o) => { warns.push(o); },
  }, linger);
  return { sys, src, spawned, live, awake, removed, warns, moved };
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

  it('a touched hull (moved, awake, or hit) stays loaded and never double-spawns', () => {
    const t = make();
    t.src.step(needed, 100, 0);
    const ids = [...t.spawned.keys()];
    const first = t.spawned.get(ids[0]!)!;
    t.moved.set(first.id, { x: first.x + 10, y: first.y });
    t.src.step(none, 100, 5000);
    const kept = t.sys.liveFieldCount();
    expect(kept).toBeGreaterThan(0);
    expect(t.src.stats.hullsLive).toBe(1);
    t.src.step(needed, 100, 6000);
    expect(t.src.stats.hullsLive).toBe(d.hulls.length);
    expect(t.sys.liveFieldCount()).toBe(kept + t.removed.length);
    expect(t.src.stats.hullsSpawned).toBe(d.hulls.length * 2 - 1);
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
