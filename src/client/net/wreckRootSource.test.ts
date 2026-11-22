/**
 * Structure break-up T4, client side: a structure-rooted wreck resolves
 * through the ONE source seam (`wreckRootSource`), the store rebuilds its
 * geometry (root and child), and the rock and ship answers are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { WreckGeometryStore } from './wreckGeometryStore';
import { rootSourceOf, wreckFrameScale, wreckProfileOf, wreckSourceKindOf } from './wreckRootSource';
import { wreckPieceName } from '../fleet/fleetView';
import { rebuildWreckPieces, resolveChildWreckPieces } from '@core/destruction/wreckDescriptorGeometry';
import { wreckChildSeed } from '@core/destruction/wreckChildren';
import { FRACTURE_ALGO_VERSION } from '@core/destruction/fractureHull';
import { rockWreckSource, shipWreckSource, structureBreaks, structureWreckSource } from '@core/destruction/wreckSource';
import { STRUCTURE_KINDS_LIST } from '@shared-types/structureKinds';
import { shipShapeScale } from '@core/geometry/shipHullOutline';
import { getShipKind } from '@shared-types/shipKinds';
import { DESTRUCTION_PROFILES } from '@shared-types/shipScale/destruction';
import {
  WRECK_ROCK_PARENT_KIND, WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor,
} from '@shared-types/messages/wreckDescriptor';

function structureRoot(): WreckDescriptor {
  const o = structureWreckSource({ k: 'capital' }).outline;
  return {
    wreckId: 1, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k: 'capital' }, seed: 31,
    killX: o[0]![0], killY: o[0]![1], killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0,
    algoVersion: FRACTURE_ALGO_VERSION,
  };
}

function childOf(root: WreckDescriptor, wreckId: number, pieceIndex: number): WreckDescriptor {
  const piece = rebuildWreckPieces(root)[pieceIndex]!;
  const { structure: _s, ...base } = root;
  void _s;
  return {
    ...base, wreckId, parentWreck: root.wreckId, parentPiece: pieceIndex,
    seed: wreckChildSeed(root.seed, pieceIndex), killX: piece.outline[0]!.x, killY: piece.outline[0]!.y,
  };
}

const ROCK_ROOT: WreckDescriptor = {
  wreckId: 5, parentKind: WRECK_ROCK_PARENT_KIND, seed: 3, killX: 0, killY: 0, killBlowDamage: 0,
  recentDamageRate: 0, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, rock: { id: 'r1', shape: 7, r: 40 },
};

describe('wreckRootSource: the client source seam (structure break-up T4)', () => {
  it('names the source by parent kind', () => {
    expect(wreckSourceKindOf(WRECK_STRUCTURE_PARENT_KIND)).toBe('structure');
    expect(wreckSourceKindOf(WRECK_ROCK_PARENT_KIND)).toBe('rock');
    expect(wreckSourceKindOf('battleship')).toBe('ship');
  });

  it('a structure root resolves to core\'s structure source; profile structure, frame scale 1', () => {
    const src = rootSourceOf(structureRoot(), null);
    expect(src).toBe(structureWreckSource({ k: 'capital' }));
    expect(src!.structure).toEqual({ k: 'capital' });
    expect(wreckProfileOf(WRECK_STRUCTURE_PARENT_KIND)).toBe(DESTRUCTION_PROFILES.structure);
    expect(wreckFrameScale(WRECK_STRUCTURE_PARENT_KIND)).toBe(1);
    // A structure root without its ref has no source (never a ship lookup).
    expect(rootSourceOf({ ...structureRoot(), structure: undefined }, null)).toBeUndefined();
  });

  it('rock and ship answers are unchanged', () => {
    expect(rootSourceOf(ROCK_ROOT, null)).toBe(rockWreckSource(ROCK_ROOT.rock!));
    expect(wreckProfileOf(WRECK_ROCK_PARENT_KIND)).toBe(DESTRUCTION_PROFILES.rock);
    expect(wreckFrameScale(WRECK_ROCK_PARENT_KIND)).toBe(1);
    const ship = { ...ROCK_ROOT, parentKind: 'battleship', rock: undefined };
    expect(rootSourceOf(ship, null)).toBe(shipWreckSource('battleship'));
    expect(wreckFrameScale('battleship')).toBe(shipShapeScale(getShipKind('battleship')));
  });

  it('the fleet label: a rock piece reads Rock, a structure\'s and a ship\'s Wreck', () => {
    expect(wreckPieceName(WRECK_ROCK_PARENT_KIND)).toBe('Rock');
    expect(wreckPieceName(WRECK_STRUCTURE_PARENT_KIND)).toBe('Wreck');
    expect(wreckPieceName('battleship')).toBe('Wreck');
    expect(wreckPieceName(undefined)).toBe('Wreck');
  });
});

describe('WreckGeometryStore: a structure-rooted wreck (structure break-up T4)', () => {
  it('rebuilds the root and a child; rootOf / sourceOf walk to the structure', () => {
    const root = structureRoot();
    const child = childOf(root, 2, 0);
    const store = new WreckGeometryStore();
    store.apply([root, child]);
    expect(store.piece(1, 0)).toEqual(rebuildWreckPieces(root)[0]);
    const want = resolveChildWreckPieces(child, (id) => (id === 1 ? root : undefined));
    expect(want).not.toBeNull();
    expect(store.piece(2, 0)).toEqual(want![0]);
    expect(store.rootOf(2)).toBe(root);
    expect(store.sourceOf(2)).toBe(structureWreckSource({ k: 'capital' }));
    expect(store.rockOf(2)).toBeUndefined();
  });

  it('a different structure kind under the same wreck id is a new wreck', () => {
    const store = new WreckGeometryStore();
    const a = structureRoot();
    const pa = store.geometryFor(a);
    const other = STRUCTURE_KINDS_LIST.find((k) => k.id !== 'capital' && structureBreaks(k.id, true))!.id;
    const o = structureWreckSource({ k: other }).outline;
    const b: WreckDescriptor = { ...a, structure: { k: other }, killX: o[0]![0], killY: o[0]![1] };
    const pb = store.geometryFor(b);
    expect(pb).not.toBe(pa);
    expect(store.sourceOf(1)).toBe(structureWreckSource({ k: other }));
  });

  it('a rock wreck still answers rockOf and its rock source', () => {
    const store = new WreckGeometryStore();
    store.apply([ROCK_ROOT]);
    expect(store.rockOf(5)).toEqual(ROCK_ROOT.rock);
    expect(store.sourceOf(5)).toBe(rockWreckSource(ROCK_ROOT.rock!));
  });
});
