/**
 * Ship livery, base slice: a grey hull for every kind, the team colour kept
 * for the spot treatments (later slices). Locks:
 *  - no livery ⇒ forge output unchanged (hashes recorded before livery existed);
 *  - livery never changes the silhouette (`cov`);
 *  - livery paint on sub-caps is near-grey; capital greys barely move;
 *  - the robot core ring glows in the team colour;
 *  - treatments 'a' (rim), 'b' (nose / tips / fade) and 'c' (accents + sigil).
 */
import { describe, expect, it } from 'vitest';
import { forgeShip, lin, liveryGrey, liveryPaint, MAT, paintLivery, shipExtent, shipParts, type Fields, type Livery } from './fields.js';
import { MAT_COUNT, matTables } from './shade.js';
import { getShipKind, SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { AT_AUTHORED_SHIP_SCALE } from '../../../shared-types/shipScale/config.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { shipTurrets } from './turretLayout.js';

/** ~240 texels across whatever the size: fast, still every feature. */
const ppuFor = (id: string): number => Math.min(2, 120 / shipExtent(id));

function fnv(h: number, b: ArrayLike<number>): number {
  for (let i = 0; i < b.length; i++) { h ^= b[i]! & 0xff; h = Math.imul(h, 16777619); h ^= (b[i]! >>> 8) & 0xff; h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function fieldsHash(f: Fields): string {
  let h = 2166136261;
  h = fnv(h, new Uint8Array(f.albedo.buffer));
  h = fnv(h, f.mat);
  h = fnv(h, new Uint8Array(f.height.buffer));
  h = fnv(h, new Uint8Array(f.emis.buffer));
  h = fnv(h, new Uint8Array(f.key.buffer));
  return h.toString(16);
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const hex3 = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

const SUBCAPS = SHIP_KINDS_LIST.filter((k) => k.sizeClass !== 'capital').map((k) => k.id);
const CAPITALS = SHIP_KINDS_LIST.filter((k) => k.sizeClass === 'capital').map((k) => k.id);
const LIVERY: Livery = { treatment: 'a', team: 0x3a7bff, sigil: 0xffd23a };


// Recorded with livery undefined on the code BEFORE the livery change (ppuFor,
// shipping ship scale; an authored-scale run forges different sizes).
const BASELINE: Record<string, string> = {
  fighter: 'eb9574d0', 'robot-square': '3d48e441', havok: '55a5cc80', 'trader-hauler': '7d84aabf',
  destroyer: 'ac96ad9e', 'light-cruiser': 'c9e8edcd', battleship: 'f7e19b23', 'battlecruiser-b': 'a037319a', 'heavy-cruiser-c': '45f8a0b5',
};

describe.skipIf(AT_AUTHORED_SHIP_SCALE)('livery: no-livery output is unchanged', () => {
  it.each(Object.keys(BASELINE))('%s', (id) => {
    expect(fieldsHash(forgeShip(id, { ppu: ppuFor(id) }))).toBe(BASELINE[id]);
  });
});

/** sRGB -> CIE Lab (D65), the dE proxy for "barely moved" (CIE76). */
function lab(c: number): [number, number, number] {
  const [r, g, b] = hex3(c).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }) as [number, number, number];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const dE = (a: number, b: number): number => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const linToSrgb8 = (v: number): number => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));

describe('liveryGrey / liveryPaint', () => {
  const capitalCols = [...new Set(CAPITALS.flatMap((id) => shipParts(getShipKind(id)).map((p) => p.color)))];

  it('moves every capital catalogue colour by <= 3 dE (CIE76)', () => {
    expect(capitalCols.length).toBeGreaterThan(5);
    for (const c of capitalCols) expect(dE(c, liveryGrey(c)), c.toString(16)).toBeLessThanOrEqual(3);
  });

  it('turns loud colours into a near-grey with a trace of their hue', () => {
    for (const c of [0x00ff88, 0xc070ff, 0xff4060, 0x3a7bff, 0xffd23a]) {
      const [h0] = hsl(...hex3(c));
      const [h, s, l] = hsl(...hex3(liveryGrey(c)));
      expect(s).toBeGreaterThan(0.05);
      expect(s).toBeLessThanOrEqual(0.12);
      expect(Math.abs(((h - h0 + 540) % 360) - 180)).toBeLessThan(15);
      expect(l).toBeGreaterThan(0.3);
      expect(l).toBeLessThan(0.7);
    }
  });

  it('keeps lightness order (a dark part stays darker than a light one)', () => {
    // Greys, and a spread of hues, sorted by their own lightness.
    const cols: number[] = [];
    for (let v = 0; v <= 255; v += 5) cols.push(v * 0x010101);
    for (let k = 0; k < 200; k++) cols.push(Math.imul(k + 1, 2654435761) >>> 8);
    const ls = cols.map((c) => [hsl(...hex3(c))[2], hsl(...hex3(liveryGrey(c)))[2]] as const).sort((a, b) => a[0] - b[0]);
    let prev = -1;
    for (const [, l] of ls) {
      expect(l).toBeGreaterThanOrEqual(prev - 0.005); // 8-bit rounding only
      prev = Math.max(prev, l);
    }
    // Greys exactly: strictly ordered where the input is.
    for (let v = 5; v <= 255; v += 5) expect(hsl(...hex3(liveryGrey(v * 0x010101)))[2]).toBeGreaterThanOrEqual(hsl(...hex3(liveryGrey((v - 5) * 0x010101)))[2]);
  });

  it('liveryPaint keeps the team colour strong', () => {
    const [h0, s0] = hsl(...hex3(LIVERY.team));
    const [h, s] = hsl(...hex3(liveryPaint(LIVERY.team)));
    expect(Math.abs(h - h0)).toBeLessThan(3);
    expect(s).toBeGreaterThan(s0 * 0.75); // muted(0.92, 0.95): still a strong colour
  });
});

describe('forgeShip with a livery', () => {
  const KINDS = [...SUBCAPS, ...CAPITALS.slice(0, 2)];

  it.each(KINDS)('%s: silhouette (cov) unchanged', (id) => {
    const a = forgeShip(id, { ppu: ppuFor(id) });
    const b = forgeShip(id, { ppu: ppuFor(id), livery: LIVERY });
    expect(b.g.w).toBe(a.g.w);
    expect(b.g.h).toBe(a.g.h);
    let diff = 0;
    for (let i = 0; i < a.cov.length; i++) if (a.cov[i] !== b.cov[i]) diff++;
    expect(diff).toBe(0);
    expect(b.livery).toBe(LIVERY);
    expect(a.livery).toBeUndefined();
  });

  it.each(SUBCAPS)('%s: painted hull is near-grey (mean HSL s < 0.15)', (id) => {
    const f = forgeShip(id, { ppu: ppuFor(id), livery: LIVERY, paint: 0xff0000 });
    let sum = 0, n = 0;
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.PAINT || f.cov[i]! < 0.5) continue;
      sum += hsl(linToSrgb8(f.albedo[i * 3]!), linToSrgb8(f.albedo[i * 3 + 1]!), linToSrgb8(f.albedo[i * 3 + 2]!))[1];
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(sum / n).toBeLessThan(0.15);
  });

  it('a robot core ring glows in the team colour', () => {
    const id = 'robot-circle';
    const kind = getShipKind(id);
    const kindCol = kind.shape.kind === 'polygon' ? kind.shape.color : 0;
    const ringOf = (f: Fields): [number, number, number] => {
      const { g } = f;
      const R = shipExtent(id) * 0.5;
      const s: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < f.mat.length; i++) {
        if (f.mat[i] !== MAT.LIGHT) continue;
        const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
        if (Math.hypot(wx, wy) > R) continue; // not a nav light at the rim
        s[0] += f.emis[i * 3]!; s[1] += f.emis[i * 3 + 1]!; s[2] += f.emis[i * 3 + 2]!;
      }
      return s;
    };
    const cos = (a: readonly number[], b: readonly number[]): number => (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b));
    const want = lin(liveryPaint(LIVERY.team));
    const liv = ringOf(forgeShip(id, { ppu: ppuFor(id), livery: LIVERY }));
    expect(Math.hypot(...liv)).toBeGreaterThan(0);
    expect(cos(liv, want)).toBeGreaterThan(0.999);
    const plain = ringOf(forgeShip(id, { ppu: ppuFor(id) }));
    expect(cos(plain, lin(kindCol))).toBeGreaterThan(0.999);
  });
});

