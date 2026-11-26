/** The Ancients' gate's light (owner, take 19: "no animation or indication
 *  you had warped"; the B mock-up's wireframe waves, lanes, crystal and
 *  flash): timing from the jump timetable, art per light-only part. */
import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import { ASTROLABE_FX_PARTS, ASTROLABE_RINGS, ASTROLABE_SWAP_MS, astrolabePoseAt, createAstrolabePose } from '../../../core/galaxy/alienGateAstrolabe.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { ALIEN_GATE_INTERVAL_MS, alienGateOffsetMs, nextAlienGateJumpMs } from '../../../shared-types/teleport.js';
import {
  ASTROLABE_FX, FLASH_FADE_MS, FLASH_RISE_MS, POOL_BANDS, astrolabeFxAt, astrolabeFxPartContext, astrolabePartShow,
  createAstrolabeFx, poolBandAlpha, waveSpread,
} from './structureStyleC.transport.astrolabeFx.js';
import { ASTROLABE_RIG_HOOK } from './structureStyleC.transport.astrolabe.js';

const MID = ALIEN_GATE_INTERVAL_MS / 2; // free-running, rings out of line

describe('astrolabe light timing', () => {
  it('no flash while the rings run free; the flash builds into the swap and fades after it', () => {
    const fx = createAstrolabeFx();
    expect(astrolabeFxAt(fx, MID, 0).flash).toBe(0);
    expect(astrolabeFxAt(fx, ASTROLABE_SWAP_MS - FLASH_RISE_MS - 1, 1).flash).toBe(0);
    const rising = astrolabeFxAt(fx, ASTROLABE_SWAP_MS - FLASH_RISE_MS / 2, 1).flash;
    const peak = astrolabeFxAt(fx, ASTROLABE_SWAP_MS, 1).flash;
    const fading = astrolabeFxAt(fx, ASTROLABE_SWAP_MS + FLASH_FADE_MS / 2, 1).flash;
    expect(rising).toBeGreaterThan(0.3);
    expect(peak).toBeGreaterThan(rising);
    expect(peak).toBeGreaterThanOrEqual(0.9);
    expect(fading).toBeGreaterThan(0.3); // still bright when a rider lands (~1.1 s later)
    expect(fading).toBeLessThan(peak);
    expect(astrolabeFxAt(fx, ASTROLABE_SWAP_MS + FLASH_FADE_MS + 1, 1).flash).toBe(0);
  });

  it('a rider still lands into the flash (take 20: the held picture lands ~1.1 s after the swap; the flash had gone)', () => {
    const fx = createAstrolabeFx();
    expect(astrolabeFxAt(fx, ASTROLABE_SWAP_MS + 1100, 1).flash).toBeGreaterThan(0.4);
    expect(waveSpread(fx, 0)).toBeLessThan(0.75); // the first light ring is still spreading, not gone
    expect(waveSpread(fx, 2)).toBeGreaterThan(0);
  });

  it('rings of light spread out after the swap, one after another, then stop', () => {
    const fx = createAstrolabeFx();
    astrolabeFxAt(fx, ASTROLABE_SWAP_MS - 10, 1);
    for (let j = 0; j < 3; j++) expect(waveSpread(fx, j)).toBeNaN();
    astrolabeFxAt(fx, ASTROLABE_SWAP_MS + 500, 1);
    const a = waveSpread(fx, 0), b = waveSpread(fx, 1);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b); // the first ring is further out
    astrolabeFxAt(fx, ASTROLABE_SWAP_MS + 5000, 1);
    for (let j = 0; j < 3; j++) expect(waveSpread(fx, j)).toBeNaN();
  });

  it('lanes, pool and crystal brighten as the rings line up and the gate charges', () => {
    const free = { ...astrolabeFxAt(createAstrolabeFx(), MID, 0) };
    const lined = { ...astrolabeFxAt(createAstrolabeFx(), ALIEN_GATE_INTERVAL_MS - 100, 1) };
    const charged = { ...astrolabeFxAt(createAstrolabeFx(), ASTROLABE_SWAP_MS - 1, 1) };
    for (const k of ['lanes', 'pool', 'crystal', 'swell'] as const) {
      expect(lined[k], k).toBeGreaterThan(free[k]);
      expect(charged[k], k).toBeGreaterThanOrEqual(lined[k]);
    }
    expect(free.lanes).toBeLessThan(0.15); // faint while the stone blocks the lanes
  });

  it('pool waves run outward (each band peaks a little after the one inside it)', () => {
    const fx = createAstrolabeFx();
    const peakAt = (b: number): number => {
      let best = -1, at = 0;
      for (let t = MID; t < MID + 1500; t += 5) {
        astrolabeFxAt(fx, t, 1);
        const a = poolBandAlpha(fx, b);
        if (a > best) { best = a; at = t; }
      }
      return at;
    };
    // Band 0 first; a band further out peaks later in the same wave.
    const t0 = peakAt(0), t1 = peakAt(1);
    expect(t1).toBeGreaterThan(t0);
    astrolabeFxAt(fx, MID, 1);
    for (let b = 0; b < POOL_BANDS; b++) expect(poolBandAlpha(fx, b)).toBeGreaterThanOrEqual(0.06);
  });

  it('waves run on unbroken through the minute wrap (the fire)', () => {
    const fx = createAstrolabeFx();
    const a = poolBandAlpha(astrolabeFxAt(fx, ALIEN_GATE_INTERVAL_MS - 1e-6, 1), 2);
    const b = poolBandAlpha(astrolabeFxAt(fx, 0, 1), 2);
    expect(b).toBeCloseTo(a, 4);
  });

  it('is the timetable the rings run on (a late joiner sees the same light)', () => {
    const off = alienGateOffsetMs('A', 'B');
    const fire = nextAlienGateJumpMs(1_700_000_000_000, off);
    const p = createAstrolabePose();
    astrolabePoseAt(p, fire + ASTROLABE_SWAP_MS + 200, off);
    const fx = astrolabeFxAt(createAstrolabeFx(), p.sinceFireMs, p.settle);
    expect(fx.flash).toBeGreaterThan(0.5);
  });
});

