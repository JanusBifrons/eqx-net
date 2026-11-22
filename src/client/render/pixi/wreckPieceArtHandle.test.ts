/**
 * Structure break-up T5: a structure's wreck pieces wear the structure's own
 * bake. `structArtAsShipArt` hands its one frame to `WreckPieceSprite` in
 * `ShipArt`'s shape; these lock that the texture layout maps the structure
 * outline (the frame pieces are cut in) onto the texture as the live
 * structure's sprite draws it, and the handle pick by source.
 */
import { describe, expect, it } from 'vitest';
import { Graphics, Mesh, Texture, TextureSource } from 'pixi.js';
import type { ArtHandle, ArtService, ShipArt, StructArt } from '../art/ArtService.js';
import { structHandleFor, type ShipArtCtx } from '../art/shipArtSprites.js';
import { quarterTurns } from '../art/bake.js';
import { structArtAsShipArt, wreckPieceArtHandle, wreckPieceArtOf } from './wreckPieceArtHandle.js';
import { WreckArtState, WreckPieceSprite, burntTint, wreckPieceMeshes, wreckTexLayout } from './wreckArt.js';
import { rebuildWreckPieces } from '../../../core/destruction/wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { structureBreaks, structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';
import {
  WRECK_ROCK_PARENT_KIND, WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor,
} from '../../../shared-types/messages/wreckDescriptor.js';

const PPU = 0.5;

/** A structure bake's shape (`gridFor` of its footprint box: symmetric, 2 u margin). */
function structArt(kindId: string): StructArt {
  const fp = STRUCTURE_KINDS_LIST.find((k) => k.id === kindId)!.footprint;
  const w = Math.ceil((fp.w / 2 + 2) * 2 * PPU), h = Math.ceil((fp.h / 2 + 2) * 2 * PPU);
  const tex = new Texture({ source: new TextureSource({ width: w, height: h }) });
  return { tex, albedo: tex, w, h, density: PPU, navLights: [] };
}

const ROOT: WreckDescriptor = {
  wreckId: 1, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k: 'capital' }, seed: 31,
  killX: 0, killY: 0, killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
};

describe('structArtAsShipArt (structure break-up T5)', () => {
  it('one untiled frame of the same bake: size, density, lit facts; memoised per bake', () => {
    const s = structArt('capital');
    const a = structArtAsShipArt(s);
    expect(a.frames).toEqual([s.tex]);
    expect([a.w, a.h, a.tiles, a.tileH, a.density]).toEqual([s.w, s.h, 1, s.h, s.density]);
    expect(a.lit).toBeUndefined();
    expect(structArtAsShipArt(s)).toBe(a); // identity: the updater's swap check
    const lit = { ...s, lit: { w: s.w, h: s.h, ppu: PPU, maxH: 10, emisMax: 1 } };
    expect(structArtAsShipArt(lit).lit).toBe(lit.lit);
  });

  it('every breaking kind: a piece samples the texel the live sprite draws at its Pixi position, inside the texture', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      if (!structureBreaks(k.id, true)) continue;
      const src = structureWreckSource({ k: k.id });
      const s = structArt(k.id);
      const L = wreckTexLayout(structArtAsShipArt(s));
      // The whole outline as one piece about an off-centre centroid.
      const cx = 7, cy = -5;
      const part = src.outline.map(([x, y]) => ({ x: x - cx, y: y - cy }));
      const piece = { parts: [part], cx, cy } as unknown as WreckPieceGeometry;
      const meshes = wreckPieceMeshes(piece, L);
      expect(meshes.length, k.id).toBe(1);
      const m = meshes[0]!;
      for (let i = 0; i < m.positions.length; i += 2) {
        // Drawn body-local (Pixi-down) about the structure centre.
        const px = m.positions[i]! + cx, py = m.positions[i + 1]! - cy;
        expect(m.uvs[i]! * s.w).toBeCloseTo(px * PPU + s.w / 2, 3);
        expect(m.uvs[i + 1]! * s.h).toBeCloseTo(py * PPU + s.h / 2, 3);
        expect(m.uvs[i]!).toBeGreaterThanOrEqual(0); expect(m.uvs[i]!).toBeLessThanOrEqual(1);
        expect(m.uvs[i + 1]!).toBeGreaterThanOrEqual(0); expect(m.uvs[i + 1]!).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every breaking kind\'s outline is symmetric about its x axis (the cut frame is Y-flipped vs the drawn structure: the flip is invisible)', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      if (!structureBreaks(k.id, true)) continue;
      const o = structureWreckSource({ k: k.id }).outline;
      for (const [x, y] of o) {
        expect(o.some(([x2, y2]) => Math.abs(x2 - x) < 1e-6 && Math.abs(y2 + y) < 1e-6), `${k.id} (${x}, ${y})`).toBe(true);
      }
    }
  });
});

function stubSvc(asked: unknown[][]): ArtService {
  return {
    ship: (...a: unknown[]) => { asked.push(['ship', ...a]); return { job: { type: 'ship', id: a[0] }, state: 'queued', ship: null, struct: null } as unknown as ArtHandle; },
    struct: (...a: unknown[]) => { asked.push(['struct', ...a]); return { job: { type: 'struct', id: a[0], rot: a[2], lit: false, style: a[7] }, state: 'queued', ship: null, struct: null } as unknown as ArtHandle; },
  } as unknown as ArtService;
}