describe('MAT.LIVERY', () => {
  it('has a material table entry (CPU and GPU tables) and fits the 4-bit slot', () => {
    expect(MAT.LIVERY).toBe(9);
    expect(MAT_COUNT).toBe(10);
    const t = matTables();
    expect(t.gloss[MAT.LIVERY]).toBe(22);
    expect(t.spec[MAT.LIVERY]).toBeCloseTo(0.2, 6);
    expect(MAT.LIVERY * 16).toBeLessThan(256);
  });

  it('paintLivery writes the enamel', () => {
    const f = forgeShip('fighter', { ppu: 1, livery: LIVERY });
    const i = f.mat.findIndex((m) => m === MAT.PAINT);
    paintLivery(f, i, LIVERY.team, 0.5);
    expect(f.mat[i]).toBe(MAT.LIVERY);
    expect(f.key[i]).toBe(liveryPaint(LIVERY.team));
    expect(f.albedo[i * 3]).toBeCloseTo(lin(liveryPaint(LIVERY.team))[0] * 0.5, 6);
  });
});

describe("livery treatment 'a' (rim / edge band)", () => {
  const TEAM = 0x4fd0e8;
  const RIM: Livery = { treatment: 'a', team: TEAM, sigil: 0xffd23a };
  const KINDS_A = SHIP_KINDS_LIST.map((k) => k.id).filter((id) => id !== 'cargo-pod');
  const isCapital = (id: string): boolean => sizeClassOf(getShipKind(id)) === 'capital';
  // A capital's deck is a 0.86 inset of the hull line, so its hull band is ~7 %
  // of the half-beam: at the fast ppu that is ~1 texel. Sample capitals 3x finer
  // (still well under a real bake's ppu).
  const ppuA = (id: string): number => ppuFor(id) * (isCapital(id) ? 3 : 1);

  /** Median, over the middle half of the rows, of the LIVERY run at the left edge. */
  function edgeRun(f: Fields): number {
    const { g } = f;
    let y0 = g.h, y1 = -1;
    for (let i = 0; i < f.cov.length; i++) if (f.cov[i]! > 0) { const y = Math.floor(i / g.w); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const runs: number[] = [];
    for (let y = Math.round(y0 + (y1 - y0) * 0.25); y <= Math.round(y0 + (y1 - y0) * 0.75); y++) {
      let x = 0;
      while (x < g.w && f.cov[y * g.w + x]! <= 0) x++;
      let r = 0;
      while (x + r < g.w && f.mat[y * g.w + x + r] === MAT.LIVERY) r++;
      runs.push(r);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)] ?? 0;
  }

  it.each(KINDS_A)('%s: a team-colour rim >= 2 texels wide, silhouette unchanged', (id) => {
    const plain = forgeShip(id, { ppu: ppuA(id) });
    const f = forgeShip(id, { ppu: ppuA(id), livery: RIM });
    let covered = 0, liv = 0;
    for (let i = 0; i < f.cov.length; i++) {
      expect(f.cov[i]).toBe(plain.cov[i]);
      if (f.cov[i]! > 0) covered++;
      if (f.mat[i] === MAT.LIVERY) liv++;
    }
    if (isCapital(id)) expect(liv).toBeGreaterThan(0);
    else expect(liv / covered).toBeGreaterThanOrEqual(0.02);
    expect(edgeRun(f)).toBeGreaterThanOrEqual(2);
  });

  it('LIVERY texels carry the team hue', () => {
    const [h0] = hsl(...hex3(liveryPaint(TEAM)));
    for (const id of ['fighter', 'missile-frigate', 'battleship']) {
      const f = forgeShip(id, { ppu: ppuFor(id), livery: RIM });
      let n = 0;
      for (let i = 0; i < f.mat.length; i++) {
        if (f.mat[i] !== MAT.LIVERY) continue;
        expect(f.key[i]).toBe(liveryPaint(TEAM));
        const [h] = hsl(linToSrgb8(f.albedo[i * 3]!), linToSrgb8(f.albedo[i * 3 + 1]!), linToSrgb8(f.albedo[i * 3 + 2]!));
        expect(Math.abs(((h - h0 + 540) % 360) - 180)).toBeLessThan(8);
        n++;
      }
      expect(n).toBeGreaterThan(0);
    }
  });

  it('a capital keeps its deck and superstructure grey', () => {
    const id = 'battleship';
    const parts = shipParts(getShipKind(id));
    const hull = parts.findIndex((p) => p.role === 'hull');
    expect(hull).toBeGreaterThanOrEqual(0);
    const f = forgeShip(id, { ppu: ppuFor(id), livery: RIM });
    const { g } = f;
    const deck = parts.filter((p) => p.role === 'deck' || p.role === 'superstructure');
    expect(deck.length).toBeGreaterThan(0);
    const marks = f.sigils ?? [];
    // A LIVERY texel never lies well inside a deck / superstructure part
    // (bar the deck sigils every capital carries).
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
      if (marks.some((m) => Math.hypot(wx - m.x, wy - m.y) <= m.r)) continue;
      for (const p of deck) {
        const inset = 2 / g.ppu;
        const inside = [[0, 0], [inset, 0], [-inset, 0], [0, inset], [0, -inset]].every(([dx, dy]) => pointIn(p.pts, wx + dx!, wy + dy!));
        expect(inside).toBe(false);
      }
    }
  });

  it('frigates and cruisers carry a pinstripe inside the rim', () => {
    // A pinstripe is a LIVERY texel separated from the edge by a grey gap.
    const stripe = (id: string): number => {
      const f = forgeShip(id, { ppu: ppuFor(id), livery: RIM });
      const { g } = f;
      let n = 0;
      for (let y = 0; y < g.h; y++) {
        let x = 0;
        while (x < g.w && f.cov[y * g.w + x]! <= 0) x++;
        while (x < g.w && f.mat[y * g.w + x] === MAT.LIVERY) x++;
        let gap = 0;
        while (x < g.w && f.cov[y * g.w + x]! > 0 && f.mat[y * g.w + x] !== MAT.LIVERY) { x++; gap++; }
        if (gap > 0 && x < g.w && f.mat[y * g.w + x] === MAT.LIVERY && x < g.w / 2) n++;
      }
      return n;
    };
    const mid = SHIP_KINDS_LIST.filter((k) => ['frigate', 'cruiser'].includes(sizeClassOf(k)));
    expect(mid.length).toBeGreaterThan(0);
    for (const k of mid) expect(stripe(k.id), k.id).toBeGreaterThan(0);
  });

});

