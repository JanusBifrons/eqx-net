/**
 * `ShieldAura` — per-entity shield rings on a SINGLE global container,
 * with a SINGLE shared GlowFilter at `high` tier only.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` M8.
 *
 * The hostile review explicitly rejected per-entity GlowFilter on shield
 * rings — directly regresses the 2026-05-21 warp-disable rationale. This
 * design uses ONE filter total, attached to a shared container hosting
 * all shield rings as children.
 *
 * Tier dial (callee-side):
 *  - high    : ring + GlowFilter on container + slow alpha breathe
 *  - medium  : ring + breathe, NO GlowFilter (drop the heaviest single
 *              shader pass — touch-device default per M9 pin)
 *  - low     : flat ring (no breathe, no glow)
 *  - minimal : skip entirely (HUD bar still shows shield state)
 *
 * Per-entity rings are pooled (cap 32). Ring positions are polled per
 * tick via the same `getPose` callback that EngineEmitter uses (one-
 * pose-per-frame compliance — the renderer just wrote it).
 *
 * Hit pulse: when `pulse(entityId)` is called (from a shield-layer
 * damage event), the entity's ring alpha jumps to 0.55 then decays over
 * 250 ms back to base. One short tween per ring; no per-frame alloc.
 */

import type { Container, Graphics as PixiGraphics, Filter } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import type { EnginePoseFn } from './EngineEmitter';
import type { GlowLike } from './LaserGlow';
import { DEFAULT_SHIELD_PARAMS } from '../config/effectDefaults';

export interface ShieldFactories {
  /** Builds a flat ring Graphics of the given radius. */
  makeRing: (radius: number) => PixiGraphics;
  /** Builds the shared GlowFilter applied to the shield container. */
  makeGlowFilter: () => GlowLike;
  /** Builds a container that the manager parents all rings under. */
  makeContainer: () => Container;
}

interface ActiveRing {
  entityId: string;
  gfx: PixiGraphics;
  radius: number;
  /** Pulse intensity (0..1); decays each frame; 0 = at rest. */
  pulseT: number;
  /** Phase for the breathe sin wave — randomised per ring so they don't sync. */
  breathePhase: number;
}

const RING_POOL_CAP = 32;
/** Default ship-kind radius when the renderer doesn't know it yet. */
const DEFAULT_RADIUS = 28;

export interface ShieldAuraOptions {
  /** When true, applyQuality never attaches the shared GlowFilter — rings
   *  + breathe still render. The bisect kill switch (plan: melodic-engelbart
   *  Step 2b) isolating filter cost from particle cost. */
  filtersDisabled?: boolean;
}

export class ShieldAura {
  private readonly auraContainer: Container | null;
  /** Lazily constructed on first applyQuality('high') — the GlowFilter
   *  factory touches `document` under Pixi v8, so constructing eagerly
   *  would block node-env tests. Lazy = test code never trips the DOM. */
  private glowFilter: GlowLike | null = null;
  private readonly rings = new Map<string, ActiveRing>();
  private currentLevel: EffectQuality = 'high';
  /** Wall-clock accumulator for the breathe wave. */
  private elapsedMs = 0;
  private readonly filtersDisabled: boolean;

  constructor(
    private readonly parent: Container,
    private readonly getQuality: () => EffectQuality,
    private readonly factories: ShieldFactories,
    options: ShieldAuraOptions = {},
  ) {
    this.filtersDisabled = options.filtersDisabled === true;
    this.auraContainer = factories.makeContainer();
    parent.addChild(this.auraContainer);
    // Initial state = minimal — container hidden, no filter constructed.
    // EffectsService.tick will trigger applyQuality on the first frame
    // (lastAppliedTier sentinel ensures the transition fires), which
    // lazily constructs the GlowFilter for production. This keeps the
    // constructor DOM-free for node tests.
    this.applyQuality('minimal');
  }

  /**
   * Register / unregister a shield ring for an entity. Re-entrant. The
   * ring is created the first time and pooled across the entity's
   * shield-up/down cycle.
   */
  setActive(entityId: string, active: boolean, radius?: number): void {
    if (active) {
      if (this.rings.has(entityId)) return;
      this.spawnRing(entityId, radius ?? DEFAULT_RADIUS);
    } else if (this.rings.has(entityId)) {
      this.removeRing(entityId);
    }
  }