describe('wreckPieceArtHandle: the art by the wreck\'s source', () => {
  const actx = (art: ArtService | null): ShipArtCtx => ({ art, handles: new Map(), sunAz: 0 });
  const SRC = structureWreckSource({ k: 'capital' });

  it('a structure piece asks the structure kind\'s bake (turn 0, no owner: catalogue colours); never a ship bake', () => {
    const asked: unknown[][] = [];
    const h = wreckPieceArtHandle(actx(stubSvc(asked)), 'k', ROOT, WRECK_STRUCTURE_PARENT_KIND, undefined, SRC);
    expect(h?.job.type).toBe('struct');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.slice(0, 5)).toEqual(['struct', 'capital', 1, 0, undefined]);
  });

  it('Baked art: a capital killed at quarter turn 1/2/3 textures its pieces on the FIRST build (the live structure\'s cached bake, not a fresh turn-0 one)', () => {
    for (const q of [1, 2, 3]) {
      // A Baked (unlit) cache: one bake per kind + quarter turn (`bakeKey`'s `:rN`);
      // only what the live structure already wore is ready.
      const cache = new Map<string, ArtHandle>();
      const svc = {
        struct: (id: string, _seed: number, rot = 0) => {
          const k = `${id}:${quarterTurns(rot)}`;
          let h = cache.get(k);
          if (h === undefined) {
            h = { job: { type: 'struct', id, rot, lit: false }, state: 'pending', ship: null, struct: null } as unknown as ArtHandle;
            cache.set(k, h);
          }
          return h;
        },
      } as unknown as ArtService;
      const a = actx(svc);
      const angle = q * (Math.PI / 2); // the structure's (and its pieces' death pose) swarm angle
      const live = structHandleFor(a, 'live', 'capital', -angle)!;
      Object.assign(live, { state: 'ready', struct: structArt('capital') }); // baked while it stood
      const h = wreckPieceArtHandle(a, 'piece', ROOT, WRECK_STRUCTURE_PARENT_KIND, undefined, SRC, -angle);
      expect(wreckPieceArtOf(h), `q${q}`).not.toBeNull();
      // Spinning on: the same bake, no re-bake per quarter turn.
      expect(wreckPieceArtHandle(a, 'piece', ROOT, WRECK_STRUCTURE_PARENT_KIND, undefined, SRC, -angle - Math.PI / 2), `q${q} spun`).toBe(h);
      expect(cache.size, `q${q}`).toBe(1);
    }
  });

  it('no source: no art (the plain piece); art off: none', () => {
    expect(wreckPieceArtHandle(actx(stubSvc([])), 'k', ROOT, WRECK_STRUCTURE_PARENT_KIND, undefined, undefined)).toBeNull();
    expect(wreckPieceArtHandle(actx(null), 'k', ROOT, WRECK_STRUCTURE_PARENT_KIND, undefined, SRC)).toBeNull();
  });

  it('a ship piece keeps the live hull\'s bake; a rock piece none', () => {
    const asked: unknown[][] = [];
    const svc = stubSvc(asked);
    expect(wreckPieceArtHandle(actx(svc), 'k', { ...ROOT, parentKind: 'battleship', structure: undefined }, 'battleship', undefined, undefined)?.job.type).toBe('ship');
    expect(asked[0]![0]).toBe('ship');
    expect(wreckPieceArtHandle(actx(svc), 'r', { ...ROOT, parentKind: WRECK_ROCK_PARENT_KIND, structure: undefined }, WRECK_ROCK_PARENT_KIND, undefined, undefined)).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it('wreckPieceArtOf: ready ship art as is, ready structure art adapted, else null', () => {
    const s = structArt('capital');
    const ship = { frames: [], w: 1, h: 1, tiles: 1, tileH: 1, density: 1, nozzles: [], navLights: [] } as ShipArt;
    expect(wreckPieceArtOf(null)).toBeNull();
    expect(wreckPieceArtOf({ state: 'queued', ship: null, struct: s } as unknown as ArtHandle)).toBeNull();
    expect(wreckPieceArtOf({ state: 'ready', ship, struct: null } as unknown as ArtHandle)).toBe(ship);
    expect(wreckPieceArtOf({ state: 'ready', ship: null, struct: s } as unknown as ArtHandle)).toBe(structArtAsShipArt(s));
  });
});

describe('WreckPieceSprite with a structure\'s art', () => {
  const SRC = structureWreckSource({ k: 'capital' });
  const pieces = rebuildWreckPieces(ROOT)!;
  const info = new WreckArtState().infoFor(ROOT, pieces, 0, { x: 0, y: 0, angle: 0 }, 0, 1000);

  it('with art: textured meshes on the structure\'s texture, burnt like a dead hull', () => {
    const s = structArt('capital');
    const sp = new WreckPieceSprite(pieces[0]!, WRECK_STRUCTURE_PARENT_KIND, structArtAsShipArt(s), info, 0, null, null, SRC);
    const meshes = sp.children.filter((c): c is Mesh => c instanceof Mesh && c.texture === s.tex);
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) expect(m.tint).toBe(burntTint(pieces[0]!, info));
    expect(sp.children.some((c) => c instanceof Graphics)).toBe(false);
  });

  it('without art: the plain polygon fallback', () => {
    const sp = new WreckPieceSprite(pieces[0]!, WRECK_STRUCTURE_PARENT_KIND, null, info, 0, null, null, SRC);
    expect(sp.children.some((c) => c instanceof Graphics)).toBe(true);
  });
});
