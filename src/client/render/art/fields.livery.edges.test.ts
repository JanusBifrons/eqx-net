/**
 * Ship livery: the shaped section edges 'b5' / 'b6' / 'b7' / 'b8'. Split from
 * fields.livery.test.ts (see its header). Kinds: the hulls each lock names.
 */
import { describe, expect, it } from 'vitest';
import { lin, MAT, type Fields, type Livery } from './fields.js';
import { turretCoverOf } from './bake.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { shipTurrets } from './turretLayout.js';
import { forged, ppuFor } from './liveryTestKit.js';

/** Shaped section edges 'b5' (chevron) / 'b6' (tongue) / 'b7' (dog-tooth),
 *  and 'b8' (the faction's own edge) (owner, 2026-11-15: "the straight lines
 *  look bad"; "make it a choice per faction"). */
describe("livery 'b5' / 'b6' / 'b7' / 'b8' (shaped section edges)", () => {
  const forge = (id: string, t: Livery['treatment'], ppu = ppuFor(id), edge?: Livery['edge']): Fields =>
    forged(id, { ppu, livery: { treatment: t, team: 0xff4444, sigil: 0x1234, ...(edge ? { edge } : {}) }, turretCover: turretCoverOf(id) });
  const inMark = (f: Fields, i: number): boolean => {
    const { g } = f;
    const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
    return (f.sigils ?? []).some((m) => Math.hypot(wx - m.x, wy - m.y) <= m.r * 1.1);
  };
  it.each(['b5', 'b6', 'b7'] as const)("'%s': the section edges are shaped (paint differs from b4's straight edges)", (t) => {
    // Battleship 0.004: the paint a shape adds keeps a 2x barbette margin.
    for (const [id, min] of [['battleship', 0.004], ['gunship', 0.003]] as const) {
      const a = forge(id, 'b4'), b = forge(id, t);
      let diff = 0, hull = 0;
      for (let i = 0; i < a.cov.length; i++) {
        if (a.cov[i]! <= 0.5) continue;
        hull++;
        if ((a.mat[i] === MAT.LIVERY) !== (b.mat[i] === MAT.LIVERY)) diff++;
      }
      expect(diff / hull).toBeGreaterThan(min);
    }
  });

  it.each(['b5', 'b6', 'b7', 'b8'] as const)("'%s': paint is mirror-symmetric (battleship, gunship)", (t) => {
    for (const id of ['battleship', 'gunship']) {
      const f = forge(id, t, ppuFor(id), 'tooth');
      const { w, h } = f.g;
      let mis = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((f.mat[y * w + x] === MAT.LIVERY) !== (f.mat[y * w + (w - 1 - x)] === MAT.LIVERY)) mis++;
      expect(mis).toBe(0);
    }
  });

  it.each(['b5', 'b6', 'b7'] as const)("'%s': every capital keeps two deck sigils; the gunship keeps its tail flashes", (t) => {
    for (const id of ['battleship']) { // every capital: the b8 loop above
      const f = forged(id, { ppu: ppuFor(id) * 6, livery: { treatment: t, team: 0xff4444, sigil: 0x1a2b3c }, rings: shipTurrets(id).map((q) => ({ x: q.px, y: q.py, r: q.ring })), turretCover: turretCoverOf(id) });
      expect((f.sigils ?? []).map((m) => m.kind)).toEqual(['sigil', 'sigil']);
    }
    const g = forge('gunship', t);
    let tail = 0, hull = 0;
    const { w } = g.g;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < g.cov.length; i++) if (g.cov[i]! > 0.5) { const ty = Math.floor(i / w); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty); }
    for (let i = 0; i < g.cov.length; i++) {
      if (g.cov[i]! <= 0.5) continue;
      hull++;
      if (g.mat[i] === MAT.LIVERY && (Math.floor(i / w) - y0) / (y1 - y0) > 0.55) tail++;
    }
    expect(tail / hull).toBeGreaterThan(0.03);
  });

  it("'b8' wears the livery's own edge: b8 + edge X is b5/b6/b7's shape, and two edges differ only near the section edges", () => {
    for (const id of ['battleship', 'gunship']) {
      const same = (a: Fields, b: Fields): boolean => a.mat.every((m, i) => m === b.mat[i]) && a.albedo.every((v, i) => v === b.albedo[i]);
      expect(same(forge(id, 'b8', ppuFor(id), 'swept'), forge(id, 'b5'))).toBe(true);
      expect(same(forge(id, 'b8', ppuFor(id), 'tongue'), forge(id, 'b6'))).toBe(true);
      expect(same(forge(id, 'b8', ppuFor(id), 'tooth'), forge(id, 'b7'))).toBe(true);
      expect(same(forge(id, 'b8'), forge(id, 'b6'))).toBe(true); // no edge: tongue
    }
    const a = forge('battleship', 'b8', ppuFor('battleship'), 'swept'), b = forge('battleship', 'b8', ppuFor('battleship'), 'tooth');
    const { g } = a;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < a.cov.length; i++) if (a.cov[i]! > 0.5) { const ty = Math.floor(i / g.w); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty); }
    let diff = 0;
    for (let i = 0; i < a.cov.length; i++) {
      if ((a.mat[i] === MAT.LIVERY) === (b.mat[i] === MAT.LIVERY)) continue;
      if (inMark(a, i) || inMark(b, i)) continue;
      diff++;
      const tb = (Math.floor(i / g.w) - y0) / (y1 - y0);
      // Bow edge 0.2 (+ up to 0.14 + jitter); stern edge 1 - 0.085 (- 0.6 x that).
      expect(tb < 0.4 || tb > 0.8, `differs at tb=${tb.toFixed(3)}`).toBe(true);
    }
    expect(diff).toBeGreaterThan(0);
  });

  it.each(['battleship', 'destroyer', 'gunship', 'heavy', 'fighter'])("%s: a shaped edge only adds paint to b4's sections", (id) => {
    const base = forge(id, 'b4');
    for (const [t, edge] of [['b5'], ['b6'], ['b7'], ['b8', 'swept'], ['b8', 'tooth']] as const) {
      const f = forge(id, t, ppuFor(id), edge);
      let lost = 0, liv = 0;
      for (let i = 0; i < base.cov.length; i++) {
        if (base.mat[i] !== MAT.LIVERY || inMark(base, i) || inMark(f, i)) continue;
        liv++;
        if (f.mat[i] !== MAT.LIVERY) lost++;
      }
      expect(liv).toBeGreaterThan(0);
      expect(lost, `${id} ${t}${edge ?? ''}: ${lost}/${liv} b4 paint texels lost`).toBe(0);
    }
  });

  it.each(['b4', 'b8'] as const)("'%s': capital deck sigils are clean team paint (never weathered)", (t) => {
    for (const id of ['battleship', 'destroyer']) {
      const ppu = sizeClassOf(getShipKind(id)) === 'capital' ? ppuFor(id) * 6 : ppuFor(id) * 2;
      const f = forged(id, { ppu, livery: { treatment: t, team: 0xff4444, sigil: 0x1a2b3c, edge: 'tooth' }, rings: shipTurrets(id).map((q) => ({ x: q.px, y: q.py, r: q.ring })), turretCover: turretCoverOf(id) });
      const { g } = f;
      expect(f.sigils?.length ?? 0, id).toBeGreaterThan(0);
      let n = 0;
      for (let i = 0; i < f.cov.length; i++) {
        if (f.mat[i] !== MAT.LIVERY) continue;
        const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
        if (!(f.sigils ?? []).some((m) => Math.hypot(wx - m.x, wy - m.y) <= m.r)) continue;
        n++;
        const want = lin(f.key[i]!);
        for (let c = 0; c < 3; c++) expect(f.albedo[i * 3 + c], `${id} texel ${i}`).toBeCloseTo(want[c]!, 6);
      }
      expect(n, id).toBeGreaterThan(0);
    }
  });
});
