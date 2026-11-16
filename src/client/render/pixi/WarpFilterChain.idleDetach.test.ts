import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import { WarpFilterChain } from './WarpFilterChain';

// The real filters compile GL programs, which need a DOM; the chain only sets
// their uniforms, so plain objects stand in.
vi.mock('pixi-filters', () => {
  class FakeFilter { enabled = true; constructor(o: object) { Object.assign(this, o); } }
  return { ShockwaveFilter: FakeFilter, ZoomBlurFilter: FakeFilter };
});

/**
 * Antialias study (exp/antialias): with no warp in flight the stage must carry
 * NO filters. A filter on `app.stage` renders the whole frame into a filter
 * texture that has no MSAA (`Filter.defaultOptions.antialias = 'off'`), so the
 * canvas's `antialias: true` does nothing, and the frame pays four full-screen
 * passes for an invisible effect.
 *
 * Bug: the load curtain builds the warp stage at every join, and
 * `applyQuality` (called on every EffectsBudget tier change) re-attached the
 * chain whenever it had been built, warp or no warp. Nothing detached it
 * again, so after the first tier change the game ran filtered forever.
 */
function makeChain(): { chain: WarpFilterChain; stage: Container } {
  const stage = new Container();
  const app = { stage, ticker: { add: () => {}, remove: () => {} } };
  const camera = { center: { x: 0, y: 0 }, screenWidth: 800, screenHeight: 600 };
  const markers = { warpTickMs: 0, filterCount: 0, warpFiltersAttached: false, warpBurstAgeMs: -1 };
  const chain = new WarpFilterChain(app as never, new Container(), camera as never, () => undefined, markers as never);
  return { chain, stage };
}

const attached = (stage: Container): number => (Array.isArray(stage.filters) ? stage.filters.length : 0);

describe('WarpFilterChain — no stage filters while idle', () => {
  it('a quality-tier change with no warp in flight attaches nothing', () => {
    const { chain, stage } = makeChain();
    chain.setLoadCurtain(true); // every join raises the curtain → stage built
    chain.setLoadCurtain(false);
    for (const tier of ['low', 'medium', 'high'] as const) {
      chain.applyQuality(tier);
      expect(attached(stage), `after applyQuality('${tier}')`).toBe(0);
    }
  });

  it('a tier change DURING a warp still re-applies the chain', () => {
    const { chain, stage } = makeChain();
    chain.setMode(true);
    expect(attached(stage)).toBeGreaterThan(0);
    chain.applyQuality('low'); // drops zoom-blur but keeps the chain
    expect(attached(stage)).toBeGreaterThan(0);
    chain.applyQuality('minimal');
    expect(attached(stage)).toBe(0);
  });
});
