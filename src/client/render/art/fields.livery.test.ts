/**
 * Ship livery, base slice: a grey hull for every kind, the team colour kept
 * for the spot treatments (later slices). Locks:
 *  - no livery ⇒ forge output unchanged (hashes recorded before livery existed);
 *  - livery never changes the silhouette (`cov`);
 *  - livery paint on sub-caps is near-grey; capital greys barely move;
 *  - the robot core ring glows in the team colour.
 */
import { describe, expect, it } from 'vitest';
import { forgeShip, lin, liveryGrey, liveryPaint, MAT, paintLivery, shipExtent, shipParts, type Fields, type Livery } from './fields.js';
import { MAT_COUNT, matTables } from './shade.js';
import { getShipKind, SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { AT_AUTHORED_SHIP_SCALE } from '../../../shared-types/shipScale/config.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';

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
    // A LIVERY texel never lies well inside a deck / superstructure part.
    for (let i = 0; i < f.mat.length; i++) {
      if (f.mat[i] !== MAT.LIVERY) continue;
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu;
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

  it.each(['b', 'c'] as const)("treatment '%s' paints nothing yet", (t) => {
    const f = forgeShip('fighter', { ppu: ppuFor('fighter'), livery: { ...RIM, treatment: t } });
    expect(f.mat.some((m) => m === MAT.LIVERY)).toBe(false);
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
