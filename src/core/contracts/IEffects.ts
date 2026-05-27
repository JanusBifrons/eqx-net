/**
 * Visual-effects subsystem contracts.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md`.
 *
 * Three narrow sub-contracts (ISP per root CLAUDE.md "narrow contracts" rule)
 * + one composite for bootstrap convenience. Consumers depend on the narrow
 * sub-interface they actually use; test fakes implement only the one they
 * need.
 *
 * Ownership note (Invariant #12 — one ownership site per state surface):
 * warp methods (`setWarpMode`, `triggerWarpIn`, `setWarpCenter`,
 * `setLoadCurtain`) live ONLY on `IRenderer`. They are deliberately NOT
 * duplicated on `IFilterEffects`. The `EffectsBudget` controls warp filter
 * detach/attach by holding a direct reference to `WarpFilterChain` and
 * calling its `applyQuality(level)` method (added in M3). One ownership
 * site; no parallel facade.
 */

/** Quality tier resolved by `EffectsBudget`. Lower tier = more restrictive. */
export type EffectQuality = 'high' | 'medium' | 'low' | 'minimal';

/** Lower tier is more restrictive; numeric ordering used by `min(a, b)`. */
const QUALITY_RANK: Record<EffectQuality, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** Return the more-restrictive (lower) tier of two. Used by the budget when
 *  the worker-local resolution and the main-thread push disagree — we always
 *  honour the more-restrictive recommendation. */
export function pickMoreRestrictiveQuality(a: EffectQuality, b: EffectQuality): EffectQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

/** Trigger kinds for one-shot bursts. */
export type ParticleBurstKind =
  | 'impact'
  | 'destruction'
  | 'shield-hit'
  | 'warp-arrive';

/** Continuous emitter kinds, keyed by entity id. */
export type ContinuousEffectKind = 'thrust' | 'boost' | 'shield';

/** One-shot filter kinds (brief Shockwave / flash overlays). */
export type OneShotFilterKind = 'destruction-shock' | 'shield-flash';

export interface ParticleBurstOpts {
  /** 0..1 multiplier on default count + lifetime. Defaults to 1. */
  intensity?: number;
  /** Override default tint. RGB hex like 0xff66aa. */
  tint?: number;
}

/**
 * Particle-side effects: one-shot bursts (impact / destruction / shield-hit /
 * warp-arrive) + per-entity continuous emitters (thrust / boost / shield).
 *
 * `ColyseusClient.handleDamage` only needs this sub-interface, NOT the full
 * `IEffects`. Test fakes for damage-path tests implement this alone.
 */
export interface IParticleEffects {
  /**
   * Spawn a one-shot burst at the given world coordinate.
   *
   * Distance-cull (screen-bbox + 200 px margin) is applied internally — a
   * burst far off-screen is a no-op. The local player is hard-excluded from
   * distance evaluation (always near the camera centre).
   */
  spawnBurst(
    kind: ParticleBurstKind,
    worldX: number,
    worldY: number,
    opts?: ParticleBurstOpts,
  ): void;

  /**
   * Toggle a continuous emitter for an entity. Re-entrant: calling with the
   * same `(entityId, kind, active)` is a no-op. The implementation reads
   * pose each frame from `RenderMirror` (NOT passed here) so the emitter
   * stays glued to the moving entity.
   */
  setContinuous(entityId: string, kind: ContinuousEffectKind, active: boolean): void;

  /**
   * Per-frame poll. Called inside `PixiRenderer.update(mirror)` at the tail
   * (after `updateSwarmSprites`) so the one-pose-per-frame invariant holds:
   * shield aura and engine emitter read the same resolved `mirror.swarm[id].x/y`
   * and `mirror.ships.get(id).x/y` that the sprite updaters just wrote. NEVER
   * called from a separate Pixi ticker callback — that would resolve poses at
   * a divergent `now`.
   */
  tick(nowMs: number, dtMs: number): void;

  /**
   * Drop all per-entity continuous emitters + in-flight bursts. Called from
   * `ColyseusClient.resetPredictionState()` on sector handoff alongside
   * `rearmJoinReadiness()` (the existing transit-reset siblings) to prevent
   * dead-entity-id emitters from leaking across sectors. See
   * `src/client/CLAUDE.md` "Sector handoff resets prediction state".
   */
  resetForSectorHandoff(): void;
}

/**
 * Filter-side effects: brief Shockwave / flash overlays attached at a world
 * point. Warp is NOT here — warp methods stay on `IRenderer` (one ownership
 * site).
 */
export interface IFilterEffects {
  /**
   * Attach a brief one-shot filter at the given world coord. The filter
   * removes itself after its lifetime expires (≤ 300 ms for the current
   * kinds) — never leaves a filter dangling on `app.stage`.
   */
  triggerOneShotFilter(
    kind: OneShotFilterKind,
    worldX: number,
    worldY: number,
  ): void;
}

/**
 * Budget policy surface. The budget is a passive policy object: per-frame
 * metrics are pushed in, callers PULL the resolved quality tier each frame.
 * Pull avoids per-transition allocations (push would broadcast on every
 * tier change to every per-effect manager).
 */
export interface IEffectsBudget {
  /**
   * External quality push (from main-thread `PerfMonitor` via
   * `SET_EFFECT_QUALITY`). The budget keeps the more-restrictive of (this
   * pushed tier, its own locally-resolved tier).
   */
  setQuality(level: EffectQuality): void;

  /** Diagnostic + test surface — never read on the hot path. */
  getStats(): {
    activeBursts: number;
    activeContinuous: number;
    activeFilters: number;
    quality: EffectQuality;
  };

  /** Quality tier the per-effect managers should adopt this frame. */
  getQuality(): EffectQuality;
}

/**
 * Composite — what bootstrap injects into the renderer. Per-effect modules
 * and consumers (e.g. `ColyseusClient.handleDamage`) depend on the narrow
 * sub-interface they need, NOT this composite.
 */
export interface IEffects extends IParticleEffects, IFilterEffects, IEffectsBudget {}
