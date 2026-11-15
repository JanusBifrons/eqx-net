/**
 * Capital destruction S3 — wreck art, the pure parts.
 *
 * Texture continuity: each wreck piece samples the dead ship's own baked hull
 * art at the piece's ORIGINAL hull-local coordinates, so the pieces fit
 * together like a jigsaw. A capital's art is tiled (one texture per tile along
 * the hull), so a piece is cut into one mesh per tile it covers; each mesh's
 * UVs are its tile texture's frame-relative coordinates.
 *
 * Glow: only the NEW cut edges glow, molten at death, an ember at ~4 s, dark
 * at the end.
 */
import { describe, it, expect } from 'vitest';
import {
  wreckPieceMeshes,
  wreckGlowAt,
  cutEdgeRuns,
  WRECK_GLOW_EMBER_S,
  WRECK_GLOW_END_S,
  wreckBlasts,
  hullDeathBlastReplaced,
  crackFrontAt,
  crackIgniteMs,
  WreckArtState,
  WRECK_CRACK_FRONT_MS,
  WreckPieceSprite,
  channelFarEnd,
  wreckGlowTexture,
  simpleGlowAt,
  glowTintOf,
  glowV,
  glowWidthMul,
  CUT_GLOW_WIDTH_MUL,
  CUT_GLOW_HOLD_S,
  GLOW_TINT_CRACK,
  GLOW_TINT_SLICE,
  GLOW_TINT_CHANNEL,
  GLOW_TINT_SPLINTER,
  SPLINTER_GLOW_WIDTH_MUL,
  WRECK_GLOW_TINTS,
  WRECK_GLOW_TEX_ROWS,
  GLOW_ROW,
  GLOW_ROWS_PER_TINT,
  type WreckGlow,
  type WreckBlast,
  type WreckTexLayout,
} from './wreckArt.js';
import { rebuildWreckPieces, resolveChildWreckPieces } from '../../net/wreckGeometryStore.js';
import { wreckChainFracture, wreckChildSeed } from '../../../core/destruction/wreckChildren.js';
import { FRACTURE_ALGO_VERSION, EDGE_CUT, EDGE_HULL, projectToOutline } from '../../../core/destruction/fractureHull.js';
import { shipHullOutline } from '../../../core/geometry/shipHullOutline.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { HEAVY_BEAM_WIDTH } from '../../../core/combat/WeaponCatalogue.js';
import { RAILGUN_BOLT_WIDTH } from '../../../shared-types/combat/navalGuns.js';
import { HEAVY_BEAM_COLOR } from '../beamStyles.js';
import { shipParts } from '../art/fields.js';
import { Mesh } from 'pixi.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';

const DESC: WreckDescriptor = {
  wreckId: 3, parentKind: 'battleship', seed: 11, killX: 0, killY: -400,
  killBlowDamage: 2, recentDamageRate: 1, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
};

/** A tiled layout that covers the whole hull (like a baked capital's). */
function layoutFor(pieces: WreckPieceGeometry[]): WreckTexLayout {
  let mx = 0, my = 0;
  for (const p of pieces) for (const v of p.outline) {
    mx = Math.max(mx, Math.abs(v.x + p.cx));
    my = Math.max(my, Math.abs(v.y + p.cy));
  }
  const w = 300, h = 1400;
  const density = Math.min(w / (2 * mx * 1.05), h / (2 * my * 1.05));
  return { w, h, tiles: 3, tileH: 512, density, frameW: w, frameHs: [512, 512, h - 1024] };
}

/** The expected UV of a hull-local (math-up, scaled) point on tile `t`. */
function expectedUv(hx: number, hy: number, L: WreckTexLayout, t: number): [number, number] {
  const tx = hx * L.density + L.w / 2;
  const ty = -hy * L.density + L.h / 2 - t * L.tileH;
  return [tx / L.frameW, ty / L.frameHs[t]!];
}

function triArea(px: Float32Array, idx: Uint32Array): number {
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i]! * 2, i1 = idx[i + 1]! * 2, i2 = idx[i + 2]! * 2;
    a += Math.abs((px[i1]! - px[i0]!) * (px[i2 + 1]! - px[i0 + 1]!) - (px[i2]! - px[i0]!) * (px[i1 + 1]! - px[i0 + 1]!)) / 2;
  }
  return a;
}

