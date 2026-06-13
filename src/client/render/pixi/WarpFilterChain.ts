/**
 * Warp visual effect — the shockwave + flash + load-curtain
 * filter chain hosted on its own `warpStage` container above the world.
 *
 * Two-phase envelope driven by `setMode(true)`:
 *   1. Spool — many small short-lived ripples (count = `spoolCount`,
 *      finite `spoolRadius`, fast cycle). Amplitude / brightness /
 *      blur ramp 0 → spool peak.
 *   2. Climax — one big ripple (count = 1, infinite radius, slow
 *      cycle). Amplitude / brightness / blur ramp spool peak → climax
 *      peak.
 *
 * `setMode(false)` starts the fade-out tween: `intensity` ramps 1 → 0
 * over `fadeOutMs`, scaling every filter's amplitude in lockstep.
 *
 * `triggerWarpIn(center)` fires a one-shot burst ripple + flash overlay
 * at the supplied centre. Re-attaches the filter chain if it's not
 * already attached. `setMode(false)` does NOT burst (single-flash
 * policy — see `src/client/CLAUDE.md` 2026-05-16 Phase G3); the
 * arrival reveal is the only legitimate burst.
 *
 * `setLoadCurtain(active)` tweens the full-canvas dark overlay (200 ms
 * rise / 380 ms fade) to hide the canvas during join + transit load.
 * Independent of the warp filter chain — the curtain alone runs with
 * filters detached.
 *
 * Composes the pure helpers `shouldDetachWarpVisual`,
 * `warpEventFiresBurst`, `resolveWarpFilterCenter` (all exported from
 * `pixi/warpHelpers.ts`).
 *
 * Extracted from PixiRenderer (commit 13 of v3 refactor plan).
 */

import { Application, Container, Graphics } from 'pixi.js';
import { ShockwaveFilter, ZoomBlurFilter } from 'pixi-filters';
import {
  shouldDetachWarpVisual,
  warpEventFiresBurst,
  resolveWarpFilterCenter,
} from './warpHelpers.js';
import {
  DEFAULT_WARP_PARAMS,
  type WarpParams,
  type WarpCenter,
} from '../worker/protocol.js';

/** Minimal camera surface — screen size + world-centre for distance falloff. */
export interface WarpCameraView {
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly center: { x: number; y: number };
}

/** Markers the chain writes each tick. PixiRenderer's frameMarkers
 *  object is reused; only `warpTickMs`, `filterCount`, `warpFiltersAttached`,
 *  `warpBurstAgeMs` are touched here. */
export interface WarpFrameMarkers {
  warpTickMs: number;
  filterCount: number;
  warpFiltersAttached: boolean;
  warpBurstAgeMs: number;
}

const BACKGROUND_COLOR = 0x05070f;
// Plan: crispy-kazoo, Commit 9 — was 0.97, bumped to 1.0.
// The 3% see-through let bright VFX (laser bolts, missile explosions,
// remote-player warp-in flashes) bleed through the curtain — the
// 2026-05-31 smoke "I saw some effects happen behind/on the curtain"
// report. Full opacity hides them completely. The curtain colour
// matches the background so a black opaque overlay reads as "starfield
// dimmed", same visual intent as the 0.97 variant.
const CURTAIN_PEAK_ALPHA = 1.0;
const CURTAIN_RISE_MS = 200;
const CURTAIN_FADE_MS = 380;

export class WarpFilterChain {
  // ── State (was on PixiRenderer) ──────────────────────────────────────
  private warpActive = false;
  private warpStage: Container | null = null;
  private warpShockwaves: ShockwaveFilter[] | null = null;
  private warpZoomBlur: ZoomBlurFilter | null = null;
  private warpParams: WarpParams = { ...DEFAULT_WARP_PARAMS };
  private warpCenter: WarpCenter | null = null;
  private warpStartedAt = 0;
  private warpIntensity = 0;
  private warpFadeStartedAt = 0;
  private warpPhase: 'idle' | 'spool' | 'climax' = 'idle';
  private warpPhaseStartedAt = 0;
  private warpStackCount = 0;
  private warpStackRadius = -1;
  private warpBurst: ShockwaveFilter | null = null;
  private warpBurstStartedAt = 0;
  private warpFlash: Graphics | null = null;
  private loadCurtain: Graphics | null = null;
  private loadCurtainTargetAlpha = 0;
  private loadCurtainTweenStartedAt = 0;
  private loadCurtainTweenFromAlpha = 0;
  private warpStandaloneBurst = false;