describe("livery treatment 'c' (small accents + faction sigil)", () => {
  const TEAM = 0x4fd0e8;
  const SIG: Livery = { treatment: 'c', team: TEAM, sigil: 0x1a2b3c };
  const ALL = SHIP_KINDS_LIST.map((k) => k.id);
  const isCap = (id: string): boolean => sizeClassOf(getShipKind(id)) === 'capital';
  /** Sub-caps near their bake density (4 texels / unit, less for the huge
   *  engineering hulls); capitals ~6x the fast
   *  ppu, so the deck holds a sigil of a few dozen texels. */
  const ppuC = (id: string): number => (isCap(id) ? ppuFor(id) * 6 : Math.min(4, 180 / shipExtent(id)));
  const ringsOf = (id: string): Array<{ x: number; y: number; r: number }> => shipTurrets(id).map((t) => ({ x: t.px, y: t.py, r: t.ring }));
  const tex = (f: Fields, x: number, y: number): [number, number] => [x * f.g.ppu + f.g.ox, y * f.g.ppu + f.g.oy];

  it.each(ALL)('%s: silhouette (cov) unchanged', (id) => {
    const plain = forgeShip(id, { ppu: ppuFor(id) });
    const f = forgeShip(id, { ppu: ppuFor(id), livery: SIG });
    let diff = 0;
    for (let i = 0; i < f.cov.length; i++) if (f.cov[i] !== plain.cov[i]) diff++;
    expect(diff).toBe(0);
  });

  it('a scrap piece carries no accents or sigil', () => {
    const f = forgeShip('battleship', { ppu: ppuFor('battleship') * 6, livery: SIG, scrap: true });
    expect(f.mat.some((m) => m === MAT.LIVERY)).toBe(false);
    expect(f.sigils).toBeUndefined();
  });

  it('a battleship carries two sigils on its deck, one fore and one aft', () => {
    const id = 'battleship';
    const f = forgeShip(id, { ppu: ppuC(id), livery: SIG, rings: ringsOf(id) });
    const s = f.sigils ?? [];
    expect(s.map((m) => m.kind)).toEqual(['sigil', 'sigil']);
    const parts = shipParts(getShipKind(id));
    let y0 = Infinity, y1 = -Infinity;
    for (const p of parts) for (const [, y] of p.pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const tb = s.map((m) => (m.y - y0) / (y1 - y0));
    expect(tb[0]).toBeLessThan(0.45);
    expect(tb[1]).toBeGreaterThan(0.55);
    expect(Math.abs(s[1]!.y - s[0]!.y)).toBeGreaterThan(s[0]!.r + s[1]!.r); // two separate blobs
    const deck = parts.find((p) => p.role === 'deck')!;
    const { g } = f;
    for (const m of s) {
      expect(m.x).toBe(0);
      expect(m.r * g.ppu).toBeGreaterThanOrEqual(6);
      // Team paint inside each disc, and every painted texel on the deck.
      let n = 0;
      for (let i = 0; i < f.mat.length; i++) {
        if (f.mat[i] !== MAT.LIVERY) continue;
        const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
        if (Math.hypot(wx - m.x, wy - m.y) > m.r) continue;
        expect(f.key[i]).toBe(liveryPaint(TEAM));
        expect(pointIn(deck.pts, wx, wy)).toBe(true);
        n++;
      }
      expect(n).toBeGreaterThan(Math.PI * (m.r * g.ppu) ** 2 * 0.15);
    }
  });

  it.each([...CAPITALS, 'missile-frigate'])('%s: the livery mask is mirror-symmetric', (id) => {
    const f = forgeShip(id, { ppu: ppuC(id), livery: SIG, rings: ringsOf(id) });
    const { g } = f;
    const liv = (x: number, y: number): boolean => x >= 0 && x < g.w && f.mat[y * g.w + x] === MAT.LIVERY;
    let n = 0;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (!liv(x, y)) continue;
        n++;
        const m = g.w - 1 - x;
        expect(liv(m, y) || liv(m - 1, y) || liv(m + 1, y), `${x},${y}`).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(0);
    expect((f.sigils ?? []).length).toBeGreaterThan(0);
  });

  it('a fighter gets the dorsal chevron, clear of its canopy', () => {
    const f = forgeShip('fighter', { ppu: ppuC('fighter'), livery: SIG });
    expect(f.sigils?.map((m) => m.kind)).toEqual(['chevron']);
    const m = f.sigils![0]!;
    expect(m.x).toBe(0);
    // Strokes >= 2 texels: down the centreline the chevron's apex is a run of
    // at least 2 LIVERY texels.
    const [cx, cy] = tex(f, m.x, m.y);
    const { g } = f;
    const col = Math.floor(cx);
    let best = 0, run = 0;
    for (let y = Math.floor(cy - m.r * g.ppu); y <= cy + m.r * g.ppu; y++) {
      run = f.mat[y * g.w + col] === MAT.LIVERY ? run + 1 : 0;
      best = Math.max(best, run);
    }
    expect(best).toBeGreaterThanOrEqual(2);
  });

  it.each(['fighter', 'interceptor', 'missile-frigate', 'trader-hauler', 'destroyer', 'battleship'])('%s: the sigil never lands on glass, nozzles, lights or turret rings', (id) => {
    const rings = ringsOf(id);
    const plain = forgeShip(id, { ppu: ppuC(id), rings });
    const f = forgeShip(id, { ppu: ppuC(id), livery: SIG, rings });
    const { g } = f;
    const marks = f.sigils ?? [];
    expect(marks.length).toBeGreaterThan(0);
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
      if (!marks.some((m) => Math.hypot(wx - m.x, wy - m.y) <= m.r)) continue; // canopy ring / collar
      expect([MAT.PAINT, MAT.METAL, MAT.TRIM], `${id} texel ${i}`).toContain(plain.mat[i]);
      expect(f.height[i]).toBe(plain.height[i]); // flat paint, no relief
      for (const r of rings) expect(Math.hypot(wx - r.x, wy - r.y)).toBeGreaterThan(r.r * 1.15);
    }
  });

  // Not 'el': a 1000 u engineering hull whose canopy is ~2 texels at bake density.
  it.each(SUBCAPS.filter((id) => !id.startsWith('robot') && id !== 'cargo-pod' && id !== 'el'))('%s: a team ring round the canopy, at least 2 texels', (id) => {
    const f = forgeShip(id, { ppu: ppuC(id), livery: SIG });
    const { g } = f;
    // The canopy's foremost glass texel has a run of >= 2 LIVERY texels
    // right in front of it.
    const first = f.mat.findIndex((m) => m === MAT.GLASS);
    expect(first).toBeGreaterThanOrEqual(0);
    const col = first % g.w;
    const y = Math.floor(first / g.w);
    let run = 0;
    while (y - 1 - run >= 0 && f.mat[(y - 1 - run) * g.w + col] === MAT.LIVERY) run++;
    expect(run).toBeGreaterThanOrEqual(2);
  });

  it.each(['fighter', 'missile-frigate', 'battleship'])('%s: team collars round the nozzles', (id) => {
    const f = forgeShip(id, { ppu: ppuC(id), livery: SIG });
    const { g } = f;
    expect(f.nozzles.length).toBeGreaterThan(0);
    for (const nz of f.nozzles) {
      const [cx, cy] = tex(f, nz.x, nz.y - nz.r * 0.6);
      const R = nz.r * g.ppu * 1.05;
      let n = 0;
      for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) if (f.mat[y * g.w + x] === MAT.LIVERY) n++;
      expect(n).toBeGreaterThan(4);
    }
  });

  it('two sigil seeds draw two different emblems', () => {
    const a = forgeShip('missile-frigate', { ppu: 4, livery: SIG });
    const b = forgeShip('missile-frigate', { ppu: 4, livery: { ...SIG, sigil: 0x7f00d5 } });
    let diff = 0;
    for (let i = 0; i < a.mat.length; i++) if ((a.mat[i] === MAT.LIVERY) !== (b.mat[i] === MAT.LIVERY)) diff++;
    expect(diff).toBeGreaterThan(10);
  });
});

