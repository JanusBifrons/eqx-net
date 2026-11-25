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
import { pointInRing } from './wreckGlowStrip.js';

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

  // Round-2 stills: the gun on a wreck piece was a STUB. The barrel reaches
  // the muzzle (1.6 × the turret radius), well past the hull, as the live
  // turret draws it; the piece mask (its outline) cut it at the hull edge,
  // leaving the stretch between the housing and the hull side.
  it('the barrel past the hull stays whole on one piece; no other piece draws it', () => {
    const gunTex = new Texture({ source: new TextureSource({ width: 8, height: 16 }) });
    const gunArt = { frames: [gunTex, gunTex], w: 8, h: 16, tiles: 1, tileH: 16, density: 2, nozzles: [], navLights: [] };
    for (const seed of [3, 17, 31]) {
      const ds = { ...d, seed, killX: 30, killY: 20 };
      const ps = rebuildWreckPieces(ds)!;
      const inf = new WreckArtState().infoFor(ds, ps, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
      let owners = 0;
      for (const p of ps) {
        const sp = new WreckPieceSprite(p, WRECK_STRUCTURE_PARENT_KIND, art, inf, p.index, null, null, structureWreckSource({ k }), places.map(() => gunArt));
        const rig = sp.getChildByLabel('wreck-rig')!;
        const mask = rig.mask as Graphics;
        places.forEach((pl, i) => {
          const pv = rig.getChildByLabel('wreck-gun', true)!.parent!.children.filter((c) => c.label === 'wreck-gun')[i]!;
          const at = (t: number): { x: number; y: number } => rig.toLocal({ x: 0, y: -t }, pv);
          // Just short of the muzzle: outside the hull (the turret's half side is 70).
          const tip = at(pl.muzzle * 0.95);
          expect(Math.hypot(tip.x + p.cx, tip.y - p.cy), 'tip is past the hull').toBeGreaterThan(75);
          const owner = mask.containsPoint(tip);
          // Whole: from the hull side to the muzzle, no gap.
          if (owner) for (let t = 72; t < pl.muzzle; t += 4) expect(mask.containsPoint(at(t)), `s${seed} piece ${p.index}: gap at ${t}`).toBe(true);
          if (owner) owners++;
        });
        sp.destroy({ children: true });
      }
      expect(owners, `s${seed}: one owner per gun`).toBe(places.length);
    }
  });

  // Round-3 stills: a cut through the mount leaves the pivot on a corner
  // every piece around it shares; the overhang went to a piece the barrel
  // does not lie on (the one below the gun), so as the pieces parted the
  // barrel hung off in space under the piece that carries the gun. The
  // overhang must ride the piece the barrel itself lies on, rigidly: posed
  // anywhere, its muzzle and the barrel just inside the hull are both drawn
  // by that piece, at the gun's rest angle.
  it('the overhang rides the piece the barrel lies on, also when a cut runs through the mount', () => {
    const gunTex = new Texture({ source: new TextureSource({ width: 8, height: 16 }) });
    const gunArt = { frames: [gunTex, gunTex], w: 8, h: 16, tiles: 1, tileH: 16, density: 2, nozzles: [], navLights: [] };
    const world = new Container();
    for (let seed = 1; seed <= 12; seed++) {
      const ds = { ...d, seed, killX: 0, killY: 0 };
      const ps = rebuildWreckPieces(ds)!;
      const inf = new WreckArtState().infoFor(ds, ps, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
      let owners = 0;
      for (const p of ps) {
        const sp = new WreckPieceSprite(p, WRECK_STRUCTURE_PARENT_KIND, art, inf, p.index, null, null, structureWreckSource({ k }), places.map(() => gunArt));
        world.addChild(sp);
        // Parted and turned, as the swarm updater poses it (Pixi y = -game y).
        sp.position.set(300 + 40 * p.index, -120 - 25 * p.index);
        sp.rotation = 0.7 - 0.4 * p.index;
        const rig = sp.getChildByLabel('wreck-rig')!;
        const mask = rig.mask as Graphics;
        const ring = p.outline.map((v) => ({ x: v.x, y: -v.y }));
        const pv = rig.getChildByLabel('wreck-gun', true)!;
        places.forEach((pl) => {
          const tipW = pv.toGlobal({ x: 0, y: -pl.muzzle * 0.95 });
          if (!mask.containsPoint(mask.toLocal(tipW))) return; // not this piece's overhang
          owners++;
          // The gun keeps its rest angle on the piece: tip straight out from the pivot along the piece's pose.
          const pivW = pv.toGlobal({ x: 0, y: 0 });
          expect(Math.atan2(tipW.y - pivW.y, tipW.x - pivW.x)).toBeCloseTo(sp.rotation - pl.mount.baseAngle - Math.PI / 2, 5);
          // The barrel just inside the hull (either side of its axis) lies on this same piece.
          const onPiece = [-0.5, 0.5].some((s) => {
            const q = rig.toLocal(pv.toGlobal({ x: s * pl.wid, y: -60 }));
            return pointInRing(ring, q.x, q.y);
          });
          expect(onPiece, `s${seed} piece ${p.index}: the overhang hangs off a piece the barrel is not on`).toBe(true);
        });
        world.removeChild(sp);
        sp.destroy({ children: true });
      }
      expect(owners, `s${seed}: one owner per gun`).toBe(places.length);
    }
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

// Capital death (in-game): the landing pad vanished. The pad is the crane
// rig's `lip`, an under-layer apron OUTSIDE the hull past the open edge; the
// piece mask (its outline) clipped it away on every piece. Like a barrel
// past the hull, the pad goes whole with the piece it attaches to (the one
// holding the open edge where it meets the hull), drawn by no other piece.
describe('the Capital\'s landing pad survives on the piece it attaches to', () => {
  const k = 'capital';
  const lip = rigForStructureKind(k)!.parts.find((p) => p.id === 'lip')!;
  const o = lip.outline!;
  const xs = o.filter((_, i) => i % 2 === 0), ys = o.filter((_, i) => i % 2 === 1);
  // Inset sample grid over the pad, in the lip part's own frame (game y-up).
  const x0 = Math.min(...xs) + 4, x1 = Math.max(...xs) - 4, y0 = Math.min(...ys) + 4, y1 = Math.max(...ys) - 4;
  const samples: Array<{ x: number; y: number }> = [];
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) samples.push({ x: x0 + ((x1 - x0) * a) / 4, y: y0 + ((y1 - y0) * b) / 4 });
  const art = structArtAsShipArt(structArt(k));

  it('every seed: exactly one piece draws the whole pad, and it holds the open edge where the pad meets the hull', () => {
    for (const [seed, kx, ky] of [[3, 0, 0], [17, 40, 120], [31, -90, 60], [8, 0, 200]] as const) {
      const ds = { ...root(k), seed, killX: kx, killY: ky };
      const ps = rebuildWreckPieces(ds)!;
      const inf = new WreckArtState().infoFor(ds, ps, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);
      let owners = 0;
      for (const p of ps) {
        const sp = new WreckPieceSprite(p, WRECK_STRUCTURE_PARENT_KIND, art, inf, p.index, null, null, structureWreckSource({ k }));
        const rigArt = sp.getChildByLabel('wreck-rig')!;
        const mask = rigArt.mask as Graphics;
        const lipG = rigArt.getChildByLabel('rig-part-lip', true)!;
        const at = (x: number, y: number): { x: number; y: number } => rigArt.toLocal({ x, y: -y }, lipG);
        const hits = samples.filter((s) => mask.containsPoint(at(s.x, s.y))).length;
        expect(hits === 0 || hits === samples.length, `s${seed} piece ${p.index}: pad split (${hits}/${samples.length})`).toBe(true);
        if (hits === samples.length) {
          owners++;
          const ring = p.outline.map((v) => ({ x: v.x, y: -v.y }));
          // Just inside the hull, back from where the pad meets it.
          const onEdge = [-6, -16, -32].some((dy) => [-40, 0, 40].some((dx) => { const q = at(dx, dy); return pointInRing(ring, q.x, q.y); }));
          expect(onEdge, `s${seed} piece ${p.index}: the pad hangs off a piece away from the open edge`).toBe(true);
        }
        sp.destroy({ children: true });
      }
      expect(owners, `s${seed}: one pad owner`).toBe(1);
    }
  });
});