  constructor(
    private readonly app: Application,
    private readonly world: Container,
    private readonly camera: WarpCameraView,
    private readonly entitySpriteLookup: (entityId: string) => { x: number; y: number } | undefined,
    private readonly frameMarkers: WarpFrameMarkers,
  ) {}

  setMode(active: boolean): void {
    this.warpActive = active;
    if (active) {
      this.ensureStage();
      this.warpIntensity = 1;
      this.warpFadeStartedAt = 0;
      const now = performance.now();
      this.warpStartedAt = now;
      this.warpPhaseStartedAt = now;
      this.warpPhase = 'spool';
      if (this.warpStage) this.warpStage.visible = true;
      this.attachFilters();
    } else if (this.warpFadeStartedAt === 0 && this.warpStage) {
      this.warpFadeStartedAt = performance.now();
      // Spool-exit: fade the filter chain out ONLY — no burst here.
      // See CLAUDE.md 2026-05-16 Phase G3 single-flash policy.
      if (warpEventFiresBurst('warp-mode-off')) this.fireBurst();
    }
  }

  triggerWarpIn(center: WarpCenter | null): void {
    this.ensureStage();
    if (center !== null) this.warpCenter = center;
    if (this.warpStage) this.warpStage.visible = true;
    const filtersAttached = Array.isArray(this.app.stage.filters)
      && (this.app.stage.filters as unknown[]).length > 0;
    if (!filtersAttached) {
      this.warpStandaloneBurst = true;
      this.attachFilters();
    }
    if (warpEventFiresBurst('warp-in')) this.fireBurst();
  }

  setWarpParams(partial: Partial<WarpParams>): void {
    Object.assign(this.warpParams, partial);
    this.warpParams.spoolCount = Math.max(1, Math.min(8, Math.floor(this.warpParams.spoolCount)));
  }

  setWarpCenter(center: WarpCenter | null): void {
    this.warpCenter = center;
  }

  setLoadCurtain(active: boolean): void {
    this.ensureStage();
    const target = active ? CURTAIN_PEAK_ALPHA : 0;
    if (target === this.loadCurtainTargetAlpha) return;
    this.loadCurtainTargetAlpha = target;
    this.loadCurtainTweenFromAlpha = this.loadCurtain?.alpha ?? 0;
    this.loadCurtainTweenStartedAt = performance.now();
  }

  /** Diagnostic — true while the one-shot burst ripple is decaying. */
  isBurstInFlight(): boolean {
    return this.warpBurstStartedAt > 0;
  }

