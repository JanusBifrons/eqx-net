/**
 * Ship livery, treatment 'c' (small accents + faction sigil), and where a
 * sigil must NOT appear. Split from fields.livery.test.ts (see its header).
 * Kinds sampled: the 'c' mirror lock runs CAPITAL_SAMPLE (liveryTestKit.ts)
 * plus a frigate, since a 6x capital forge is ~2 s and every capital takes
 * the same sigil path; every other lock here runs the kinds it names, or
 * every kind / sub-cap / capital.
 */
import { describe, expect, it } from 'vitest';
import { liveryPaint, MAT, shipExtent, shipParts, type Fields, type Livery } from './fields.js';
import { getShipKind, SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { shipTurrets } from './turretLayout.js';
import { CAPITAL_SAMPLE, CAPITALS, forged, pointIn, ppuFor, SUBCAPS } from './liveryTestKit.js';

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
    const plain = forged(id, { ppu: ppuFor(id) });
    const f = forged(id, { ppu: ppuFor(id), livery: SIG });
    let diff = 0;
    for (let i = 0; i < f.cov.length; i++) if (f.cov[i] !== plain.cov[i]) diff++;
    expect(diff).toBe(0);
  });

  it('a scrap piece carries no accents or sigil', () => {
    const f = forged('battleship', { ppu: ppuFor('battleship') * 6, livery: SIG, scrap: true });
    expect(f.mat.some((m) => m === MAT.LIVERY)).toBe(false);
    expect(f.sigils).toBeUndefined();
  });

  it('a battleship carries two sigils on its deck, one fore and one aft', () => {
    const id = 'battleship';
    const f = forged(id, { ppu: ppuC(id), livery: SIG, rings: ringsOf(id) });
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

  // Capitals sampled (CAPITAL_SAMPLE): a 6x capital forge is ~2 s and every
  // capital takes the same path; two deck sigils on EVERY capital are locked
  // under the default 'b8' (fields.livery.capitalSigils.test.ts).
  it.each([...CAPITAL_SAMPLE, 'missile-frigate'])('%s: the livery mask is mirror-symmetric', (id) => {
    const f = forged(id, { ppu: ppuC(id), livery: SIG, rings: ringsOf(id) });
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
    const f = forged('fighter', { ppu: ppuC('fighter'), livery: SIG });
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
    const plain = forged(id, { ppu: ppuC(id), rings });
    const f = forged(id, { ppu: ppuC(id), livery: SIG, rings });
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
    const f = forged(id, { ppu: ppuC(id), livery: SIG });
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
    const f = forged(id, { ppu: ppuC(id), livery: SIG });
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
    const a = forged('missile-frigate', { ppu: 4, livery: SIG });
    const b = forged('missile-frigate', { ppu: 4, livery: { ...SIG, sigil: 0x7f00d5 } });
    let diff = 0;
    for (let i = 0; i < a.mat.length; i++) if ((a.mat[i] === MAT.LIVERY) !== (b.mat[i] === MAT.LIVERY)) diff++;
    expect(diff).toBeGreaterThan(10);
  });
});

describe('no sigil where none belongs', () => {
  const TEAM = 0x4fd0e8;
  const isCap = (id: string): boolean => sizeClassOf(getShipKind(id)) === 'capital';
  const ppuS = (id: string): number => (isCap(id) ? ppuFor(id) * 6 : ppuFor(id));

  for (const treatment of ['a', 'b'] as const) {
    it.each(SUBCAPS)(`%s: no sigil under '${treatment}'`, (id) => {
      const f = forged(id, { ppu: ppuS(id), livery: { treatment, team: TEAM, sigil: 0x1a2b3c } });
      expect(f.sigils).toBeUndefined();
    });
  }

  it.each(['a', 'b'] as const)("a capital scrap piece carries no sigil under '%s'", (treatment) => {
    const f = forged('battleship', { ppu: ppuFor('battleship') * 6, livery: { treatment, team: TEAM, sigil: 0x1a2b3c }, scrap: true });
    expect(f.sigils).toBeUndefined();
  });

  it.each(CAPITALS)("%s: silhouette (cov) unchanged under 'a'", (id) => {
    const plain = forged(id, { ppu: ppuFor(id) });
    const f = forged(id, { ppu: ppuFor(id), livery: { treatment: 'a', team: TEAM, sigil: 0x1a2b3c } });
    let diff = 0;
    for (let i = 0; i < f.cov.length; i++) if (f.cov[i] !== plain.cov[i]) diff++;
    expect(diff).toBe(0);
  });
});