describe("livery treatment 'b' (nose, tips and fade)", () => {
  const TEAM = 0x4fd0e8;
  const NOSE: Livery = { treatment: 'b', team: TEAM, sigil: 0xffd23a };
  const ALL = SHIP_KINDS_LIST.map((k) => k.id);
  const cls = (id: string): string => sizeClassOf(getShipKind(id));

  /** Texel -> (bow fraction 0 = nose .. 1 = stern, |x| / half-span) over the covered box. */
  function frame(f: Fields): (i: number) => { tb: number; ax: number } {
    const { g } = f;
    let x1 = 0, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < f.cov.length; i++) {
      if (f.cov[i]! <= 0.5) continue;
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
      x1 = Math.max(x1, Math.abs(wx)); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
    }
    return (i) => ({
      tb: ((Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu - y0) / (y1 - y0),
      ax: Math.abs((i % g.w + 0.5 - g.ox) / g.ppu) / x1,
    });
  }

  it.each(ALL)('%s: silhouette (cov) unchanged', (id) => {
    const plain = forgeShip(id, { ppu: ppuFor(id) });
    const f = forgeShip(id, { ppu: ppuFor(id), livery: NOSE });
    let diff = 0;
    for (let i = 0; i < f.cov.length; i++) if (f.cov[i] !== plain.cov[i]) diff++;
    expect(diff).toBe(0);
  });

  it('a fighter has team paint on its nose and wingtips, none mid-hull', () => {
    const f = forgeShip('fighter', { ppu: ppuFor('fighter'), livery: NOSE });
    const at = frame(f);
    let nose = 0, tipL = 0, tipR = 0, mid = 0;
    const { g } = f;
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      const { tb, ax } = at(i);
      expect(f.key[i]).toBe(liveryPaint(TEAM));
      if (tb < 0.2) nose++;
      if (tb > 0.75 && ax > 0.8) { if ((i % g.w + 0.5 - g.ox) < 0) tipL++; else tipR++; }
      if (tb > 0.35 && tb < 0.75 && ax < 0.3) mid++;
    }
    expect(nose).toBeGreaterThanOrEqual(4);
    expect(tipL).toBeGreaterThanOrEqual(4);
    expect(tipR).toBe(tipL); // mirrored
    expect(mid).toBe(0);
  });

  it('every wingtip run is at least 2 texels wide', () => {
    const f = forgeShip('fighter', { ppu: ppuFor('fighter'), livery: NOSE });
    const { g } = f;
    const at = frame(f);
    for (let y = 0; y < g.h; y++) {
      let x = 0;
      while (x < g.w && f.cov[y * g.w + x]! <= 0.5) x++;
      if (x >= g.w || at(y * g.w + x).tb < 0.3) continue; // nose rows are solid paint
      let r = 0;
      while (x + r < g.w && f.mat[y * g.w + x + r] === MAT.LIVERY) r++;
      if (r > 0) expect(r, `row ${y}`).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(ALL.filter((id) => ['frigate', 'cruiser'].includes(cls(id))))('%s: the bow fade uses at most 3 livery keys', (id) => {
    const f = forgeShip(id, { ppu: ppuFor(id), livery: NOSE });
    const at = frame(f);
    const fade = new Set<number>(), all = new Set<number>();
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      all.add(f.key[i]!);
      const { tb } = at(i);
      if (tb >= 0.15 && tb < 0.4) fade.add(f.key[i]!);
      expect(tb, 'no fade paint past the fade zone except tips').toBeLessThan(at(i).ax > 0.6 ? 2 : 0.45);
    }
    expect(fade.size).toBeGreaterThan(0);
    expect(fade.size).toBeLessThanOrEqual(3);
    expect(all.size).toBeLessThanOrEqual(3);
    expect(all.has(liveryPaint(TEAM))).toBe(true);
  });

  it('missile-frigate fades in exactly 3 steps', () => {
    const f = forgeShip('missile-frigate', { ppu: ppuFor('missile-frigate'), livery: NOSE });
    const keys = new Set<number>();
    for (let i = 0; i < f.mat.length; i++) if (f.mat[i] === MAT.LIVERY) keys.add(f.key[i]!);
    expect(keys.size).toBe(3);
  });

  it.each(ALL.filter((id) => cls(id) !== 'capital'))('%s: a team-coloured tail beacon on the centreline', (id) => {
    const plain = forgeShip(id, { ppu: ppuFor(id) });
    const f = forgeShip(id, { ppu: ppuFor(id), livery: NOSE });
    expect(f.navLights.length).toBe(plain.navLights.length + 1);
    const b = f.navLights.find((l) => l.color === liveryPaint(TEAM));
    expect(b).toBeDefined();
    expect(b!.x).toBe(0);
    expect(b!.y).toBeGreaterThan(0); // aft half (Pixi-up: +y is the stern)
    const { g } = f;
    const i = Math.floor(b!.y * g.ppu + g.oy) * g.w + Math.floor(g.ox);
    expect(f.mat[i]).toBe(MAT.LIGHT);
  });

  it('a scrap piece carries no beacon', () => {
    const f = forgeShip('fighter', { ppu: ppuFor('fighter'), livery: NOSE, scrap: true });
    expect(f.navLights).toHaveLength(0);
  });

  /** Is this texel inside one of the hull's recorded sigil discs? */
  const inSigil = (f: Fields, i: number): boolean => {
    const { g } = f;
    const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
    return (f.sigils ?? []).some((m) => Math.hypot(wx - m.x, wy - m.y) <= m.r);
  };

  it.each(CAPITALS)('%s: at most 8 team running lights, bow and stern fade on the hull only', (id) => {
    const plain = forgeShip(id, { ppu: ppuFor(id) });
    const f = forgeShip(id, { ppu: ppuFor(id), livery: NOSE });
    const extra = f.navLights.length - plain.navLights.length;
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThanOrEqual(8);
    for (const l of f.navLights.slice(plain.navLights.length)) expect(l.color).toBe(liveryPaint(TEAM));
    const at = frame(f);
    const keys = new Set<number>(), bowKeys = new Set<number>(), sternKeys = new Set<number>();
    let stern = 0;
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      keys.add(f.key[i]!);
      if (inSigil(f, i)) continue;
      const { tb } = at(i);
      expect(tb < 0.37 || tb > 0.63, `tb ${tb}`).toBe(true);
      if (tb < 0.37) bowKeys.add(f.key[i]!);
      else { sternKeys.add(f.key[i]!); stern++; }
    }
    expect(stern).toBeGreaterThan(0);
    expect(keys.size).toBeLessThanOrEqual(3);
    expect(bowKeys.size).toBeLessThanOrEqual(3);
    expect(sternKeys.size).toBeLessThanOrEqual(3);
    // The stern steps through the bow's own keys: the ends match.
    for (const k of sternKeys) expect(bowKeys.has(k)).toBe(true);
  });

  it('a capital stern fade is on the hull layer only', () => {
    const id = 'battleship';
    const parts = shipParts(getShipKind(id));
    const deck = parts.filter((p) => p.role === 'deck' || p.role === 'superstructure');
    const f = forgeShip(id, { ppu: ppuFor(id) * 3, livery: NOSE });
    const { g } = f;
    const at = frame(f);
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY || inSigil(f, i) || at(i).tb <= 0.63) continue;
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
      const inset = 2 / g.ppu;
      for (const p of deck) {
        const inside = [[0, 0], [inset, 0], [-inset, 0], [0, inset], [0, -inset]].every(([dx, dy]) => pointIn(p.pts, wx + dx!, wy + dy!));
        expect(inside).toBe(false);
      }
    }
  });

  it.each(['battleship', 'destroyer'])('%s: bow and stern carry comparable team paint (within 2x)', (id) => {
    const f = forgeShip(id, { ppu: ppuFor(id) * 3, livery: NOSE });
    const at = frame(f);
    let bow = 0, stern = 0;
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY || inSigil(f, i)) continue;
      const { tb } = at(i);
      if (tb < 0.35) bow++;
      else if (tb > 0.65) stern++;
    }
    expect(bow).toBeGreaterThan(0);
    expect(stern).toBeGreaterThan(0);
    expect(stern / bow).toBeGreaterThanOrEqual(0.5);
    expect(stern / bow).toBeLessThanOrEqual(2);
  });
});

