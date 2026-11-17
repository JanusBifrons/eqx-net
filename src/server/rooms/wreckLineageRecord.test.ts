/**
 * Saved wreck lineage record (wreck fields plan, slice 0a2a): collect →
 * JSON → parse round-trips a lineage with a dead intermediate ancestor and a
 * rock lineage with ore; a wrong algo version or a malformed record parses
 * to null; nodes come parent-before-child whatever the wreck ids.
 */
import { describe, expect, it } from 'vitest';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import type { WreckChildStep } from '../../core/destruction/wreckChildren.js';
import type { WreckDescriptor } from '../../shared-types/messages/wreckDescriptor.js';
import {
  collectLineage, parseLineageRecord, WRECK_LINEAGE_RECORD_VERSION, WRECK_LINEAGE_UNBREAKABLE,
  type WreckLineageDeps, type WreckLineageView,
} from './wreckLineageRecord.js';
import type { WreckOre } from './capitalWreckTypes.js';

interface FakePiece { wreckId: number; index: number; x: number; y: number; angle: number; vx: number; integrity: number }

function view(desc: WreckDescriptor, parent: number, root: number, steps: WreckChildStep[], ore?: WreckOre): WreckLineageView {
  return { desc, parent, root, chain: { root: { seed: desc.seed, killX: 0, killY: 0, killBlowDamage: 0, recentDamageRate: 0, snapChance: 0 }, steps }, ...(ore !== undefined ? { ore } : {}) };
}

function deps(wrecks: WreckLineageView[], pieces: FakePiece[]): WreckLineageDeps {
  return {
    forEachWreck: (visit) => { for (const w of wrecks) visit(w); },
    forEachLivePiece: (wreckId, visit) => {
      for (const p of pieces) if (p.wreckId === wreckId) visit(p.index, p.x, p.y, p.angle, p.integrity);
    },
  };
}

const base = { killBlowDamage: 0, recentDamageRate: 0, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: 99 };
const step1: WreckChildStep = { pieceIndex: 2, killX: 3, killY: -4, cutKind: 'slice', cutAng: 1234, extraCuts: [{ x: 1, y: 2, ang: 77, w: 0.5 }] };
const step2: WreckChildStep = { pieceIndex: 0, killX: -1.5, killY: 2.25 };

/** Ship lineage: root 40 (live pieces) → child 7 (DEAD: no pieces, one live
 *  child) → grandchild 300 (live pieces), plus child 41 (live) of the root.
 *  Ids are deliberately out of order; a foreign wreck shares the map. */
function shipLineage() {
  const root = view({
    ...base, wreckId: 40, parentKind: 'battleship', seed: 0xdeadbeef, killX: 10, killY: -20,
    killBlowDamage: 1.5, recentDamageRate: 0.4, snapChance: 0.2, cutKind: 'channel', cutAng: 900, cutW: 2, owner: 'player-1',
  }, 0, 40, []);
  const dead = view({ ...base, wreckId: 7, parentKind: 'battleship', seed: 11, killX: 3, killY: -4, cutKind: 'slice', cutAng: 1234, extraCuts: [{ x: 1, y: 2, ang: 77, w: 0.5 }], parentWreck: 40, parentPiece: 2 }, 40, 40, [step1]);
  const grand = view({ ...base, wreckId: 300, parentKind: 'battleship', seed: 12, killX: -1.5, killY: 2.25, parentWreck: 7, parentPiece: 0 }, 7, 40, [step1, step2]);
  const sibling = view({ ...base, wreckId: 41, parentKind: 'battleship', seed: 13, killX: 5, killY: 5, parentWreck: 40, parentPiece: 1 }, 40, 40, [{ pieceIndex: 1, killX: 5, killY: 5 }]);
  const foreign = view({ ...base, wreckId: 9, parentKind: 'frigate', seed: 1, killX: 0, killY: 0 }, 0, 9, []);
  const wrecks = [grand, foreign, sibling, dead, root];
  const pieces: FakePiece[] = [
    { wreckId: 40, index: 0, x: 100, y: 200, angle: 0.5, vx: 3, integrity: 12.5 },
    { wreckId: 40, index: 3, x: 110, y: 190, angle: -1, vx: 0, integrity: Number.POSITIVE_INFINITY },
    { wreckId: 300, index: 1, x: 120.25, y: 205, angle: 2, vx: 1, integrity: 0 },
    { wreckId: 41, index: 0, x: 90, y: 210, angle: 0, vx: 0, integrity: 300 },
    { wreckId: 9, index: 0, x: 0, y: 0, angle: 0, vx: 0, integrity: 1 },
  ];
  return deps(wrecks, pieces);
}

function roundTrip(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v)) as unknown;
}