describe('astrolabe light parts', () => {
  const rig = rigForStructureKind('alien_gate')!;

  it('every light-only part has art; the rings keep theirs', () => {
    for (const f of ASTROLABE_FX_PARTS) {
      const i = rig.partIds.indexOf(f.part);
      expect(i, f.part).toBeGreaterThanOrEqual(ASTROLABE_RINGS.length);
      expect(astrolabeFxPartContext(rig, i), f.part).not.toBeNull();
      expect(ASTROLABE_RIG_HOOK.partArt?.(rig, i), f.part).not.toBeNull();
      expect(ASTROLABE_RIG_HOOK.partLit?.(rig, i) ?? null, f.part).toBeNull(); // light, no lit overlay
    }
    for (let i = 0; i < ASTROLABE_RINGS.length; i++) expect(astrolabeFxPartContext(rig, i)).toBeNull();
  });

  it('partShow fades the flash in with ASTROLABE_FX, hides its shadow, and leaves the rings alone', () => {
    const flash = rig.partIds.indexOf('fx-flash');
    const g = new Graphics(), sh = new Graphics();
    astrolabeFxAt(ASTROLABE_FX, MID, 0);
    astrolabePartShow(rig, flash, 0, undefined, g, sh);
    expect(g.visible).toBe(false);
    expect(sh.visible).toBe(false);
    astrolabeFxAt(ASTROLABE_FX, ASTROLABE_SWAP_MS, 1);
    astrolabePartShow(rig, flash, 0, undefined, g, sh);
    expect(g.visible).toBe(true);
    expect(g.alpha).toBeGreaterThan(0.9);
    const ring = new Graphics();
    ring.alpha = 0.42;
    astrolabePartShow(rig, 0, 0, undefined, ring, null);
    expect(ring.alpha).toBe(0.42);
    expect(ring.visible).toBe(true);
  });
});