describe('capital sigils under every treatment', () => {
  const TEAM = 0x4fd0e8;
  const isCap = (id: string): boolean => sizeClassOf(getShipKind(id)) === 'capital';
  const ppuS = (id: string): number => (isCap(id) ? ppuFor(id) * 6 : ppuFor(id));
  const ringsOf = (id: string): Array<{ x: number; y: number; r: number }> => shipTurrets(id).map((t) => ({ x: t.px, y: t.py, r: t.ring }));

  for (const treatment of ['a', 'b', 'c'] as const) {
    it.each(CAPITALS)(`%s: two deck sigils under '${treatment}'`, (id) => {
      const f = forgeShip(id, { ppu: ppuS(id), livery: { treatment, team: TEAM, sigil: 0x1a2b3c }, rings: ringsOf(id) });
      expect((f.sigils ?? []).map((m) => m.kind)).toEqual(['sigil', 'sigil']);
    });
  }

  for (const treatment of ['a', 'b'] as const) {
    it.each(SUBCAPS)(`%s: no sigil under '${treatment}'`, (id) => {
      const f = forgeShip(id, { ppu: ppuS(id), livery: { treatment, team: TEAM, sigil: 0x1a2b3c } });
      expect(f.sigils).toBeUndefined();
    });
  }

  it.each(['a', 'b'] as const)("a capital scrap piece carries no sigil under '%s'", (treatment) => {
    const f = forgeShip('battleship', { ppu: ppuFor('battleship') * 6, livery: { treatment, team: TEAM, sigil: 0x1a2b3c }, scrap: true });
    expect(f.sigils).toBeUndefined();
  });

  it.each(CAPITALS)("%s: silhouette (cov) unchanged under 'a'", (id) => {
    const plain = forgeShip(id, { ppu: ppuFor(id) });
    const f = forgeShip(id, { ppu: ppuFor(id), livery: { treatment: 'a', team: TEAM, sigil: 0x1a2b3c } });
    let diff = 0;
    for (let i = 0; i < f.cov.length; i++) if (f.cov[i] !== plain.cov[i]) diff++;
    expect(diff).toBe(0);
  });
});