  /**
   * Pulse an entity's ring on a shield-layer damage event. No-op if the
   * entity has no active ring.
   */
  pulse(entityId: string): void {
    const r = this.rings.get(entityId);
    if (r) r.pulseT = 1;
  }

  /** Per-frame: update ring positions + breathe + pulse decay. */
  tick(dtMs: number, getPose: EnginePoseFn): void {
    this.elapsedMs += dtMs;
    const breathePeriodMs = DEFAULT_SHIELD_PARAMS.breathePeriodMs;
    const dial = this.qualityDial(this.currentLevel);
    if (!dial) return;

    for (const r of this.rings.values()) {
      const pose = getPose(r.entityId);
      if (!pose) {
        // Entity not currently rendered — hide instead of evicting (the
        // entity could come back into interest next frame).
        r.gfx.visible = false;
        continue;
      }
      r.gfx.visible = true;
      r.gfx.x = pose.x;
      r.gfx.y = -pose.y; // CLAUDE.md Y-flip
      let alpha = DEFAULT_SHIELD_PARAMS.baseAlpha;
      if (dial.breathe) {
        const t = (this.elapsedMs / breathePeriodMs + r.breathePhase) * Math.PI * 2;
        alpha += DEFAULT_SHIELD_PARAMS.breatheAmplitude * Math.sin(t);
      }
      if (r.pulseT > 0) {
        alpha += (DEFAULT_SHIELD_PARAMS.hitPulseAlpha - alpha) * r.pulseT;
        const decayPerMs = 1 / DEFAULT_SHIELD_PARAMS.hitPulseDecayMs;
        r.pulseT = Math.max(0, r.pulseT - dtMs * decayPerMs);
      }
      r.gfx.alpha = alpha;
    }
  }

  applyQuality(level: EffectQuality): void {
    this.currentLevel = level;
    if (!this.auraContainer) return;
    if (level === 'minimal') {
      // Hide all rings.
      this.auraContainer.visible = false;
      this.auraContainer.filters = null as never;
      return;
    }
    this.auraContainer.visible = true;
    const dial = this.qualityDial(level);
    if (!dial) return;
    if (dial.glow && !this.filtersDisabled) {
      // Lazily build the filter on first need — keeps node tests DOM-free.
      if (!this.glowFilter) this.glowFilter = this.factories.makeGlowFilter();
      this.auraContainer.filters = [this.glowFilter as Filter] as never;
    } else {
      this.auraContainer.filters = null as never;
    }
  }

  activeCount(): number {
    return this.rings.size;
  }

  /** Rings currently DRAWN (visible) — a ring whose entity pose couldn't be
   *  resolved this frame is registered but `visible=false` (see `tick`). The
   *  drawn-artefact signal for the worker-boundary lingering-aura lock. */
  visibleRingCount(): number {
    let n = 0;
    for (const r of this.rings.values()) if (r.gfx.visible) n++;
    return n;
  }

  resetForSectorHandoff(): void {
    for (const r of this.rings.values()) {
      this.auraContainer?.removeChild(r.gfx);
      r.gfx.destroy();
    }
    this.rings.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────

  private qualityDial(level: EffectQuality): { breathe: boolean; glow: boolean } | null {
    switch (level) {
      case 'high':    return { breathe: true,  glow: true };
      case 'medium':  return { breathe: true,  glow: false };
      case 'low':     return { breathe: false, glow: false };
      case 'minimal': return null;
    }
  }

  private spawnRing(entityId: string, radius: number): void {
    if (!this.auraContainer) return;
    if (this.rings.size >= RING_POOL_CAP) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldestKey = this.rings.keys().next().value;
      if (oldestKey !== undefined) this.removeRing(oldestKey);
    }
    const gfx = this.factories.makeRing(radius + DEFAULT_SHIELD_PARAMS.ringPad);
    gfx.alpha = DEFAULT_SHIELD_PARAMS.baseAlpha;
    this.auraContainer.addChild(gfx);
    this.rings.set(entityId, {
      entityId,
      gfx,
      radius,
      pulseT: 0,
      breathePhase: Math.random(),
    });
  }

  private removeRing(entityId: string): void {
    const r = this.rings.get(entityId);
    if (!r || !this.auraContainer) return;
    this.auraContainer.removeChild(r.gfx);
    r.gfx.destroy();
    this.rings.delete(entityId);
  }
}
