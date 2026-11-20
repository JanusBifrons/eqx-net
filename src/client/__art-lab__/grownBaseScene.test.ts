/**
 * Art lab Stage 4 Phase 0b: `scene=structures&kinds=` and `scene=base` from
 * the real base generator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grownExtent } from '../../core/bases/baseSite.js';
import { growLabBase, grownBaseScene } from './grownBaseScene.js';
import { parseGrownBaseParams, parseKinds } from './labSceneParams.js';
import { buildScene, type Cam } from './scenes.js';

const VIEW = { w: 1600, h: 900 };

describe('art lab scene params', () => {
  it('parses ?kinds= in order, dropping unknown ids', () => {
    expect(parseKinds('?kinds=solar,battery,nope,battery_bank,reactor')).toEqual(['solar', 'battery', 'battery_bank', 'reactor']);
    expect(parseKinds('?kinds=nope')).toBeNull();
    expect(parseKinds('')).toBeNull();
  });

  it('parses tier/role/seed with medium defaults', () => {
    expect(parseGrownBaseParams('')).toEqual({ tier: 'settlement', role: 'workshop', seed: 1 });
    expect(parseGrownBaseParams('?tier=citadel&role=trade&seed=42')).toEqual({ tier: 'citadel', role: 'trade', seed: 42 });
    expect(parseGrownBaseParams('?tier=huge&role=x&seed=abc')).toEqual({ tier: 'settlement', role: 'workshop', seed: 1 });
  });
});

describe('art lab structures scene', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows only the ?kinds= kinds', () => {
    vi.stubGlobal('location', { search: '?scene=structures&kinds=solar,battery,battery_bank,reactor' });
    expect(buildScene('structures').structs.map((st) => st.id)).toEqual(['solar', 'battery', 'battery_bank', 'reactor']);
  });

  it('keeps its default sheet without ?kinds=', () => {
    expect(buildScene('structures').structs.map((st) => st.id)).toEqual(['capital', 'solar', 'turret', 'teleporter']);
  });
});

describe('art lab base scene = growBase', () => {
  const p = { tier: 'settlement', role: 'workshop', seed: 7 } as const;

  it('places exactly the generator\'s structures and links, y and rotation flipped to Pixi space', () => {
    const grown = growLabBase(p);
    const s = grownBaseScene(p, VIEW, (z) => z);
    expect(s.structs.length).toBe(grown.placements.length);
    grown.placements.forEach((pl, i) => {
      const st = s.structs[i]!;
      expect([st.id, st.x, st.y]).toEqual([pl.kind, pl.x, -pl.y]);
      expect(st.rot).toBeCloseTo(-((pl.rot ?? 0) * Math.PI) / 180, 9);
    });
    expect(s.edges).toEqual(grown.edges.map(([a, b]) => [a, b]));
    expect(s.structs.some((st) => st.id === 'capital')).toBe(true);
  });

  it('frames the grown extent in the view', () => {
    const grown = growLabBase(p);
    const e = grownExtent(grown.placements);
    const cam: Cam = { x: 0, y: 0, zoom: 1 };
    grownBaseScene(p, VIEW, (z) => z).camera(0, cam);
    expect(cam.x).toBeCloseTo((e.x0 + e.x1) / 2, 6);
    expect(cam.y).toBeCloseTo(-(e.y0 + e.y1) / 2, 6);
    expect((e.x1 - e.x0) * cam.zoom).toBeLessThanOrEqual(VIEW.w);
    expect((e.y1 - e.y0) * cam.zoom).toBeLessThanOrEqual(VIEW.h);
  });

  it('grows a bigger base at a bigger tier, and buildScene reads ?tier=', () => {
    vi.stubGlobal('location', { search: '?scene=base&tier=outpost&seed=3' });
    const small = buildScene('base').structs.length;
    vi.stubGlobal('location', { search: '?scene=base&tier=stronghold&seed=3' });
    const big = buildScene('base').structs.length;
    vi.unstubAllGlobals();
    expect(big).toBeGreaterThan(small);
  });
});