function pointIn(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Shade experiments 'b2' / 'b3' (owner, 2026-11-15): sub-cap hull darker and
 *  team paint stronger than 'b'; capital paint weathered into the hull. */
describe("livery shade experiments 'b2' / 'b3'", () => {
  const TEAM = 0xff4444;
  const lv = (t: Livery['treatment']): Livery => ({ treatment: t, team: TEAM, sigil: 0x1234 });
  const meanLum = (f: Fields, m: number): number => {
    let s = 0, c = 0;
    for (let i = 0; i < f.cov.length; i++) {
      if (f.cov[i]! <= 0.5 || f.mat[i] !== m) continue;
      s += 0.2126 * f.albedo[i * 3]! + 0.7152 * f.albedo[i * 3 + 1]! + 0.0722 * f.albedo[i * 3 + 2]!; c++;
    }
    return c ? s / c : NaN;
  };
  const chroma = (f: Fields): number => {
    let s = 0, c = 0;
    for (let i = 0; i < f.cov.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      const r = f.albedo[i * 3]!, g = f.albedo[i * 3 + 1]!, b = f.albedo[i * 3 + 2]!;
      s += Math.max(r, g, b) - Math.min(r, g, b); c++;
    }
    return s / c;
  };

  it('readLivery-shaped treatments keep the b layout (silhouette unchanged, paint present)', () => {
    for (const t of ['b2', 'b3'] as const) {
      const plain = forgeShip('fighter', { ppu: ppuFor('fighter') });
      const f = forgeShip('fighter', { ppu: ppuFor('fighter'), livery: lv(t) });
      for (let i = 0; i < f.cov.length; i++) expect(f.cov[i]).toBe(plain.cov[i]);
      expect(f.mat.some((m) => m === MAT.LIVERY)).toBe(true);
    }
  });

  it('a sub-cap hull gets darker b -> b2 -> b3, and its team paint stronger than b', () => {
    const [b, b2, b3] = (['b', 'b2', 'b3'] as const).map((t) => forgeShip('heavy', { ppu: ppuFor('heavy'), livery: lv(t) }));
    expect(meanLum(b2!, MAT.PAINT)).toBeLessThan(meanLum(b!, MAT.PAINT));
    expect(meanLum(b3!, MAT.PAINT)).toBeLessThan(meanLum(b2!, MAT.PAINT));
    expect(chroma(b2!)).toBeGreaterThan(chroma(b!) * 0.95);
    expect(chroma(b3!)).toBeGreaterThan(chroma(b!));
  });

  it('a capital hull grey is untouched; its paint is toned down and chipped to bare metal', () => {
    const id = 'battleship';
    const b = forgeShip(id, { ppu: ppuFor(id), livery: lv('b') });
    const b2 = forgeShip(id, { ppu: ppuFor(id), livery: lv('b2') });
    expect(b2.paint).toBe(b.paint);
    expect(chroma(b2)).toBeLessThan(chroma(b));
    // Chips: METAL texels where 'b' had LIVERY.
    let liv = 0, chips = 0;
    for (let i = 0; i < b.mat.length; i++) {
      if (b.mat[i] !== MAT.LIVERY) continue;
      liv++;
      if (b2.mat[i] === MAT.METAL) chips++;
    }
    expect(chips / liv).toBeGreaterThan(0.03);
    expect(chips / liv).toBeLessThan(0.4);
  });

  it('running lights keep the bright team colour', () => {
    const f = forgeShip('battleship', { ppu: ppuFor('battleship'), livery: lv('b2') });
    expect(f.navLights.some((l) => l.color === liveryPaint(TEAM))).toBe(true);
  });
});