describe('wreckPieceMeshes — texture continuity (S3)', () => {
  const pieces = rebuildWreckPieces(DESC);
  const L = layoutFor(pieces);

  it('UVs are the hull-local positions mapped into the parent texture rect', () => {
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) {
      const meshes = wreckPieceMeshes(p, L);
      expect(meshes.length, `piece ${p.index} has geometry`).toBeGreaterThan(0);
      for (const m of meshes) {
        expect(m.uvs.length).toBe(m.positions.length);
        for (let i = 0; i < m.positions.length; i += 2) {
          // Positions are body-local, Pixi-down (x, −y) about the centroid.
          const hx = m.positions[i]! + p.cx;
          const hy = -m.positions[i + 1]! + p.cy;
          const [u, v] = expectedUv(hx, hy, L, m.tile);
          expect(m.uvs[i]!).toBeCloseTo(u, 5);
          expect(m.uvs[i + 1]!).toBeCloseTo(v, 5);
          // Inside the tile's texture rect (the art covers the hull).
          expect(m.uvs[i]!).toBeGreaterThanOrEqual(-1e-6);
          expect(m.uvs[i]!).toBeLessThanOrEqual(1 + 1e-6);
          expect(m.uvs[i + 1]!).toBeGreaterThanOrEqual(-1e-6);
          expect(m.uvs[i + 1]!).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });

  it('the tile meshes tile the piece exactly (area), split across tile seams', () => {
    let crossed = 0;
    for (const p of pieces) {
      const meshes = wreckPieceMeshes(p, L);
      if (meshes.length > 1) crossed++;
      let a = 0;
      for (const m of meshes) a += triArea(m.positions, m.indices);
      expect(a).toBeCloseTo(p.area, -1);
      expect(Math.abs(a - p.area) / p.area).toBeLessThan(1e-3);
    }
    expect(crossed, 'some piece straddles a tile seam').toBeGreaterThan(0);
  });

  it('neighbouring pieces share edge UVs (the jigsaw fits)', () => {
    // Every vertex keyed by its hull-local point (1/8 u) and tile.
    const seen = new Map<string, { piece: number; u: number; v: number }>();
    let shared = 0;
    for (const p of pieces) {
      for (const m of wreckPieceMeshes(p, L)) {
        for (let i = 0; i < m.positions.length; i += 2) {
          const hx = m.positions[i]! + p.cx;
          const hy = -m.positions[i + 1]! + p.cy;
          const key = `${m.tile}:${Math.round(hx * 8)}:${Math.round(hy * 8)}`;
          const prev = seen.get(key);
          if (prev === undefined) { seen.set(key, { piece: p.index, u: m.uvs[i]!, v: m.uvs[i + 1]! }); continue; }
          if (prev.piece === p.index) continue;
          shared++;
          expect(m.uvs[i]!).toBeCloseTo(prev.u, 4);
          expect(m.uvs[i + 1]!).toBeCloseTo(prev.v, 4);
        }
      }
    }
    expect(shared, 'pieces share cut-edge vertices').toBeGreaterThan(10);
  });
});

describe('wreckGlowAt — molten cut edges cool to dark (S3)', () => {
  const g = { color: 0, alpha: 0 };
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

  it('hot at the moment of death: bright, opaque, orange-white', () => {
    wreckGlowAt(0, g);
    const [r, gg, b] = rgb(g.color);
    expect(g.alpha).toBeGreaterThan(0.95);
    expect(r).toBeGreaterThan(0xf0);
    expect(gg).toBeGreaterThan(0xa0);
    expect(r).toBeGreaterThan(b);
  });

  // Review 2026-11-13: the glow stayed saturated orange ~3 s after the kill,
  // and the crack behind the white-hot head was as white as the head. Now:
  // white only at the front (0.12 s), bright orange for about half a second,
  // a red ember by ~2 s.
  it('white-hot only at the front, then bright orange for about half a second', () => {
    wreckGlowAt(0.2, g);
    expect(rgb(g.color)[1], 'orange 0.2 s behind the head, not white').toBeLessThan(0xa8);
    wreckGlowAt(0.5, g);
    const [r, gg] = rgb(g.color);
    expect(g.alpha).toBeGreaterThan(0.85);
    expect(r).toBeGreaterThan(0xe0);
    expect(gg).toBeGreaterThan(0x60);
  });

  it('no longer bright orange at 4.5 s (review: "still bright orange at 4.5 s")', () => {
    wreckGlowAt(4.5, g);
    const [r, gg] = rgb(g.color);
    expect(g.alpha * r, 'faint, dark red').toBeLessThan(0.3 * 255);
    expect(gg).toBeLessThan(0x30);
  });

  it('a dull ember at ~2 s: red, dimmer, still showing', () => {
    expect(WRECK_GLOW_EMBER_S).toBeGreaterThanOrEqual(1.5);
    expect(WRECK_GLOW_EMBER_S).toBeLessThanOrEqual(2.5);
    expect(WRECK_GLOW_END_S, 'dark by ~4.5 s').toBeLessThanOrEqual(5);
    wreckGlowAt(WRECK_GLOW_EMBER_S, g);
    const [r, gg, b] = rgb(g.color);
    expect(g.alpha).toBeGreaterThan(0.2);
    expect(g.alpha).toBeLessThan(0.85);
    expect(r).toBeLessThan(0xd0);
    expect(r).toBeGreaterThan(gg * 2);
    expect(r).toBeGreaterThan(b * 2);
  });

  it('dark at the end, and stays dark for ever', () => {
    for (const t of [WRECK_GLOW_END_S, WRECK_GLOW_END_S + 1, 600, Infinity]) {
      wreckGlowAt(t, g);
      expect(g.alpha, `t=${t}`).toBe(0);
    }
  });

  it('cools monotonically (never re-brightens)', () => {
    let prev = Infinity;
    for (let t = 0; t <= WRECK_GLOW_END_S; t += 0.1) {
      wreckGlowAt(t, g);
      const [r, gg, b] = rgb(g.color);
      const lum = (r + gg + b) * g.alpha;
      expect(lum).toBeLessThanOrEqual(prev + 1e-9);
      prev = lum;
    }
  });

  it('cut edges only: the glow runs cover exactly the flagged edges', () => {
    const flags = [false, true, true, false, false, true, false, true];
    const runs = cutEdgeRuns(flags);
    const covered = new Array(flags.length).fill(false);
    for (const [start, len] of runs) for (let k = 0; k < len; k++) covered[(start + k) % flags.length] = true;
    expect(covered).toEqual(flags);
    expect(cutEdgeRuns([false, false, false])).toEqual([]);
    // A run that wraps round the end joins into one polyline.
    expect(cutEdgeRuns([true, false, true, true])).toEqual([[2, 3]]);
    // Every real piece has both cut and uncut edges (a battleship hull piece).
    for (const p of rebuildWreckPieces(DESC)) {
      const n = cutEdgeRuns(p.cutEdges).reduce((s, [, len]) => s + len, 0);
      expect(n).toBe(p.cutEdges.filter(Boolean).length);
    }
  });
});

describe('wreckBlasts: the break-up explosion at the kill point (money-shot review)', () => {
  it('fireballs at the kill point, sized by the hull, never covering the hull', () => {
    // Review: "a large flat white translucent disc plus a grey halo covers
    // the mid-hull". FxExplosions draws radius r as a 2r fireball under a
    // soft 3.4r glow: everything stays within 0.25 of the wreck radius.
    for (const R of [2200, 2900, 600]) {
      const out: WreckBlast[] = [];
      const n = wreckBlasts(1000, -500, R, 12345, out);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(out[0]!.x).toBe(1000);
      expect(out[0]!.y).toBe(-500);
      for (let i = 0; i < n; i++) {
        const b = out[i]!;
        const reach = Math.hypot(b.x - 1000, b.y + 500) + 1.7 * b.r;
        expect(reach, `blast ${i} at R=${R}`).toBeLessThan(0.25 * R);
        expect(b.r, 'scales with the hull (#18)').toBeGreaterThan(0.04 * R);
      }
    }
  });

  it('a dying capital in a wreck room leaves its blast to the break-up; everything else keeps #493', () => {
    expect(hullDeathBlastReplaced(true, true)).toBe(true);
    expect(hullDeathBlastReplaced(true, false), 'a fighter still explodes').toBe(false);
    expect(hullDeathBlastReplaced(false, true), 'wrecks off: the hull-sized blast stays').toBe(false);
    expect(hullDeathBlastReplaced(undefined, true)).toBe(false);
  });

  it('deterministic per seed; directions differ between seeds', () => {
    const a: WreckBlast[] = [];
    const b: WreckBlast[] = [];
    const c: WreckBlast[] = [];
    wreckBlasts(0, 0, 2000, 7, a);
    wreckBlasts(0, 0, 2000, 7, b);
    wreckBlasts(0, 0, 2000, 99999, c);
    expect(a).toEqual(b);
    expect(a[1]!.x).not.toBeCloseTo(c[1]!.x);
  });
});

describe('a cut kill splits at once: no crack front, no ripples (weapon cuts)', () => {
  const span = { crackMin: 50, crackReach: 400 };

  it('crackFrontAt with no hold has every crack reached from the death on', () => {
    expect(crackFrontAt(span, 0, true)).toBe(400);
    expect(crackFrontAt(span, 16, true)).toBe(400);
    expect(crackFrontAt(span, -1, true)).toBe(-Infinity);
    expect(crackIgniteMs(span, 300, true)).toBe(0);
  });

  it('without no-hold the front still runs (unchanged)', () => {
    expect(crackFrontAt(span, 0)).toBe(50);
    expect(crackFrontAt(span, WRECK_CRACK_FRONT_MS / 2)).toBeCloseTo(225, 6);
    expect(crackFrontAt(span, WRECK_CRACK_FRONT_MS)).toBe(400);
    expect(crackIgniteMs(span, 225)).toBeCloseTo(WRECK_CRACK_FRONT_MS / 2, 6);
  });

  it('a fresh wreck with a cutKind is no-hold and gets no ripples; an un-cut one keeps them', () => {
    const cut: WreckDescriptor = { ...DESC, deathTick: 100, cutKind: 'channel', cutAng: 0.3, cutW: 20 };
    const plain: WreckDescriptor = { ...DESC, wreckId: 4, deathTick: 100 };
    const art = new WreckArtState(null, () => {});
    const pose = { x: 0, y: 0, angle: 0 };
    const ci = art.infoFor(cut, rebuildWreckPieces(cut), 0, pose, 101, 1000);
    const pi = art.infoFor(plain, rebuildWreckPieces(plain), 0, pose, 101, 1000);
    expect(ci.noHold).toBe(true);
    expect(ci.ripples).toHaveLength(0);
    expect(crackFrontAt(ci, 0, ci.noHold)).toBe(ci.crackReach);
    expect(pi.noHold).toBe(false);
    expect(pi.ripples.length).toBeGreaterThan(0);
  });
});

describe('a kill cut glows in the weapon\'s colour (weapon cuts, look)', () => {
  const g = (): WreckGlow => ({ color: 0, alpha: 0 });
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const near = (a: number, b: number, tol: number): boolean => rgb(a).every((v, i) => Math.abs(v - rgb(b)[i]!) <= tol);

  it('glowTintOf: an EDGE_CUT edge of a cut kill is tinted by the cut kind, its other cracks are splinters', () => {
    expect(glowTintOf(EDGE_CUT, 'slice')).toBe(GLOW_TINT_SLICE);
    expect(glowTintOf(EDGE_CUT, 'channel')).toBe(GLOW_TINT_CHANNEL);
    expect(glowTintOf(EDGE_CUT, undefined)).toBe(GLOW_TINT_CRACK);
    for (const k of [EDGE_HULL, 1, 2, 3, 4]) {
      expect(glowTintOf(k, 'slice')).toBe(GLOW_TINT_SPLINTER);
      expect(glowTintOf(k, 'channel')).toBe(GLOW_TINT_SPLINTER);
      expect(glowTintOf(k, undefined)).toBe(GLOW_TINT_CRACK);
    }
  });

  it('a slice edge burns the heavy beam\'s violet while hot', () => {
    for (const s of [0.12, 0.3, 0.6]) {
      const c = wreckGlowAt(s, g(), GLOW_TINT_SLICE).color;
      expect(near(c, HEAVY_BEAM_COLOR, 2), `${s} s: 0x${c.toString(16)}`).toBe(true);
    }
    // The instant of the cut: the beam's pale core (violet, blue over green).
    const [r0, g0, b0] = rgb(wreckGlowAt(0, g(), GLOW_TINT_SLICE).color);
    expect(b0).toBeGreaterThan(g0);
    expect(r0).toBeGreaterThan(g0);
  });

  // Filmed review 2026-11-15 (heavy-beam kill on a heavy cruiser): the slice
  // read as a 1–2 px violet hairline while the jagged splinter cracks beside
  // it burned white-yellow then orange, and no violet was left once the beam
  // stopped. Owner: the cut glows in the weapon's colour, cooling through
  // ember to dark. The kill cut is the hero: wider, brighter, longer.
  const lum = (w: WreckGlow): number => rgb(w.color).reduce((a, b) => a + b, 0) * w.alpha;

  it('a slice edge holds the beam\'s violet at full for ~1.5 s (a splinter crack is an ember by then)', () => {
    expect(CUT_GLOW_HOLD_S).toBeGreaterThanOrEqual(1.4);
    for (const s of [0.12, 0.6, 1.0, 1.4]) {
      const w = wreckGlowAt(s, g(), GLOW_TINT_SLICE);
      expect(near(w.color, HEAVY_BEAM_COLOR, 6), `${s} s: 0x${w.color.toString(16)}`).toBe(true);
      expect(w.alpha, `${s} s at full`).toBeGreaterThan(0.97);
    }
  });

  // Hostile film review 2026-11-15 (beam take 6): ~3.5 s after the kill the
  // slice lips were still saturated violet, cooling straight to dark. Burnt
  // metal passes through an ember: the beam's violet for ~1.5 s, then a warm
  // orange-red ember (as the channel cools) to scorch, dark by 4.5 s.
  it('a slice edge cools from violet through a warm orange-red ember to dark', () => {
    for (const s of [2.0, 2.4, 2.8, 3.0]) {
      const w = wreckGlowAt(s, g(), GLOW_TINT_SLICE);
      const [r, gg, b] = rgb(w.color);
      expect(w.alpha, `${s} s still showing`).toBeGreaterThan(0.5);
      expect(r, `${s} s ember: red-hot`).toBeGreaterThanOrEqual(0xc0);
      expect(r - gg, `${s} s ember: orange-red, not yellow`).toBeGreaterThanOrEqual(0x60);
      expect(gg, `${s} s ember: warm, not violet (green over blue)`).toBeGreaterThan(b);
    }
    expect(wreckGlowAt(WRECK_GLOW_END_S, g(), GLOW_TINT_SLICE).alpha).toBe(0);
    expect(wreckGlowAt(4.45, g(), GLOW_TINT_SLICE).alpha).toBeLessThan(0.05);
  });

  // Hostile film review 2026-11-15 (beam take 8): the slice went violet →
  // red/coral (~1 s after the hold) → orange, backwards for cooling metal.
  // Hot metal cools orange → red → dark: after the violet hold the slice is
  // an orange ember first, then deep red, scorch, dark; no rose step. The
  // channel likewise: white → yellow/orange → red → dark.
  const greenShare = (c: number): number => { const [r, gg] = rgb(c); return r > 0 ? gg / r : 0; };
  it('after the hold a cut cools orange -> deep red -> dark, never red before orange (hot-metal order)', () => {
    for (const tint of [GLOW_TINT_SLICE, GLOW_TINT_CHANNEL]) {
      // From the end of the hold's colour shift to the deep red, the hue only
      // reddens (green's share of red never rises) and blue never beats
      // green: no rose/coral step. (Past the red it fades to a dim brown
      // scorch, then dark.)
      const from = tint === GLOW_TINT_SLICE ? 1.8 : 2.0;
      let prev = Infinity;
      for (let s = from; s <= 3.4 + 1e-9; s += 0.05) {
        const c = wreckGlowAt(s, g(), tint).color;
        const [, gg, b] = rgb(c);
        expect(greenShare(c), `tint ${tint} ${s.toFixed(2)} s: only reddens (0x${c.toString(16)})`).toBeLessThanOrEqual(prev + 1e-9);
        prev = greenShare(c);
        expect(b, `tint ${tint} ${s.toFixed(2)} s: no rose (blue over green, 0x${c.toString(16)})`).toBeLessThanOrEqual(gg);
      }
      // Orange first (just after the hold) ...
      const early = wreckGlowAt(tint === GLOW_TINT_SLICE ? 1.9 : 2.6, g(), tint).color;
      expect(greenShare(early), `tint ${tint}: an orange ember first (0x${early.toString(16)})`).toBeGreaterThanOrEqual(0.42);
      // ... then deep red.
      const late = wreckGlowAt(3.4, g(), tint);
      expect(greenShare(late.color), `tint ${tint}: deep red by 3.4 s (0x${late.color.toString(16)})`).toBeLessThanOrEqual(0.25);
      expect(late.alpha, `tint ${tint}: the red still shows`).toBeGreaterThan(0.35);
    }
    // The slice leaves the violet quickly (a long violet → orange blend reads
    // as a pink step): orange by 1.8 s.
    const [r, gg, b] = rgb(wreckGlowAt(1.8, g(), GLOW_TINT_SLICE).color);
    expect(gg, 'slice at 1.8 s: orange, not pink').toBeGreaterThan(b);
    expect(r).toBeGreaterThanOrEqual(0xf0);
  });

  it('a channel edge stays white-hot for ~1.5 s, then cools like struck metal to dark', () => {
    for (const s of [0, 0.12, 0.6, 1.0, 1.4]) {
      const w = wreckGlowAt(s, g(), GLOW_TINT_CHANNEL);
      expect(Math.min(...rgb(w.color)), `${s} s: white`).toBeGreaterThanOrEqual(0xe8);
      expect(w.alpha).toBeGreaterThan(0.97);
    }
    // The plain crack at 0.3 s is orange: the channel is clearly whiter.
    expect(rgb(wreckGlowAt(0.3, g()).color)[2]).toBeLessThan(0x60);
    expect(wreckGlowAt(WRECK_GLOW_END_S, g(), GLOW_TINT_CHANNEL).alpha).toBe(0);
  });

  it('a kill cut is never dimmer than a splinter crack of the same age, and cools monotonically', () => {
    for (const t of [GLOW_TINT_SLICE, GLOW_TINT_CHANNEL]) {
      let prev = Infinity;
      for (let s = 0.12; s <= WRECK_GLOW_END_S + 0.2; s += 0.05) {
        const cut = wreckGlowAt(s, g(), t), crack = wreckGlowAt(s, g());
        expect(cut.alpha, `tint ${t} ${s.toFixed(2)} s`).toBeGreaterThanOrEqual(crack.alpha - 1e-9);
        expect(lum(cut)).toBeLessThanOrEqual(prev + 1e-9);
        prev = lum(cut);
      }
      // Clearly brighter mid-life, when the crack is already an ember.
      expect(wreckGlowAt(1.4, g(), t).alpha).toBeGreaterThan(wreckGlowAt(1.4, g()).alpha + 0.25);
    }
  });

  it('splinter cracks keep their look: the default tint is the crack curve, and cracks are 1× wide', () => {
    for (const s of [0, 0.3, 1, 2.5]) expect(wreckGlowAt(s, g(), GLOW_TINT_CRACK)).toEqual(wreckGlowAt(s, g()));
    expect(glowWidthMul(GLOW_TINT_CRACK)).toBe(1);
    expect(glowWidthMul(GLOW_TINT_SLICE)).toBeGreaterThanOrEqual(CUT_GLOW_WIDTH_MUL);
    expect(glowWidthMul(GLOW_TINT_CHANNEL)).toBe(CUT_GLOW_WIDTH_MUL);
    expect(CUT_GLOW_WIDTH_MUL).toBeGreaterThanOrEqual(2);
  });

  it('the simple (sub-capital) glow tints the same way, longer, and ends on its own red and dark', () => {
    for (const f of [0.2, 0.45]) {
      expect(near(simpleGlowAt(f, g(), GLOW_TINT_SLICE).color, HEAVY_BEAM_COLOR, 2)).toBe(true);
      expect(Math.min(...rgb(simpleGlowAt(f, g(), GLOW_TINT_CHANNEL).color))).toBeGreaterThanOrEqual(0xe8);
    }
    for (const f of [0.85, 0.99]) {
      expect(simpleGlowAt(f, g(), GLOW_TINT_SLICE).color).toBe(simpleGlowAt(f, g()).color);
      expect(simpleGlowAt(f, g(), GLOW_TINT_CHANNEL).color).toBe(simpleGlowAt(f, g()).color);
    }
  });

  it('a slice kill\'s piece: EDGE_CUT edges glow violet, its other cuts are subdued splinters (one glow mesh)', () => {
    for (const cutKind of ['slice', 'channel'] as const) {
      const d: WreckDescriptor = { ...DESC, wreckId: 40, killX: 300, killY: 0, deathTick: 100, cutKind, cutAng: 32768, cutW: 120 };
      const pieces = rebuildWreckPieces(d)!;
      const art = new WreckArtState(null, () => {});
      let cutEdges = 0, others = 0, maxCut = 0, maxCrack = 0;
      for (let pi = 0; pi < pieces.length; pi++) {
        const p = pieces[pi]!;
        const info = art.infoFor(d, pieces, pi, { x: 0, y: 0, angle: 0 }, 100, 1000);
        const sprite = new WreckPieceSprite(p, d.parentKind, null, info, pi);
        sprite.update(1000 + 300, 0);
        const meshes = sprite.children.filter((c) => c instanceof Mesh && (c as Mesh).texture === wreckGlowTexture());
        if (p.cutEdges.some(Boolean)) expect(meshes, 'one glow mesh per piece').toHaveLength(1);
        for (let i = 0; i < p.cutEdges.length; i++) {
          if (!p.cutEdges[i]) { expect(sprite.edgeTint(i)).toBe(-1); continue; }
          if (p.cutEdges[i] === EDGE_CUT) {
            cutEdges++;
            maxCut = Math.max(maxCut, sprite.edgeCoreWidth(i));
            expect(sprite.edgeTint(i)).toBe(cutKind === 'slice' ? GLOW_TINT_SLICE : GLOW_TINT_CHANNEL);
            const c = sprite.edgeColor(i);
            if (cutKind === 'slice') expect(near(c, HEAVY_BEAM_COLOR, 2), `0x${c.toString(16)}`).toBe(true);
            else expect(Math.min(...rgb(c))).toBeGreaterThanOrEqual(0xe8);
          } else {
            others++;
            maxCrack = Math.max(maxCrack, sprite.edgeCoreWidth(i));
            expect(sprite.edgeTint(i)).toBe(GLOW_TINT_SPLINTER);
            expect(sprite.edgeColor(i)).toBe(wreckGlowAt(0.3, g(), GLOW_TINT_SPLINTER).color);
          }
        }
        sprite.destroy({ children: true });
      }
      expect(cutEdges, `${cutKind}: some EDGE_CUT edges`).toBeGreaterThan(0);
      expect(others, `${cutKind}: some splinter cracks too`).toBeGreaterThan(0);
      // The kill cut's strip is the widest line on the wreck, baked into the
      // same mesh: its core reaches CUT_GLOW_WIDTH_MUL × a crack's (unless the
      // piece is too thin there), and a splinter's is half a crack's.
      expect(maxCut, `${cutKind}: widest cut core`).toBeGreaterThan((maxCrack / SPLINTER_GLOW_WIDTH_MUL) * (glowWidthMul(cutKind === 'slice' ? GLOW_TINT_SLICE : GLOW_TINT_CHANNEL) - 0.5));
      expect(maxCrack).toBeGreaterThan(0);
    }
  });

  // Hostile film review 2026-11-15 (beam take 8): the slice's hot edge was
  // thin (~6–7 px) and pale lavender, not white-hot at the very edge. It
  // reads as molten metal: a hot white-violet rim for the first ~0.5 s, and
  // a wider band than the channel's.
  it('a slice\'s edge row is white-violet hot for ~0.5 s, then the violet rim', () => {
    const tex = wreckGlowTexture(), src = tex.source;
    const data = src.resource as Uint8Array, W = src.width;
    const at = (ageS: number): [number, number, number] => {
      const i = Math.round((ageS / WRECK_GLOW_END_S) * (W - 1));
      const o = ((GLOW_TINT_SLICE * GLOW_ROWS_PER_TINT + GLOW_ROW.EDGE) * W + i) * 4;
      return [data[o]!, data[o + 1]!, data[o + 2]!];
    };
    for (const s of [0.1, 0.3, 0.45]) {
      const [r, gg, b] = at(s);
      expect(Math.min(r, gg, b), `${s} s: white-hot at the edge (${r},${gg},${b})`).toBeGreaterThanOrEqual(0xd0);
      expect(b, `${s} s: still violet-white (blue on top)`).toBeGreaterThan(gg);
    }
    // Past ~0.8 s the rim is the beam's violet again (only a pale blend).
    const [, g1, b1] = at(1.0);
    expect(b1 - g1, '1.0 s: violet rim').toBeGreaterThanOrEqual(0x40);
  });

  it('a slice\'s glow band is wider than the channel\'s (molten metal, not a hairline)', () => {
    expect(glowWidthMul(GLOW_TINT_SLICE)).toBeGreaterThanOrEqual(2.8);
    expect(glowWidthMul(GLOW_TINT_SLICE)).toBeGreaterThan(glowWidthMul(GLOW_TINT_CHANNEL));
  });

  it('the glow texture bakes one block of rows per tint (a gradient across a kill cut\'s strip)', () => {
    const tex = wreckGlowTexture();
    expect(tex.source.height).toBe(WRECK_GLOW_TEX_ROWS);
    expect(WRECK_GLOW_TEX_ROWS).toBe(GLOW_ROWS_PER_TINT * WRECK_GLOW_TINTS);
    expect(glowV(GLOW_TINT_CRACK, 0)).toBeCloseTo(0.5 / WRECK_GLOW_TEX_ROWS);
    expect(glowV(GLOW_TINT_SPLINTER, GLOW_ROWS_PER_TINT - 1)).toBeCloseTo((WRECK_GLOW_TEX_ROWS - 0.5) / WRECK_GLOW_TEX_ROWS);
    // Each gradient runs between ADJACENT rows (the linear filter blends them).
    expect(GLOW_ROW.DEEP - GLOW_ROW.EDGE).toBe(1);
    expect(GLOW_ROW.HALO_OUT - GLOW_ROW.HALO).toBe(1);
    expect(GLOW_ROW.BLEED - GLOW_ROW.BLEED_OUT).toBe(1);
  });
});

describe('a channel kill sheds ash along the channel (weapon cuts, look)', () => {
  type Seen = { x: number; y: number; ch: { ax: number; ay: number; bx: number; by: number } | null };
  const breakOf = (d: WreckDescriptor): Seen[] => {
    const seen: Seen[] = [];
    const art = new WreckArtState((x, y, _r, _s, _seed, _fx, ch) => {
      seen.push({ x, y, ch: ch === null ? null : { ...ch } });
    }, () => {});
    art.infoFor(d, rebuildWreckPieces(d)!, 0, { x: 5000, y: -2000, angle: 0.7 }, 101, 1000);
    return seen;
  };

  it('the break-up sink gets the channel line (kill point to the far wall end) only for a channel kill', () => {
    const base = { ...DESC, killX: 300, killY: 0, deathTick: 100, cutAng: 32768, cutW: 120 };
    const ch = breakOf({ ...base, wreckId: 50, cutKind: 'channel' });
    expect(ch).toHaveLength(1);
    const line = ch[0]!.ch!;
    expect(line, 'a channel line').not.toBeNull();
    expect(line.ax).toBe(ch[0]!.x);
    expect(line.ay).toBe(ch[0]!.y);
    // It runs across the hull: a good share of the wreck's size long.
    const pieces = rebuildWreckPieces({ ...base, wreckId: 50, cutKind: 'channel' })!;
    let hullR = 0;
    for (const p of pieces) hullR = Math.max(hullR, Math.hypot(p.cx, p.cy) + p.radius);
    expect(Math.hypot(line.bx - line.ax, line.by - line.ay)).toBeGreaterThan(0.2 * hullR);
    expect(breakOf({ ...base, wreckId: 51, cutKind: 'slice' })[0]!.ch, 'a slice has no ash line').toBeNull();
    expect(breakOf({ ...DESC, wreckId: 52, deathTick: 100 })[0]!.ch, 'no cut, no ash').toBeNull();
  });

  // Hostile film review 2026-11-15 (beam take 8): on a cut kill the break-up
  // shards read as confetti; the renderer tones them down for a cut kill,
  // so the break-up sink must say whether the kill was a cut.
  it('the break-up sink is told whether the kill was a weapon cut (slice or channel)', () => {
    const cutOf = (d: WreckDescriptor): boolean | undefined => {
      let seen: boolean | undefined;
      const art = new WreckArtState((_x, _y, _r, _s, _seed, _fx, _ch, cut) => { seen = cut; }, () => {});
      art.infoFor(d, rebuildWreckPieces(d)!, 0, { x: 0, y: 0, angle: 0 }, 101, 1000);
      return seen;
    };
    const base = { ...DESC, killX: 300, killY: 0, deathTick: 100, cutAng: 32768, cutW: 120 };
    expect(cutOf({ ...base, wreckId: 54, cutKind: 'slice' })).toBe(true);
    expect(cutOf({ ...base, wreckId: 55, cutKind: 'channel' })).toBe(true);
    expect(cutOf({ ...DESC, wreckId: 56, deathTick: 100 })).toBe(false);
  });

  it('channelFarEnd is null without EDGE_CUT edges', () => {
    const plain = rebuildWreckPieces({ ...DESC, wreckId: 53 })!;
    expect(channelFarEnd(plain, 0, 0)).toBeNull();
  });
});

// Owner decision 2026-11-15, after two hostile reviews of the heavy-beam and
// railgun kill takes on a heavy cruiser: KEEP the v10 splinter cracks (on
// film they form an X across the hull) but tone their glow down so the cut
// reads first. The reviews found (1) the splinters' orange rims wider,
// brighter and longer-lived than the cut, (2) the cut glow drawn as four
// violet "bevels" (wedge-ended slabs) on the hull's outer edges instead of a
// glowing edge along the whole cut, (3) the cut dark ~2.3 s after the kill
// with no visible violet ember (intended: full colour ~1.5 s, a clearly
// visible ember, dark at ~4.5 s).
describe('a cut kill reads first: subdued splinters, the whole cut lit, a visible ember (owner 2026-11-15)', () => {
  const hc = shipHullOutline(getShipKind('heavy-cruiser'));
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of hc) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const kill = projectToOutline(hc, { x: 1e4, y: (minY + maxY) / 2 });
  const SEEDS = [3, 7, 12, 21, 33];
  const CUTS = [['slice', HEAVY_BEAM_WIDTH], ['channel', RAILGUN_BOLT_WIDTH]] as const;
  const filmed = (seed: number, cutKind: 'slice' | 'channel' | undefined, cutW: number | undefined): WreckDescriptor => ({
    wreckId: 70 + seed, parentKind: 'heavy-cruiser', seed, killX: kill.x, killY: kill.y,
    killBlowDamage: 1.39, recentDamageRate: 2.4, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: 100,
    ...(cutKind === undefined ? {} : { cutKind, cutAng: 32768, cutW }),
  });
  /** Every piece's sprite, first drawn at the death (game ms 1000). */
  function sprites(d: WreckDescriptor): Array<{ p: WreckPieceGeometry; s: WreckPieceSprite }> {
    const pieces = rebuildWreckPieces(d)!;
    const art = new WreckArtState(null, () => {});
    return pieces.map((p, pi) => {
      const info = art.infoFor(d, pieces, pi, { x: 0, y: 0, angle: 0 }, 100, 1000);
      return { p, s: new WreckPieceSprite(p, d.parentKind, null, info, pi) };
    });
  }
  const g = (): WreckGlow => ({ color: 0, alpha: 0 });
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  /** How bright the glow shows on screen: alpha × its brightest channel. */
  const shown = (w: WreckGlow): number => (w.alpha * Math.max(...rgb(w.color))) / 255;

  it('splinter cracks of a cut kill glow <= 0.5x as bright as the cut, <= 0.25x its core width, and go dark first', () => {
    for (const [cutKind, cutW] of CUTS) {
      for (const seed of SEEDS.slice(0, 3)) {
        const all = sprites(filmed(seed, cutKind, cutW));
        let maxCutCore = 0, maxSplinterCore = 0, splinters = 0;
        for (const ms of [0, 300, 800, 1500, 2000, 2600, 3200, 4000]) {
          let cutA = 0, splA = 0;
          for (const { p, s } of all) {
            s.update(1000 + ms, 0);
            for (let i = 0; i < p.cutEdges.length; i++) {
              if (!p.cutEdges[i]) continue;
              if (p.cutEdges[i] === EDGE_CUT) {
                cutA = Math.max(cutA, s.edgeHeat(i));
                if (ms === 0) maxCutCore = Math.max(maxCutCore, s.edgeCoreWidth(i));
              } else {
                splA = Math.max(splA, s.edgeHeat(i));
                if (ms === 0) { maxSplinterCore = Math.max(maxSplinterCore, s.edgeCoreWidth(i)); splinters++; }
              }
            }
          }
          const age = ms / 1000;
          expect(cutA, `${cutKind} s${seed} ${age} s: the cut glows`).toBeGreaterThan(0);
          expect(splA, `${cutKind} s${seed} ${age} s: splinter alpha <= 0.5 x the cut's`).toBeLessThanOrEqual(0.5 * cutA + 1e-9);
          if (age >= 3) expect(splA, `${cutKind} s${seed} ${age} s: splinters dark first`).toBe(0);
        }
        expect(splinters, `${cutKind} s${seed}: some splinters`).toBeGreaterThan(0);
        expect(maxSplinterCore, `${cutKind} s${seed}: splinter core <= 0.25 x the cut's`).toBeLessThanOrEqual(0.25 * maxCutCore + 1e-6);
        expect(maxSplinterCore).toBeGreaterThan(0);
        for (const { s } of all) s.destroy({ children: true });
      }
    }
  });

  it('a wreck with no cut keeps its cracks as they were (crack curve, 1x wide)', () => {
    for (const { p, s } of sprites(filmed(3, undefined, undefined))) {
      s.update(1000 + WRECK_CRACK_FRONT_MS + 300, 0);
      for (let i = 0; i < p.cutEdges.length; i++) {
        if (p.cutEdges[i]) expect(s.edgeTint(i)).toBe(GLOW_TINT_CRACK);
      }
      s.destroy({ children: true });
    }
  });

  /** Quad corner `n` (0..3) of glow block `block`. */
  const corner = (pos: Float32Array, block: number, n: number): [number, number] => [pos[block * 8 + n * 2]!, pos[block * 8 + n * 2 + 1]!];
  /** How far the glow reaches into the piece (world u) at fraction `f`
   *  along outline edge `i`: the widest of its halo and core quads. */
  function litReach(s: WreckPieceSprite, p: WreckPieceGeometry, i: number, f: number, coreOnly = false): number {
    const pos = s.glowPositions()!, S = s.glowSegments();
    let k = 0;
    for (let j = 0; j < i; j++) if (p.cutEdges[j]) k++;
    let best = 0;
    for (const block of coreOnly ? [S + k] : [k, S + k]) {
      const c = (n: number): [number, number] => corner(pos, block, n);
      const [x3, y3] = c(3), [x2, y2] = c(2);
      const ex = x2 - x3, ey = y2 - y3, el = Math.hypot(ex, ey);
      if (!(el > 1e-9)) continue;
      // Inward normal: toward the quad's outer corners.
      let nx = -ey / el, ny = ex / el;
      const [x0, y0] = c(0), [x1, y1] = c(1);
      if ((x0 + x1 - x2 - x3) * nx + (y0 + y1 - y2 - y3) * ny < 0) { nx = -nx; ny = -ny; }
      // The point `f` along outline edge i (body-local math-up → Pixi-down;
      // the quad runs from the crack's near end, either way round).
      const o = p.outline, a = o[i]!, b = o[(i + 1) % o.length]!;
      const px = a.x + (b.x - a.x) * f, py = -(a.y + (b.y - a.y) * f);
      // The ray from the edge point along the normal: where it leaves the
      // quad (through 3→0, 0→1 or 1→2).
      for (const [a, b] of [[3, 0], [0, 1], [1, 2]] as const) {
        const [ax, ay] = c(a), [bx, by] = c(b);
        const sx = bx - ax, sy = by - ay, den = nx * sy - ny * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((ax - px) * sy - (ay - py) * sx) / den;
        const u = ((ax - px) * ny - (ay - py) * nx) / den;
        if (u >= -1e-6 && u <= 1 + 1e-6 && t > best) best = t;
      }
    }
    return best;
  }
  /** The piece's own thickness (world u) inward from fraction `f` along edge `i`. */
  function thickness(p: WreckPieceGeometry, i: number, f: number): number {
    const o = p.outline, n = o.length, a = o[i]!, b = o[(i + 1) % n]!;
    const el = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / el, ny = (b.x - a.x) / el; // CCW: the inside is on the left
    const px = a.x + (b.x - a.x) * f, py = a.y + (b.y - a.y) * f;
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const c = o[j]!, e = o[(j + 1) % n]!;
      const sx = e.x - c.x, sy = e.y - c.y, den = nx * sy - ny * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - px) * sy - (c.y - py) * sx) / den;
      const u = ((c.x - px) * ny - (c.y - py) * nx) / den;
      if (u >= 0 && u <= 1 && t > 1e-6 && t < best) best = t;
    }
    return best;
  }

  // The hull as drawn: the art is rasterised from the kind's parts (a
  // capital's collider `hull` is their convex hull, wider than the drawn
  // body between the side barbettes: the filmed "white bars stuck onto the
  // hull edge" sat out there, over transparent art).
  // `shipParts` is Pixi-up; the pieces are math-up: flip to match.
  const drawnRings = shipParts(getShipKind('heavy-cruiser')).map((q) => q.pts.map(([x, y]) => ({ x, y: -y })));
  const inPoly = (ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean => {
    let inside = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const u = ring[a]!, w = ring[b]!;
      if ((u.y > y) !== (w.y > y) && x < ((w.x - u.x) * (y - u.y)) / (w.y - u.y) + u.x) inside = !inside;
    }
    return inside;
  };
  /** Whether the point `f` along edge i, a hair inside the piece, is on the drawn hull. */
  function onDrawn(p: WreckPieceGeometry, i: number, f: number): boolean {
    const o = p.outline, a = o[i]!, b = o[(i + 1) % o.length]!, el = Math.hypot(b.x - a.x, b.y - a.y);
    const x = a.x + (b.x - a.x) * f - ((b.y - a.y) / el) * 0.5 + p.cx, y = a.y + (b.y - a.y) * f + ((b.x - a.x) / el) * 0.5 + p.cy;
    return drawnRings.some((r) => inPoly(r, x, y));
  }

  it('every EDGE_CUT edge glows along >= 90 % of its drawn length (no wedge-ended "bevels", no sliver)', () => {
    for (const [cutKind, cutW] of CUTS) {
      for (const seed of SEEDS) {
        const all = sprites(filmed(seed, cutKind, cutW));
        let edges = 0, nominal = 0;
        for (const { p, s } of all) {
          s.update(1000 + 300, 0);
          for (let i = 0; i < p.cutEdges.length; i++) if (p.cutEdges[i] === EDGE_CUT) nominal = Math.max(nominal, s.edgeCoreWidth(i));
        }
        expect(nominal).toBeGreaterThan(0);
        for (const { p, s } of all) {
          for (let i = 0; i < p.cutEdges.length; i++) {
            if (p.cutEdges[i] !== EDGE_CUT) continue;
            edges++;
            // Lit: the core at least a fifth of the cut core's full width,
            // or half of what the piece itself is thick there (a wedge).
            // Over its DRAWN stretch: a capital's outline spans empty space
            // beside its body (transparent art), where nothing glows.
            const N = 100;
            let lit = 0, drawnN = 0;
            for (let m = 0; m <= N; m++) {
              const f = m / N;
              if (!onDrawn(p, i, f)) continue;
              drawnN++;
              if (litReach(s, p, i, f, true) >= Math.min(0.2 * nominal, 0.5 * thickness(p, i, f)) - 1e-6) lit++;
            }
            if (drawnN > 0) expect(lit / drawnN, `${cutKind} s${seed} edge ${i}: lit share of its drawn length`).toBeGreaterThanOrEqual(0.9);
          }
        }
        expect(edges).toBeGreaterThan(0);
        for (const { s } of all) s.destroy({ children: true });
      }
    }
  });

  it('the cut holds full colour ~1.5 s, then a clearly visible warm ember at 3 s, dark at 4.5 s', () => {
    for (const tint of [GLOW_TINT_SLICE, GLOW_TINT_CHANNEL]) {
      expect(shown(wreckGlowAt(1.4, g(), tint)), `tint ${tint} 1.4 s`).toBeGreaterThan(0.9);
      // The ember stage: still clearly showing through ~3 s.
      for (const s of [2.3, 2.6, 3.0]) {
        expect(shown(wreckGlowAt(s, g(), tint)), `tint ${tint} ${s} s: visible`).toBeGreaterThanOrEqual(0.45);
      }
      expect(shown(wreckGlowAt(3.4, g(), tint)), `tint ${tint} 3.4 s`).toBeGreaterThanOrEqual(0.25);
      // Both cool through a warm ember: burnt metal, whatever cut it.
      const [r, gg, b] = rgb(wreckGlowAt(3.0, g(), tint).color);
      expect(r, `tint ${tint} ember: orange-red`).toBeGreaterThanOrEqual(0xc0);
      expect(r - gg, `tint ${tint} ember: orange, not yellow-white`).toBeGreaterThanOrEqual(0x40);
      expect(gg, `tint ${tint} ember: warm`).toBeGreaterThan(b);
      // Dark by ~4.5 s (fading through a dim scorch from ~4 s).
      expect(shown(wreckGlowAt(4.3, g(), tint)), `tint ${tint} 4.3 s: nearly dark`).toBeLessThan(0.12);
      expect(wreckGlowAt(WRECK_GLOW_END_S, g(), tint).alpha).toBe(0);
    }
  });

  it('on the sprite: the cut is still clearly lit 3 s after the kill and dark by 4.5 s', () => {
    for (const [cutKind, cutW] of CUTS) {
      const all = sprites(filmed(3, cutKind, cutW));
      for (const [ms, lo, hi] of [[3000, 0.6, 1], [4500, 0, 0]] as const) {
        let a = 0;
        for (const { p, s } of all) {
          s.update(1000 + ms, 0);
          for (let i = 0; i < p.cutEdges.length; i++) if (p.cutEdges[i] === EDGE_CUT) a = Math.max(a, s.edgeHeat(i));
        }
        expect(a, `${cutKind} ${ms} ms`).toBeGreaterThanOrEqual(lo);
        expect(a, `${cutKind} ${ms} ms`).toBeLessThanOrEqual(hi);
      }
      for (const { s } of all) s.destroy({ children: true });
    }
  });

  // Hostile film reviews 2026-11-15 (rail take 7, beam take 7): the cut glow
  // read as FLAT PAINTED SLABS ("flat pale-white blocky slabs ... like white
  // paint or bricks, they do not glow"; "hard-edged flat strips with no soft
  // glow"), sometimes "white bars stuck onto the hull edge". The cut must read
  // as incandescent metal: brightest AT the cut edge, falling off smoothly
  // into the hull, a soft bleed into the gap, and never past the hull.
  /** The glow mesh's premultiplied RGBA at body-local Pixi-down (x, y): its
   *  triangles composited in draw order on the glow texture (bilinear). */
  function glowRgbaAt(s: WreckPieceSprite, x: number, y: number): [number, number, number, number] {
    const m = s.glowMesh()!, src = wreckGlowTexture().source;
    const data = src.resource as Uint8Array, W = src.width, H = src.height;
    const texel = (tx: number, ty: number): number[] => {
      const o = (Math.min(H - 1, Math.max(0, ty)) * W + Math.min(W - 1, Math.max(0, tx))) * 4, a = data[o + 3]! / 255;
      return [(data[o]! / 255) * a, (data[o + 1]! / 255) * a, (data[o + 2]! / 255) * a, a];
    };
    const sample = (u: number, v: number): number[] => {
      const fx = u * W - 0.5, fy = v * H - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const a = texel(x0, y0), b = texel(x0 + 1, y0), c = texel(x0, y0 + 1), d = texel(x0 + 1, y0 + 1);
      return a.map((_, k) => (a[k]! * (1 - ax) + b[k]! * ax) * (1 - ay) + (c[k]! * (1 - ax) + d[k]! * ax) * ay);
    };
    const out = [0, 0, 0, 0];
    const P = m.positions, U = m.uvs, I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const i0 = I[t]!, i1 = I[t + 1]!, i2 = I[t + 2]!;
      const x0 = P[i0 * 2]!, y0 = P[i0 * 2 + 1]!, x1 = P[i1 * 2]!, y1 = P[i1 * 2 + 1]!, x2 = P[i2 * 2]!, y2 = P[i2 * 2 + 1]!;
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(den) < 1e-9) continue;
      const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / den;
      const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / den, l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const c = sample(l0 * U[i0 * 2]! + l1 * U[i1 * 2]! + l2 * U[i2 * 2]!, l0 * U[i0 * 2 + 1]! + l1 * U[i1 * 2 + 1]! + l2 * U[i2 * 2 + 1]!);
      for (let k = 0; k < 4; k++) out[k] = c[k]! + out[k]! * (1 - c[3]!);
    }
    return out as [number, number, number, number];
  }
  /** On screen: the brightest premultiplied channel. */
  const lum = (c: number[]): number => Math.max(c[0]!, c[1]!, c[2]!);
  /** Un-premultiplied colour channels (0..255). */
  const straight = (c: number[]): number[] => c.slice(0, 3).map((v) => (c[3]! > 1e-6 ? (255 * v) / c[3]! : 0));
  /** Body-local Pixi-down point `d` inward (negative: out into the gap) from `f` along edge i. */
  function across(p: WreckPieceGeometry, i: number, f: number, d: number): [number, number] {
    const o = p.outline, a = o[i]!, b = o[(i + 1) % o.length]!, el = Math.hypot(b.x - a.x, b.y - a.y);
    const mx = -(b.y - a.y) / el, my = (b.x - a.x) / el;
    return [a.x + (b.x - a.x) * f + mx * d, -(a.y + (b.y - a.y) * f + my * d)];
  }

  it('the cut glows like hot metal: brightest at the cut edge, falling off smoothly into the hull, a soft bleed into the gap', () => {
    for (const [cutKind, cutW] of CUTS) {
      for (const seed of SEEDS.slice(0, 3)) {
        const all = sprites(filmed(seed, cutKind, cutW));
        let checked = 0;
        for (const ageMs of [300, 2500]) {
          let nominal = 0;
          for (const { p, s } of all) {
            s.update(1000 + ageMs, 0);
            for (let i = 0; i < p.cutEdges.length; i++) if (p.cutEdges[i] === EDGE_CUT) nominal = Math.max(nominal, s.edgeCoreWidth(i));
          }
          for (const { p, s } of all) {
            for (let i = 0; i < p.cutEdges.length; i++) {
              if (p.cutEdges[i] !== EDGE_CUT) continue;
              for (const f of [0.35, 0.5, 0.65]) {
                // The core's width where it is sampled (a full-width stretch).
                const cw = litReach(s, p, i, f, true);
                if (cw < 0.9 * nominal || thickness(p, i, f) < 2.5 * cw || !onDrawn(p, i, f)) continue;
                const at = (d: number): [number, number, number, number] => glowRgbaAt(s, ...across(p, i, f, d * cw));
                const tag = `${cutKind} s${seed} ${ageMs} ms edge ${i} f${f}`;
                const edge = lum(at(0.03));
                expect(edge, `${tag}: lit at the edge`).toBeGreaterThan(ageMs < 1000 ? 0.85 : 0.4);
                // A gradient, not a flat fill: falling all the way in.
                let prev = edge;
                for (const d of [0.15, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3]) {
                  const l = lum(at(d));
                  expect(l, `${tag}: non-increasing at ${d} x core`).toBeLessThanOrEqual(prev + 0.02);
                  prev = l;
                }
                expect(lum(at(0.5)), `${tag}: half-way in dimmer than the edge`).toBeLessThanOrEqual(0.85 * edge);
                expect(lum(at(0.9)), `${tag}: the core's inner side well dimmer`).toBeLessThanOrEqual(0.5 * edge);
                // Soft: no hard outer edge, it fades out to nothing.
                expect(lum(at((0.97 * litReach(s, p, i, f)) / cw)), `${tag}: faded out at the halo's outer side`).toBeLessThanOrEqual(0.12 * edge);
                if (ageMs < 1000) {
                  // A soft bleed into the gap, dimmer than the edge itself.
                  const bleed = lum(at(-0.08));
                  expect(bleed, `${tag}: bleeds into the gap`).toBeGreaterThan(0.08);
                  expect(bleed, `${tag}: the bleed is softer than the edge`).toBeLessThan(edge);
                  const [r0, g0, b0] = straight(at(0.03)), [r1, g1, b1] = straight(at(0.9));
                  if (cutKind === 'channel') {
                    expect(Math.min(r0!, g0!, b0!), `${tag}: white-hot at the edge`).toBeGreaterThanOrEqual(0xd8);
                    expect(r1! - b1!, `${tag}: yellow-orange deeper in`).toBeGreaterThanOrEqual(0x50);
                  } else {
                    // The edge is a hot white-violet for the first ~0.5 s
                    // (beam take 8 review: "pale lavender, not white-hot"):
                    // whiter, still violet; deeper in, the beam's violet.
                    expect(Math.min(r0!, g0!, b0!), `${tag}: white-hot at the edge`).toBeGreaterThanOrEqual(0xc8);
                    expect(b0! - g0!, `${tag}: white-violet at the edge`).toBeGreaterThanOrEqual(0x20);
                    expect(r0! - g0!, `${tag}: white-violet at the edge`).toBeGreaterThanOrEqual(0x10);
                    expect(b1! - g1!, `${tag}: violet deeper in`).toBeGreaterThanOrEqual(0x30);
                    expect(r1! - g1!, `${tag}: violet deeper in`).toBeGreaterThanOrEqual(0x10);
                  }
                }
                checked++;
              }
            }
          }
        }
        expect(checked, `${cutKind} s${seed}: some cut points checked`).toBeGreaterThan(0);
        for (const { s } of all) s.destroy({ children: true });
      }
    }
  });

  it('no glow strip lies outside its piece, except a small soft bleed into the cut gap (inside the hull)', () => {
    const inRing = (ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean => {
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const p = ring[a]!, q = ring[b]!;
        if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
      }
      return inside;
    };
    const segDist = (x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number => {
      const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / l2)) : 0;
      return Math.hypot(x - a.x - ex * t, y - a.y - ey * t);
    };
    const drawn = drawnRings;
    const onArt = (x: number, y: number, eps: number): boolean =>
      drawn.some((r) => inRing(r, x, y) || r.some((a, k) => segDist(x, y, a, r[(k + 1) % r.length]!) <= eps));
    for (const [cutKind, cutW] of CUTS) {
      for (const seed of SEEDS) {
        const all = sprites(filmed(seed, cutKind, cutW));
        let nominal = 0;
        for (const { p, s } of all) {
          s.update(1000 + 300, 0);
          for (let i = 0; i < p.cutEdges.length; i++) if (p.cutEdges[i] === EDGE_CUT) nominal = Math.max(nominal, s.edgeCoreWidth(i));
        }
        const bleed = 0.5 * nominal, eps = 1;
        let pts = 0;
        for (const { p, s } of all) {
          const m = s.glowMesh();
          if (m === null) continue;
          const o = p.outline, n = o.length, P = m.positions, I = m.indices;
          const outlineDist = (x: number, y: number, cutOnly: boolean): number => {
            let best = Infinity;
            for (let i = 0; i < n; i++) if (!cutOnly || p.cutEdges[i] === EDGE_CUT) best = Math.min(best, segDist(x, y, o[i]!, o[(i + 1) % n]!));
            return best;
          };
          for (let t = 0; t < I.length; t += 3) {
            const v = [I[t]!, I[t + 1]!, I[t + 2]!].map((k) => [P[k * 2]!, -P[k * 2 + 1]!] as const);
            const area = Math.abs((v[1]![0] - v[0]![0]) * (v[2]![1] - v[0]![1]) - (v[2]![0] - v[0]![0]) * (v[1]![1] - v[0]![1]));
            if (area < 1e-6) continue;
            // Its corners and the middles of its sides (body-local, math-up).
            const probe: Array<readonly [number, number]> = [...v];
            for (let a = 0; a < 3; a++) probe.push([(v[a]![0] + v[(a + 1) % 3]![0]) / 2, (v[a]![1] + v[(a + 1) % 3]![1]) / 2]);
            for (const [x, y] of probe) {
              pts++;
              const tag = `${cutKind} s${seed} (${(x + p.cx).toFixed(0)}, ${(y + p.cy).toFixed(0)})`;
              expect(onArt(x + p.cx, y + p.cy, eps), `${tag}: on the drawn hull`).toBe(true);
              if (inRing(o, x, y) || outlineDist(x, y, false) <= eps) continue;
              expect(outlineDist(x, y, true), `${tag}: outside the piece only as a bleed off a cut edge`).toBeLessThanOrEqual(bleed + 1e-3); // float32 positions
              const hx = x + p.cx, hy = y + p.cy;
              expect(onArt(hx, hy, eps), `${tag}: the bleed never past the drawn hull`).toBe(true);
            }
          }
        }
        expect(pts).toBeGreaterThan(0);
        for (const { s } of all) s.destroy({ children: true });
      }
    }
  });
});