describe('wreck lineage record', () => {
  it('round-trips a ship lineage with a dead intermediate ancestor', () => {
    const rec = collectLineage(40, shipLineage());
    expect(rec).not.toBeNull();
    expect(rec!.version).toBe(WRECK_LINEAGE_RECORD_VERSION);
    expect(rec!.fractureAlgo).toBe(FRACTURE_ALGO_VERSION);
    expect(rec!.nodes).toHaveLength(4);
    // The dead ancestor is kept (its grandchild needs it), with no pieces.
    const deadIdx = rec!.nodes.findIndex((n) => n.desc.seed === 11);
    expect(deadIdx).toBeGreaterThan(0);
    expect(rec!.pieces.some((p) => p.node === deadIdx)).toBe(false);
    const grandIdx = rec!.nodes.findIndex((n) => n.desc.seed === 12);
    expect(rec!.nodes[grandIdx]!.parent).toBe(deadIdx);
    expect(rec!.nodes[grandIdx]!.steps).toEqual([step1, step2]);
    // Wire-only fields are stripped; restore reassigns them.
    for (const n of rec!.nodes) {
      expect(n.desc).not.toHaveProperty('wreckId');
      expect(n.desc).not.toHaveProperty('parentWreck');
      expect(n.desc).not.toHaveProperty('deathTick');
    }
    expect(rec!.nodes[0]!.desc.owner).toBe('player-1');
    // Pieces: pose only, no velocity; the foreign wreck's piece is not here.
    expect(rec!.pieces).toHaveLength(4);
    expect(rec!.pieces).toContainEqual({ node: grandIdx, piece: 1, x: 120.25, y: 205, angle: 2, integrity: 0 });
    // Wear survives: a worn piece keeps its integrity; an infinite one is -1 (JSON has no Infinity).
    expect(rec!.pieces).toContainEqual({ node: 0, piece: 0, x: 100, y: 200, angle: 0.5, integrity: 12.5 });
    expect(rec!.pieces).toContainEqual({ node: 0, piece: 3, x: 110, y: 190, angle: -1, integrity: WRECK_LINEAGE_UNBREAKABLE });
    expect(parseLineageRecord(roundTrip(rec))).toEqual(rec);
  });

  it('round-trips a rock lineage with its ore', () => {
    const ore: WreckOre = { rockId: 'rock-1', resource: 'ice', perArea: 0.125 };
    const root = view({ ...base, wreckId: 5, parentKind: 'asteroid', seed: 77, killX: 1, killY: 2, rock: { id: 'rock-1', shape: 4242, r: 400, res: 'ice' } }, 0, 5, [], ore);
    const child = view({ ...base, wreckId: 6, parentKind: 'asteroid', seed: 78, killX: 0, killY: 1, parentWreck: 5, parentPiece: 3 }, 5, 5, [{ pieceIndex: 3, killX: 0, killY: 1 }], ore);
    const rec = collectLineage(5, deps([child, root], [{ wreckId: 6, index: 2, x: 1, y: 2, angle: 3, vx: 0, integrity: 7.25 }]));
    expect(rec!.nodes.map((n) => n.ore)).toEqual([ore, ore]);
    expect(rec!.nodes[0]!.desc.rock).toEqual({ id: 'rock-1', shape: 4242, r: 400, res: 'ice' });
    expect(parseLineageRecord(roundTrip(rec))).toEqual(rec);
  });

  it('puts every parent before its children', () => {
    const rec = collectLineage(40, shipLineage())!;
    expect(rec.nodes[0]!.parent).toBe(-1);
    rec.nodes.forEach((n, i) => { if (i > 0) expect(n.parent).toBeGreaterThanOrEqual(0); expect(n.parent).toBeLessThan(i); });
  });

  it('is null for an id that is not a live root', () => {
    expect(collectLineage(7, shipLineage())).toBeNull();
    expect(collectLineage(1234, shipLineage())).toBeNull();
  });

  it('refuses a record from another fracture algo or record version', () => {
    const rec = roundTrip(collectLineage(40, shipLineage())) as Record<string, unknown>;
    expect(parseLineageRecord({ ...rec, fractureAlgo: FRACTURE_ALGO_VERSION - 1 })).toBeNull();
    expect(parseLineageRecord({ ...rec, version: WRECK_LINEAGE_RECORD_VERSION + 1 })).toBeNull();
  });

  it('refuses malformed records', () => {
    const rec = roundTrip(collectLineage(40, shipLineage())) as { nodes: Array<Record<string, unknown>>; pieces: Array<Record<string, unknown>> };
    expect(parseLineageRecord(null)).toBeNull();
    expect(parseLineageRecord('{}')).toBeNull();
    expect(parseLineageRecord({ ...rec, nodes: [] })).toBeNull();
    // A child listed before its parent.
    expect(parseLineageRecord({ ...rec, nodes: [rec.nodes[1], rec.nodes[0], ...rec.nodes.slice(2)] })).toBeNull();
    // A piece on a node that does not exist; a non-finite pose; an unknown key.
    expect(parseLineageRecord({ ...rec, pieces: [{ node: 99, piece: 0, x: 0, y: 0, angle: 0, integrity: 1 }] })).toBeNull();
    expect(parseLineageRecord({ ...rec, pieces: [{ node: 0, piece: 0, x: 'a', y: 0, angle: 0, integrity: 1 }] })).toBeNull();
    // Integrity: missing, negative other than -1, or null (JSON's Infinity).
    expect(parseLineageRecord({ ...rec, pieces: [{ node: 0, piece: 0, x: 0, y: 0, angle: 0 }] })).toBeNull();
    expect(parseLineageRecord({ ...rec, pieces: [{ node: 0, piece: 0, x: 0, y: 0, angle: 0, integrity: -2 }] })).toBeNull();
    expect(parseLineageRecord({ ...rec, pieces: [{ node: 0, piece: 0, x: 0, y: 0, angle: 0, integrity: null }] })).toBeNull();
    expect(parseLineageRecord({ ...rec, extra: 1 })).toBeNull();
  });
});