  /** Tear down — called by PixiRenderer.dispose. */
  destroy(): void {
    if (this.warpStage) {
      this.app.ticker.remove(this.tick);
      this.warpStage.destroy({ children: true });
      this.warpStage = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private fireBurst(): void {
    if (!this.warpBurst) return;
    this.warpBurstStartedAt = performance.now();
    this.warpBurst.time = 0;
  }

  private ensureStage(): void {
    if (this.warpStage) return;
    this.warpStage = new Container();
    this.warpStage.eventMode = 'none';
    this.app.stage.addChild(this.warpStage);

    this.warpShockwaves = this.buildShockwaveStack(this.warpParams.spoolCount, this.warpParams.spoolRadius);
    this.warpStackCount = this.warpParams.spoolCount;
    this.warpStackRadius = this.warpParams.spoolRadius;
    this.warpZoomBlur = new ZoomBlurFilter({
      strength: 0,
      center: { x: this.camera.screenWidth * 0.5, y: this.camera.screenHeight * 0.5 },
      innerRadius: this.warpParams.zoomBlurInnerRadius,
      radius: -1,
    });
    this.warpBurst = new ShockwaveFilter({
      center: { x: this.camera.screenWidth * 0.5, y: this.camera.screenHeight * 0.5 },
      speed: this.warpParams.burstSpeed,
      amplitude: 0,
      wavelength: this.warpParams.burstWavelength,
      brightness: 1,
      radius: -1,
      time: 0,
    });
    this.loadCurtain = new Graphics();
    this.loadCurtain.rect(-2048, -2048, 8192, 8192);
    this.loadCurtain.fill({ color: BACKGROUND_COLOR, alpha: 1 });
    this.loadCurtain.alpha = 0;
    this.warpStage.addChild(this.loadCurtain);

    this.warpFlash = new Graphics();
    this.warpFlash.rect(-2048, -2048, 8192, 8192);
    this.warpFlash.fill({ color: 0xffffff, alpha: 1 });
    this.warpFlash.alpha = 0;
    this.warpStage.addChild(this.warpFlash);
    this.app.ticker.add(this.tick);
  }

  private buildShockwaveStack(count: number, radius: number): ShockwaveFilter[] {
    const { speed, wavelength } = this.warpParams;
    const cx = this.camera.screenWidth * 0.5;
    const cy = this.camera.screenHeight * 0.5;
    const filters: ShockwaveFilter[] = [];
    for (let i = 0; i < count; i++) {
      filters.push(new ShockwaveFilter({
        center: { x: cx, y: cy },
        speed,
        amplitude: 0,
        wavelength,
        brightness: 1,
        radius,
        time: 0,
      }));
    }
    return filters;
  }

  private attachFilters(): void {
    if (this.forcedDisabled) return; // kill switch (plan: melodic-engelbart Step 2c)
    if (!this.warpShockwaves || !this.warpZoomBlur || !this.warpBurst) return;
    // Re-enabled 2026-05-27 (M3 of effects-subsystem plan wiggly-puppy)
    // after being disabled 2026-05-21 (commit `Render-jitter-fix Phase 1b`).
    // The disable rationale was duty-cycle cost on mobile — the re-enable
    // is paired with toned-down DEFAULT_WARP_PARAMS (spoolCount 4→2,
    // climaxAmplitude 220→70) AND a budget tier dial via `applyQuality`
    // below (low drops zoom-blur; minimal detaches the chain entirely,
    // matching the 2026-05-21 safe state). The bloom/glow pass was REMOVED
    // entirely (WS-14 / R2.9 — "remove warp glow"); the single subtle white
    // arrival flash (`warpFlash`, fired by `triggerWarpIn`) is the reveal.
    const filters: import('pixi.js').Filter[] = [];
    for (const sw of this.warpShockwaves) filters.push(sw);
    filters.push(this.warpBurst);
    if (this.qualityIncludesZoomBlur()) filters.push(this.warpZoomBlur);
    this.app.stage.filters = filters;
  }

  /**
   * EffectsBudget hook (plan `wiggly-puppy` M3). `EffectsBudget` holds a
   * direct reference to this chain and calls `applyQuality` on tier
   * transition. Single ownership site for warp filter detach/attach
   * (Invariant #12) — IFilterEffects deliberately does NOT duplicate the
   * warp surface.
   *
   * Dials per tier:
   *  - high    : full chain (shockwaves + zoom-blur + burst)
   *  - medium  : same as high (bloom — the former high-only pass — was
   *              removed entirely in WS-14/R2.9)
   *  - low     : drop zoom-blur (shockwaves + burst only)
   *  - minimal : detach all filters (matches the 2026-05-21 safe state)
   *
   * The chain is re-built lazily by ensureStage()/buildShockwaveStack;
   * applyQuality only changes what attaches NEXT — the running tween
   * keeps animating with whatever was attached when it started. The
   * next phase transition (spool→climax, burst arrival) re-applies via
   * attachFilters(), picking up the new tier.
   */
  applyQuality(level: 'high' | 'medium' | 'low' | 'minimal'): void {
    // Force-disabled by ?nofilters=1 (plan: melodic-engelbart Step 2c) —
    // pin to minimal and ignore the requested level. Subsequent budget
    // tier promotions can't re-attach because attachFilters() is gated.
    const effective = this.forcedDisabled ? 'minimal' : level;
    this.qualityLevel = effective;
    if (effective === 'minimal') {
      // Detach immediately — caller wants the safe state right now.
      if (Array.isArray(this.app.stage.filters) && (this.app.stage.filters as unknown[]).length > 0) {
        this.app.stage.filters = [];
      }
    } else if (this.warpShockwaves) {
      // Re-apply for high/medium/low so the next render uses the new chain.
      this.attachFilters();
    }
  }

  /**
   * Kill switch for the heap-bisect measurement (plan: melodic-engelbart
   * Step 2c). When invoked, future applyQuality() calls treat any level
   * as minimal and attachFilters() short-circuits — the chain stays
   * detached regardless of warp lifecycle. The load curtain still
   * operates (it's not part of the filter chain). One-way: there's no
   * forceEnable; toggling the flag mid-session is out of scope.
   */
  forceDisable(): void {
    this.forcedDisabled = true;
    this.applyQuality('minimal');
  }

  /** Test surface — true after forceDisable was called. */
  isForceDisabled(): boolean {
    return this.forcedDisabled;
  }

  private forcedDisabled = false;
  private qualityLevel: 'high' | 'medium' | 'low' | 'minimal' = 'high';
  private qualityIncludesZoomBlur(): boolean { return this.qualityLevel === 'high' || this.qualityLevel === 'medium'; }

  /** Ticker callback (arrow form so `this` is bound). */
  private readonly tick = (): void => {
    const warpStart = performance.now();
    this.runTick();
    this.frameMarkers.warpTickMs = performance.now() - warpStart;
    this.frameMarkers.filterCount = this.warpShockwaves?.length ?? 0;
    this.frameMarkers.warpFiltersAttached = Array.isArray(this.app.stage.filters)
      && (this.app.stage.filters as unknown[]).length > 0;
    this.frameMarkers.warpBurstAgeMs = this.warpBurstStartedAt > 0
      ? Math.round(performance.now() - this.warpBurstStartedAt)
      : -1;
  };

  private runTick(): void {
    if (!this.warpStage || !this.warpShockwaves || !this.warpZoomBlur || !this.warpBurst || !this.warpFlash || !this.loadCurtain) return;
    const now = performance.now();
    const p = this.warpParams;

    // ---- Load curtain alpha tween (runs unconditionally) ----
    if (this.loadCurtainTargetAlpha !== this.loadCurtain.alpha) {
      const rising = this.loadCurtainTargetAlpha > this.loadCurtainTweenFromAlpha;
      const dur = rising ? CURTAIN_RISE_MS : CURTAIN_FADE_MS;
      const elapsed = now - this.loadCurtainTweenStartedAt;
      if (elapsed >= dur) {
        this.loadCurtain.alpha = this.loadCurtainTargetAlpha;
      } else {
        const t = elapsed / Math.max(1, dur);
        this.loadCurtain.alpha = this.loadCurtainTweenFromAlpha
          + (this.loadCurtainTargetAlpha - this.loadCurtainTweenFromAlpha) * t;
      }
    }

    // ---- Burst + flash decay ----
    let burstActive = false;
    let burstFalloff = 0;
    if (this.warpBurstStartedAt > 0) {
      const elapsed = now - this.warpBurstStartedAt;
      if (elapsed >= p.burstDurationMs && elapsed >= p.flashDurationMs) {
        this.warpBurstStartedAt = 0;
        this.warpBurst.amplitude = 0;
        this.warpFlash.alpha = 0;
        if (shouldDetachWarpVisual({
          burstStartedAt: this.warpBurstStartedAt,
          fadeStartedAt: this.warpFadeStartedAt,
          intensity: this.warpIntensity,
        })) {
          this.app.stage.filters = [];
          this.warpStandaloneBurst = false;
          if (this.loadCurtain.alpha === 0 && this.loadCurtainTargetAlpha === 0) {
            this.warpStage.visible = false;
          }
          return;
        }
      } else {
        burstActive = true;
        const burstT = Math.min(1, elapsed / Math.max(1, p.burstDurationMs));
        burstFalloff = Math.sqrt(Math.max(0, 1 - burstT));
        this.warpBurst.amplitude = p.burstAmplitude * burstFalloff;
        this.warpBurst.brightness = 1 + (p.burstBrightness - 1) * burstFalloff;
        this.warpBurst.time = elapsed / 1000;
        this.warpBurst.speed = p.burstSpeed;
        this.warpBurst.wavelength = p.burstWavelength;

        let distanceFactor = 1;
        if (this.warpCenter?.kind === 'world' && p.flashRangeMax > 0) {
          const cam = this.camera.center;
          const dx = this.warpCenter.worldX - cam.x;
          const dy = this.warpCenter.worldY - cam.y;
          const dist = Math.hypot(dx, dy);
          distanceFactor = Math.max(0, 1 - dist / p.flashRangeMax);
        }

        const flashT = elapsed / Math.max(1, p.flashDurationMs);
        let flashAlpha: number;
        if (flashT < 0.08) flashAlpha = p.flashAlphaMax * (flashT / 0.08);
        else if (flashT < 1) flashAlpha = p.flashAlphaMax * (1 - (flashT - 0.08) / (1 - 0.08));
        else flashAlpha = 0;
        this.warpFlash.alpha = Math.max(0, flashAlpha * distanceFactor);
      }
    }

    // ---- Fade-out tween ----
    if (this.warpFadeStartedAt > 0) {
      const elapsed = now - this.warpFadeStartedAt;
      this.warpIntensity = Math.max(0, 1 - elapsed / Math.max(1, p.fadeOutMs));
      if (this.warpIntensity <= 0) {
        this.warpFadeStartedAt = 0;
        this.warpPhase = 'idle';
        if (!burstActive) {
          this.app.stage.filters = [];
          this.warpStandaloneBurst = false;
          if (this.loadCurtain.alpha === 0 && this.loadCurtainTargetAlpha === 0) {
            this.warpStage.visible = false;
          }
        }
        return;
      }
    }

    if (this.warpStandaloneBurst && !burstActive && this.warpFadeStartedAt === 0 && this.warpIntensity <= 0) {
      this.app.stage.filters = [];
      this.warpStandaloneBurst = false;
      if (this.loadCurtain.alpha === 0 && this.loadCurtainTargetAlpha === 0) {
        this.warpStage.visible = false;
      }
      return;
    }

    if (this.warpIntensity <= 0 && !burstActive) return;

    // ---- Resolve warp centre ----
    let entityGlobal: { x: number; y: number } | null = null;
    if (this.warpCenter?.kind === 'entity') {
      const s = this.entitySpriteLookup(this.warpCenter.entityId);
      if (s) entityGlobal = this.world.toGlobal({ x: s.x, y: s.y });
    }
    const { x: cx, y: cy } = resolveWarpFilterCenter({
      warpCenter: this.warpCenter,
      projectWorld: (px, py) => this.world.toGlobal({ x: px, y: py }),
      entityGlobal,
      screenW: this.camera.screenWidth,
      screenH: this.camera.screenHeight,
    });

    if (burstActive) this.warpBurst.center = { x: cx, y: cy };
    if (this.warpIntensity <= 0) return;

    // ---- Resolve phase + per-phase config ----
    const elapsed = now - this.warpStartedAt;
    let phase: 'spool' | 'climax';
    let phaseProgress: number;
    let targetCount: number;
    let targetRadius: number;
    let wavePeriodMs: number;
    let amplitudeFrom: number;
    let amplitudeTo: number;
    let brightnessFrom: number;
    let brightnessTo: number;
    let blurFrom: number;
    let blurTo: number;

    if (this.warpFadeStartedAt === 0 && elapsed < p.spoolDurationMs) {
      phase = 'spool';
      phaseProgress = elapsed / Math.max(1, p.spoolDurationMs);
      targetCount = p.spoolCount;
      targetRadius = p.spoolRadius;
      wavePeriodMs = p.spoolWavePeriodMs;
      amplitudeFrom = 0;
      amplitudeTo = p.spoolAmplitude;
      brightnessFrom = 1;
      brightnessTo = p.spoolBrightness;
      blurFrom = 0;
      blurTo = p.spoolZoomBlur;
    } else {
      phase = 'climax';
      const climaxElapsed = Math.max(0, elapsed - p.spoolDurationMs);
      phaseProgress = Math.min(1, climaxElapsed / Math.max(1, p.climaxDurationMs));
      targetCount = 1;
      targetRadius = -1;
      wavePeriodMs = p.climaxWavePeriodMs;
      amplitudeFrom = p.spoolAmplitude;
      amplitudeTo = p.climaxAmplitude;
      brightnessFrom = p.spoolBrightness;
      brightnessTo = p.climaxBrightness;
      blurFrom = p.spoolZoomBlur;
      blurTo = p.climaxZoomBlur;
    }

    if (
      this.warpPhase !== phase ||
      this.warpStackCount !== targetCount ||
      this.warpStackRadius !== targetRadius
    ) {
      this.warpShockwaves = this.buildShockwaveStack(targetCount, targetRadius);
      this.warpStackCount = targetCount;
      this.warpStackRadius = targetRadius;
      this.warpPhase = phase;
      this.warpPhaseStartedAt = now;
      this.attachFilters();
    }

    const k = this.warpIntensity;
    const amplitude = (amplitudeFrom + (amplitudeTo - amplitudeFrom) * phaseProgress) * k;
    const brightness = 1 + ((brightnessFrom - 1) + ((brightnessTo - 1) - (brightnessFrom - 1)) * phaseProgress) * k;
    const blurStrength = (blurFrom + (blurTo - blurFrom) * phaseProgress) * k;

    const cycleSec = Math.max(0.001, wavePeriodMs / 1000);
    const tSec = ((now - this.warpPhaseStartedAt) / 1000) % cycleSec;
    const filters = this.warpShockwaves;
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (!f) continue;
      f.time = (tSec + (i / filters.length) * cycleSec) % cycleSec;
      f.amplitude = amplitude;
      f.brightness = brightness;
      f.center = { x: cx, y: cy };
      f.speed = p.speed;
      f.wavelength = p.wavelength;
    }

    this.warpZoomBlur.center = { x: cx, y: cy };
    this.warpZoomBlur.strength = blurStrength;
    this.warpZoomBlur.innerRadius = p.zoomBlurInnerRadius;
  }
}