describe('a re-split piece\'s slice glow runs the whole cut (owner, re-split take 11)', () => {
  // Owner: "The burn line doesn't cover the whole slice width." A battleship
  // wreck's biggest piece (an end of the hull, off amidships) is sliced again
  // by a heavy beam. Each child's EDGE_CUT edge IS the beam's line across the
  // parent piece (the shared fracture's output, ending on the piece outline),
  // so the glow core must run from end to end of it.
  const kind = 'battleship';
  const hull = shipHullOutline(getShipKind(kind));
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of hull) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const k0 = projectToOutline(hull, { x: 1e4, y: (minY + maxY) / 2 });
  const root: WreckDescriptor = {
    wreckId: 1, parentKind: kind, seed: 5, killX: k0.x, killY: k0.y, killBlowDamage: 1.39, recentDamageRate: 2.4,
    snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: 100, cutKind: 'slice', cutAng: 32768, cutW: HEAVY_BEAM_WIDTH,
  };
  const raw = wreckChainFracture({
    root: {
      kindId: kind, seed: 5, killX: k0.x, killY: k0.y, killBlowDamage: 1.39, recentDamageRate: 2.4, snapChance: 0,
      cutKind: 'slice', cutAng: 32768, cutW: HEAVY_BEAM_WIDTH,
    },
    steps: [],
  });
  let pi = 0;
  for (let i = 1; i < raw.length; i++) if (raw[i]!.area > raw[pi]!.area) pi = i;
  const po = raw[pi]!.outline.map((v) => [v.x, v.y] as const);
  let py0 = Infinity, py1 = -Infinity;
  for (const [, y] of po) { py0 = Math.min(py0, y); py1 = Math.max(py1, y); }
  const kp = projectToOutline(po, { x: -1e4, y: (py0 + py1) / 2 });

  it('each child\'s EDGE_CUT glow core ends at the cut\'s ends on the piece outline (within 2 % of its length)', () => {
    let edges = 0;
    for (const cutAng of [24000, 30000, 32768, 36000]) {
      const child: WreckDescriptor = {
        ...root, wreckId: 2, seed: wreckChildSeed(5, pi), parentWreck: 1, parentPiece: pi, killX: kp.x, killY: kp.y, cutAng,
      };
      const pieces = resolveChildWreckPieces(child, (id) => (id === 1 ? root : undefined))!;
      expect(pieces.length).toBeGreaterThan(1);
      const art = new WreckArtState(null, () => {});
      pieces.forEach((p, i) => {
        const s = new WreckPieceSprite(p, kind, null, art.infoFor(child, pieces, i, { x: 0, y: 0, angle: 0 }, 100, 1000), i);
        s.update(1000, 0);
        const pos = s.glowPositions()!, S = s.glowSegments();
        let k = 0;
        for (let e = 0; e < p.cutEdges.length; e++) {
          if (!p.cutEdges[e]) continue;
          if (p.cutEdges[e] === EDGE_CUT) {
            edges++;
            // The cut's ends on the outline (body-local math-up → Pixi-down).
            const a = p.outline[e]!, b = p.outline[(e + 1) % p.outline.length]!;
            const ea: [number, number] = [a.x, -a.y], eb: [number, number] = [b.x, -b.y];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            // The core quad's corners on the edge (3 and 2), either way round.
            const q = (S + k) * 8;
            const c3: [number, number] = [pos[q + 6]!, pos[q + 7]!], c2: [number, number] = [pos[q + 4]!, pos[q + 5]!];
            const d = (u: [number, number], v: [number, number]): number => Math.hypot(u[0] - v[0], u[1] - v[1]);
            const off = Math.min(Math.max(d(c3, ea), d(c2, eb)), Math.max(d(c3, eb), d(c2, ea)));
            expect(off, `cutAng ${cutAng} piece ${i} edge ${e}: glow end off the cut end (cut ${len.toFixed(0)} u)`)
              .toBeLessThanOrEqual(0.02 * len);
          }
          k++;
        }
        s.destroy({ children: true });
      });
    }
    expect(edges).toBeGreaterThan(0);
  });
});
