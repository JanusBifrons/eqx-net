/**
 * Structure break-up bug (in-game stills): a dead structure's pieces lost
 * the parts its RIG draws over the bake (solar panels, the Capital's crane
 * and pad, the turret's riser). The live structure is bake + rig parts; a
 * piece must carry both ("what you see alive = what breaks"), burnt like the
 * piece's art, each part clipped to the piece it sits on.
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics, Texture, TextureSource } from 'pixi.js';
import type { StructArt } from '../art/ArtService.js';
import { structArtAsShipArt } from './wreckPieceArtHandle.js';
import { WreckArtState, WreckPieceSprite, burntTint } from './wreckArt.js';
import { structureWreckRigArt } from './structureWreckRigArt.js';
import { rebuildWreckPieces } from '../../../core/destruction/wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';
import { WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor } from '../../../shared-types/messages/wreckDescriptor.js';

const PPU = 0.5;
function structArt(kindId: string): StructArt {
  const fp = STRUCTURE_KINDS_LIST.find((k) => k.id === kindId)!.footprint;
  const w = Math.ceil((fp.w / 2 + 2) * 2 * PPU), h = Math.ceil((fp.h / 2 + 2) * 2 * PPU);
  const tex = new Texture({ source: new TextureSource({ width: w, height: h }) });
  return { tex, albedo: tex, w, h, density: PPU, navLights: [] };
}
function root(k: string): WreckDescriptor {
  return {
    wreckId: 1, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k }, seed: 31,
    killX: 0, killY: 0, killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
  };
}
function rigParts(c: Container): Graphics[] {
  const out: Graphics[] = [];
  const walk = (n: Container): void => {
    for (const ch of n.children) {
      if (ch instanceof Graphics && ch.label.startsWith('rig-part-')) out.push(ch);
      walk(ch as Container);
    }
  };
  walk(c);
  return out;
}

describe('structure wreck pieces carry the structure\'s rig parts', () => {
  for (const k of ['solar', 'capital', 'turret']) {
    it(`${k}: every piece wears the rig, burnt, masked to its outline, framed as its art`, () => {
      const rig = rigForStructureKind(k);
      expect(rig).not.toBeNull();
      const d = root(k);
      const pieces = rebuildWreckPieces(d)!;
      const info = new WreckArtState().infoFor(d, pieces, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
      const art = structArtAsShipArt(structArt(k));
      for (const p of pieces) {
        const sp = new WreckPieceSprite(p, WRECK_STRUCTURE_PARENT_KIND, art, info, p.index, null, null, structureWreckSource({ k }));
        const rigArt = sp.getChildByLabel('wreck-rig');
        expect(rigArt).not.toBeNull();
        expect(rigParts(rigArt!).length).toBe(rig!.partCount);
        expect(rigArt!.mask).toBeInstanceOf(Graphics);
        expect(rigArt!.tint).toBe(burntTint(p, info));
        const body = rigArt!.getChildByLabel('wreck-rig-body')!;
        expect(body.x).toBeCloseTo(-p.cx);
        expect(body.y).toBeCloseTo(p.cy);
      }
    });
  }

  it('a kind with no rig adds nothing; the plain piece (no art yet) adds nothing', () => {
    const noRig = STRUCTURE_KINDS_LIST.find((s) => rigForStructureKind(s.id) === null)!;
    expect(structureWreckRigArt(noRig.id, { cx: 0, cy: 0, outline: [] })).toBeNull();
    const d = root('solar');
    const pieces = rebuildWreckPieces(d)!;
    const info = new WreckArtState().infoFor(d, pieces, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
    const sp = new WreckPieceSprite(pieces[0]!, WRECK_STRUCTURE_PARENT_KIND, null, info, 0, null, null, structureWreckSource({ k: 'solar' }));
    expect(sp.getChildByLabel('wreck-rig')).toBeNull();
  });
});
