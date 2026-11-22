/**
 * Structure break-up bug (in-game stills): a dead structure's pieces lost
 * the parts its RIG draws over the bake (solar panels, the Capital's crane
 * and pad, the turret's riser). The live structure is bake + rig parts; a
 * piece must carry both ("what you see alive = what breaks"), burnt like the
 * piece's art, each part clipped to the piece it sits on.
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import type { StructArt } from '../art/ArtService.js';
import { structArtAsShipArt, structureWreckGunArts } from './wreckPieceArtHandle.js';
import type { ArtHandle, ArtService, ShipArt } from '../art/ArtService.js';
import type { ShipArtCtx } from '../art/shipArtSprites.js';
import type { BakeJob } from '../art/bake.js';
import { WreckArtState, WreckPieceSprite, burntTint } from './wreckArt.js';
import { structureWreckRigArt } from './structureWreckRigArt.js';
import { rebuildWreckPieces } from '../../../core/destruction/wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';
import { structureTurrets, turretBakeJobs } from '../art/turretLayout.js';
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
    const noRig = STRUCTURE_KINDS_LIST.find((s) => rigForStructureKind(s.id) === null && structureTurrets(s.id).length === 0)!;
    expect(structureWreckRigArt(noRig.id, { cx: 0, cy: 0, outline: [] })).toBeNull();
    const d = root('solar');
    const pieces = rebuildWreckPieces(d)!;
    const info = new WreckArtState().infoFor(d, pieces, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
    const sp = new WreckPieceSprite(pieces[0]!, WRECK_STRUCTURE_PARENT_KIND, null, info, 0, null, null, structureWreckSource({ k: 'solar' }));
    expect(sp.getChildByLabel('wreck-rig')).toBeNull();
  });
});

describe('structure wreck pieces carry the turret\'s gun(s)', () => {
  const k = 'turret';
  const d = root(k);
  const pieces = rebuildWreckPieces(d)!;
  const info = new WreckArtState().infoFor(d, pieces, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
  const art = structArtAsShipArt(structArt(k));
  const places = structureTurrets(k);

  it('every piece: one gun pivot per turret place at the mount\'s rest angle, the bar before the gun bake is ready', () => {
    expect(places.length).toBeGreaterThan(0);
    for (const p of pieces) {
      const sp = new WreckPieceSprite(p, WRECK_STRUCTURE_PARENT_KIND, art, info, p.index, null, null, structureWreckSource({ k }));
      const guns = sp.getChildByLabel('wreck-rig')?.getChildByLabel('wreck-guns', true);
      expect(guns).toBeTruthy();
      expect(guns!.visible).toBe(true);
      const pivots = guns!.children.filter((c) => c.label === 'wreck-gun');
      expect(pivots.length).toBe(places.length);
      pivots.forEach((pv, i) => {
        expect(pv.x).toBeCloseTo(places[i]!.px);
        expect(pv.y).toBeCloseTo(places[i]!.py);
        expect(pv.rotation).toBeCloseTo(-places[i]!.mount.baseAngle);
        expect(pv.children.some((c) => c instanceof Graphics)).toBe(true);
      });
    }
  });

  it('with the gun bake ready: the baked gun, not the bar', () => {
    const gunTex = new Texture({ source: new TextureSource({ width: 8, height: 16 }) });
    const gunArt = { frames: [gunTex, gunTex], w: 8, h: 16, tiles: 1, tileH: 16, density: 2, nozzles: [], navLights: [] };
    const sp = new WreckPieceSprite(pieces[0]!, WRECK_STRUCTURE_PARENT_KIND, art, info, 0, null, null, structureWreckSource({ k }), places.map(() => gunArt));
    const pv = sp.getChildByLabel('wreck-gun', true)!;
    expect(pv.children.some((c) => c instanceof Sprite && c.texture === gunTex)).toBe(true);
    expect(pv.children.some((c) => c instanceof Graphics)).toBe(false);
  });
});

describe('structureWreckGunArts: the live gun\'s own bake', () => {
  const places = structureTurrets('turret');
  const gunArt = { frames: [], w: 1, h: 1, tiles: 1, tileH: 1, density: 1, nozzles: [], navLights: [] } as ShipArt;
  const structH = { job: { type: 'struct', id: 'turret', seed: 1, accent: 0x123456 }, state: 'ready' } as unknown as ArtHandle;
  function ctx(ready: boolean, turrets = true): { actx: ShipArtCtx; jobs: BakeJob[] } {
    const jobs: BakeJob[] = [];
    const art = { acquire: (j: BakeJob) => { jobs.push(j); return { job: j, state: ready ? 'ready' : 'pending', ship: ready ? gunArt : null }; } } as unknown as ArtService;
    return { actx: { art, handles: new Map(), sunAz: 0, turrets }, jobs };
  }

  it('asks the live gun job (structure accent as paint); ready = its art, pending = null (the bar)', () => {
    const a = ctx(true);
    expect(structureWreckGunArts(a.actx, structH, 'turret')).toEqual(places.map(() => gunArt));
    expect(a.jobs).toEqual(places.map((p) => turretBakeJobs(p, 0x123456, true).gun));
    expect(structureWreckGunArts(ctx(false).actx, structH, 'turret')).toEqual(places.map(() => null));
  });

  it('Machined turrets off, or no structure bake: null', () => {
    expect(structureWreckGunArts(ctx(true, false).actx, structH, 'turret')).toBeNull();
    expect(structureWreckGunArts(ctx(true).actx, null, 'turret')).toBeNull();
  });
});
