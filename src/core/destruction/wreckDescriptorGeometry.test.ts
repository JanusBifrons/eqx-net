/**
 * The shared descriptor → geometry resolver (capital-destruction.md §S2b,
 * §S4 "Re-split"): a root rebuilds through `wreckPieceGeometry`, a child
 * through its ancestor chain via an injected lookup, and a broken or cyclic
 * chain resolves to null. The server ↔ client byte parity lives in
 * tests/integration/wire/wreckGeometryParity.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_WRECK_CHAIN_DEPTH, rebuildWreckPieces, resolveChildWreckPieces, wreckDescriptorUsable,
} from './wreckDescriptorGeometry.js';
import { wreckPieceGeometry } from './wreckPieces.js';
import { wreckChildGeometry, wreckChildSeed } from './wreckChildren.js';
import { FRACTURE_ALGO_VERSION, projectToOutline } from './fractureHull.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor } from '../../shared-types/messages/wreckDescriptor.js';

function rootDesc(): WreckDescriptor {
  const k = projectToOutline(shipHullOutline(getShipKind('battleship')), { x: 1e5, y: -4e4 });
  return {
    wreckId: 1, parentKind: 'battleship', seed: 7, killX: k.x, killY: k.y,
    killBlowDamage: 0.6, recentDamageRate: 0.4, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
  };
}

function childOf(p: WreckDescriptor, wreckId: number, pieceIndex: number, pieces = rebuildWreckPieces(p)): WreckDescriptor {
  const piece = pieces[pieceIndex]!;
  return {
    ...p, wreckId, parentWreck: p.wreckId, parentPiece: pieceIndex,
    seed: wreckChildSeed(p.seed, pieceIndex), killX: piece.outline[0]!.x, killY: piece.outline[0]!.y,
  };
}

describe('wreckDescriptorGeometry (core, shared by client and server)', () => {
  it('a root rebuilds to exactly wreckPieceGeometry of its inputs', () => {
    const d = rootDesc();
    expect(rebuildWreckPieces(d)).toStrictEqual(wreckPieceGeometry({
      kindId: 'battleship', seed: d.seed, killX: d.killX, killY: d.killY,
      killBlowDamage: d.killBlowDamage, recentDamageRate: d.recentDamageRate, snapChance: d.snapChance,
    }));
  });

  it('a child resolves through the injected lookup to the shared chain geometry', () => {
    const root = rootDesc();
    const child = childOf(root, 2, 0);
    const byId = new Map([[root.wreckId, root]]);
    const anc: WreckDescriptor[] = [];
    const got = resolveChildWreckPieces(child, (id) => byId.get(id), anc);
    expect(got).toStrictEqual(wreckChildGeometry({
      root: {
        kindId: 'battleship', seed: root.seed, killX: root.killX, killY: root.killY,
        killBlowDamage: root.killBlowDamage, recentDamageRate: root.recentDamageRate, snapChance: root.snapChance,
      },
      steps: [{ pieceIndex: 0, killX: child.killX, killY: child.killY }],
    }));
    expect(anc).toEqual([root]);
  });

  it('an unknown ancestor, a mismatched link or a cycle resolves to null', () => {
    const root = rootDesc();
    const child = childOf(root, 2, 0);
    const byId = new Map([[root.wreckId, root]]);
    expect(resolveChildWreckPieces(child, () => undefined)).toBeNull();
    expect(resolveChildWreckPieces({ ...child, seed: (child.seed ^ 1) >>> 0 }, (id) => byId.get(id))).toBeNull();
    expect(resolveChildWreckPieces({ ...child, parentKind: 'destroyer' }, (id) => byId.get(id))).toBeNull();
    const a: WreckDescriptor = { ...child, wreckId: 20, parentWreck: 21 };
    const b: WreckDescriptor = { ...child, wreckId: 21, parentWreck: 20 };
    const loops = new Map([[20, a], [21, b]]);
    let calls = 0;
    expect(resolveChildWreckPieces(a, (id) => { calls++; return loops.get(id); })).toBeNull();
    expect(calls).toBeLessThanOrEqual(MAX_WRECK_CHAIN_DEPTH);
  });

  it('usable: current fracture version, a known ship kind, or a rock root/child', () => {
    const root = rootDesc();
    expect(wreckDescriptorUsable(root)).toBe(true);
    expect(wreckDescriptorUsable({ ...root, algoVersion: FRACTURE_ALGO_VERSION - 1 })).toBe(false);
    expect(wreckDescriptorUsable({ ...root, parentKind: 'not-a-ship' })).toBe(false);
    expect(wreckDescriptorUsable({ ...root, parentKind: WRECK_ROCK_PARENT_KIND })).toBe(false);
    expect(wreckDescriptorUsable({ ...root, parentKind: WRECK_ROCK_PARENT_KIND, parentWreck: 1, parentPiece: 0 })).toBe(true);
  });
});
