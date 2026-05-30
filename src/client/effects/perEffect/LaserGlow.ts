/**
 * `LaserGlow` — pooled `GlowFilter` on the live + remote beam Graphics.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` M6.
 *
 * Two filters total (NOT per-beam — per-beam would replicate the M3 warp-
 * filter cost lesson on a per-shooter basis). Each attaches to one of the
 * two beam Graphics that already exist on the renderer:
 *  - `liveBeamGfx`   : local-player hitscan beams (cyan glow)
 *  - `remoteBeamGfx` : all remote-shooter beams (orange glow)
 *
 * Tier dial (callee-side):
 *  - high    : both glow filters attached, quality 0.2
 *  - medium  : both glow filters attached, quality 0.1
 *  - low     : ONLY live (local-player) beam filter attached
 *  - minimal : both filters detached (raw Graphics beams remain)
 *
 * Filters are MUTATED in place — never destroyed/recreated on tier change.
 * Pool size is exactly 2 (constants of the renderer). The lifetime of a
 * LaserGlow instance matches its parent renderer.
 */

import type { Filter, Graphics as PixiGraphics } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';

/** Minimal shape LaserGlow uses on a `GlowFilter`. */
export interface GlowLike extends Filter {
  outerStrength: number;
  innerStrength: number;
  quality: number;
  color: number;
}

export interface LaserGlowFactories {
  /** Builds a GlowFilter with the given colour. Pixi-import isolation. */
  makeGlowFilter: (colour: number) => GlowLike;
}

export interface LaserGlowBeams {
  liveBeamGfx: PixiGraphics;
  remoteBeamGfx: PixiGraphics;
}

const COLOUR_LIVE = 0x00eeff;
const COLOUR_REMOTE = 0xff6600;

interface QualityDial { outerStrength: number; innerStrength: number; quality: number; remoteAttached: boolean }

const QUALITY_DIAL: Record<EffectQuality, QualityDial | null> = {
  high:    { outerStrength: 2.0, innerStrength: 1.0, quality: 0.2, remoteAttached: true },
  medium:  { outerStrength: 1.5, innerStrength: 0.8, quality: 0.1, remoteAttached: true },
  low:     { outerStrength: 1.2, innerStrength: 0.6, quality: 0.1, remoteAttached: false },
  minimal: null, // both detached
};

export interface LaserGlowOptions {
  /** When true, applyQuality always detaches both filters regardless of
   *  tier — the bisect kill switch (plan: melodic-engelbart Step 2b). */
  filtersDisabled?: boolean;
}

export class LaserGlow {
  private readonly liveFilter: GlowLike;
  private readonly remoteFilter: GlowLike;
  private currentLevel: EffectQuality = 'high';
  private readonly filtersDisabled: boolean;

  constructor(
    private readonly beams: LaserGlowBeams,
    factories: LaserGlowFactories,
    options: LaserGlowOptions = {},
  ) {
    this.filtersDisabled = options.filtersDisabled === true;
    this.liveFilter = factories.makeGlowFilter(COLOUR_LIVE);
    this.remoteFilter = factories.makeGlowFilter(COLOUR_REMOTE);
    // Initial state = high tier (matches the budget's initial localTier).
    this.applyQuality('high');
  }

  /** Mutate filter params in place + (re)attach/detach to match the tier.
   *  Per hostile-review #17 + the project's "no per-frame Pixi alloc"
   *  discipline: this never destroys or recreates filters. */
  applyQuality(level: EffectQuality): void {
    this.currentLevel = level;
    const dial = this.filtersDisabled ? null : QUALITY_DIAL[level];

    if (dial === null) {
      this.detachLive();
      this.detachRemote();
      return;
    }

    this.liveFilter.outerStrength = dial.outerStrength;
    this.liveFilter.innerStrength = dial.innerStrength;
    this.liveFilter.quality = dial.quality;
    this.attachLive();

    if (dial.remoteAttached) {
      this.remoteFilter.outerStrength = dial.outerStrength;
      this.remoteFilter.innerStrength = dial.innerStrength;
      this.remoteFilter.quality = dial.quality;
      this.attachRemote();
    } else {
      this.detachRemote();
    }
  }

  /** Test surface — current tier the glow is configured for. */
  getCurrentLevel(): EffectQuality {
    return this.currentLevel;
  }

  /** Test surface — true when the filter is in the beam's filters array. */
  isLiveAttached(): boolean {
    return this.isFilterAttached(this.beams.liveBeamGfx, this.liveFilter);
  }
  isRemoteAttached(): boolean {
    return this.isFilterAttached(this.beams.remoteBeamGfx, this.remoteFilter);
  }

  /** Filter instances exposed for test introspection only. */
  getLiveFilter(): GlowLike { return this.liveFilter; }
  getRemoteFilter(): GlowLike { return this.remoteFilter; }

  // ── Private ──────────────────────────────────────────────────────────

  private attachLive(): void {
    this.attachOnce(this.beams.liveBeamGfx, this.liveFilter);
  }
  private detachLive(): void {
    this.detachOnce(this.beams.liveBeamGfx, this.liveFilter);
  }
  private attachRemote(): void {
    this.attachOnce(this.beams.remoteBeamGfx, this.remoteFilter);
  }
  private detachRemote(): void {
    this.detachOnce(this.beams.remoteBeamGfx, this.remoteFilter);
  }

  private attachOnce(gfx: PixiGraphics, f: Filter): void {
    const existing = Array.isArray(gfx.filters) ? (gfx.filters as Filter[]) : [];
    if (existing.indexOf(f) >= 0) return; // already attached
    const next = [...existing, f];
    gfx.filters = next as never;
  }

  private detachOnce(gfx: PixiGraphics, f: Filter): void {
    const existing = Array.isArray(gfx.filters) ? (gfx.filters as Filter[]) : [];
    const idx = existing.indexOf(f);
    if (idx < 0) return; // not attached
    const next = existing.slice();
    next.splice(idx, 1);
    gfx.filters = (next.length > 0 ? next : null) as never;
  }

  private isFilterAttached(gfx: PixiGraphics, f: Filter): boolean {
    return Array.isArray(gfx.filters) && (gfx.filters as Filter[]).indexOf(f) >= 0;
  }
}
