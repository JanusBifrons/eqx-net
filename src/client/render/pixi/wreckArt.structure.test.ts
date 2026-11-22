/**
 * Structure break-up T4, render side: a structure's wreck picks the
 * `structure` profile, a 1× frame and its source's radius in wreckArt's pure
 * helpers, and builds its plain fallback piece (a neutral dead-hull polygon)
 * without any ship lookup. Ship and rock answers are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { WreckArtState, WreckPieceSprite, coolWreckInfo, profileFor, wreckParentRadius } from './wreckArt.js';
import { WRECK_NEUTRAL_BASE, buildWreckPieceGfx, wreckPieceColors } from './spriteBuilders.js';
import { rebuildWreckPieces } from '../../../core/destruction/wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipPrimaryColor } from '../../../core/geometry/shipHullOutline.js';
import {
  WRECK_ROCK_PARENT_KIND, WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor,
} from '../../../shared-types/messages/wreckDescriptor.js';

const SRC = structureWreckSource({ k: 'capital' });
const ROOT: WreckDescriptor = {
  wreckId: 1, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k: 'capital' }, seed: 31,
  killX: SRC.outline[0]![0], killY: SRC.outline[0]![1], killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0,
  algoVersion: FRACTURE_ALGO_VERSION,
};

describe('wreckArt: a structure-rooted wreck (structure break-up T4)', () => {
  it('picks the structure profile; rock and ship keep theirs', () => {
    expect(profileFor(ROOT).id).toBe('structure');
    expect(profileFor({ ...ROOT, parentKind: WRECK_ROCK_PARENT_KIND, structure: undefined }).id).toBe('rock');
    expect(profileFor({ ...ROOT, parentKind: 'battleship', structure: undefined }).id).toBe('capital');
  });

  it('the kill point sits in the 1× (world) frame: scale 1', () => {
    const pieces = rebuildWreckPieces(ROOT);
    const info = new WreckArtState().infoFor(ROOT, pieces, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
    expect(info.killX).toBe(ROOT.killX);
    expect(info.killY).toBe(-ROOT.killY);
    expect(info.profile).toBe('structure');
  });

  it('the LOD radius is the source\'s; a ship\'s and a rock\'s unchanged', () => {
    expect(wreckParentRadius(WRECK_STRUCTURE_PARENT_KIND, null, SRC, 1)).toBe(SRC.radius);
    // No source: the drawn extent, never a ship lookup.
    expect(wreckParentRadius(WRECK_STRUCTURE_PARENT_KIND, null, null, 123)).toBe(123);
    expect(wreckParentRadius(WRECK_ROCK_PARENT_KIND, 40, null, 1)).toBe(40);
    expect(wreckParentRadius('battleship', null, null, 1)).toBe(getShipKind('battleship').radius);
  });

  it('the fallback piece is a neutral dead-hull polygon; ships keep their hull colour', () => {
    const c = wreckPieceColors(WRECK_STRUCTURE_PARENT_KIND);
    const n = wreckPieceColors('battleship');
    expect(c.fill).not.toBe(n.fill);
    expect(c.fill).toBeLessThan(WRECK_NEUTRAL_BASE);
    expect(shipPrimaryColor(getShipKind('battleship'))).toBeGreaterThan(n.fill);
    const pieces = rebuildWreckPieces(ROOT);
    expect(() => buildWreckPieceGfx(pieces[0]!.outline, WRECK_STRUCTURE_PARENT_KIND)).not.toThrow();
  });

  it('builds a plain piece sprite and its far speck without throwing', () => {
    const pieces = rebuildWreckPieces(ROOT);
    const s = new WreckPieceSprite(pieces[0]!, WRECK_STRUCTURE_PARENT_KIND, null, coolWreckInfo(ROOT), 0, null, null, SRC);
    expect(s.children.length).toBeGreaterThan(0);
    expect(() => s.setFarZoom(0.01)).not.toThrow();
    s.destroy({ children: true });
  });
});
