/**
 * `DestructionFx` — particle burst + brief Shockwave filter on ship death.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` M4.
 *
 * Replaces the inline starburst at `PixiRenderer.ts:558-606` (the 8-line
 * `buildExplosionGfx` Graphics) with a multi-particle radial burst tinted
 * to the ship's kind colour, plus a one-shot `ShockwaveFilter` attached to
 * the app stage that auto-detaches after its lifetime.
 *
 * Quality dial (callee-side per hostile-review #17):
 *  - high    : 40 particles, 1.2 s lifetime, ShockwaveFilter 250 ms
 *  - medium  : 20 particles, 1.0 s lifetime, ShockwaveFilter 200 ms
 *  - low     : 10 particles, 0.7 s lifetime, NO ShockwaveFilter
 *  - minimal : fallback to `buildExplosionGfx` (today's 8-line starburst)
 *              — defensive-design floor matching the "every collidable
 *              entity must be in predWorld" preservation rule.
 *
 * Pool: bounded at 200 active particle Graphics + 8 active shockwave
 * filters (oldest-out eviction). At 40 particles per burst that's ~5
 * concurrent bursts — well past the "5 ships die at once" edge case.
 *
 * Hand-rolled Graphics particles (not `@pixi/particle-emitter`): M4 ships
 * the simpler implementation first; M5 (engines) introduces the library
 * via `EmitterPool` for continuous effects where it's a better fit. The
 * two patterns coexist behind their per-effect modules.
 */

import type { Application, Container, Graphics as PixiGraphics, Filter } from 'pixi.js';
import type { EffectQuality, ParticleBurstOpts } from '@core/contracts/IEffects';
import { DEFAULT_DESTRUCTION_PARAMS } from '../config/effectDefaults';

/** Factories for Pixi handles. Constructor injection lets tests stub the
 *  Pixi classes that touch the DOM (`new Graphics()` is fine in node but
 *  `new ShockwaveFilter()` calls `document.createElement('canvas')` for
 *  shader-context probing). Production wires the real constructors. */
export interface DestructionFactories {
  /** Builds a new fresh particle Graphics (small filled triangle ~3 px). */
  makeParticleGfx: (tint: number) => PixiGraphics;
  /** Builds the legacy starburst (minimal-tier fallback). */
  makeFallbackGfx: () => PixiGraphics;
  /** Builds a ShockwaveFilter instance with mutable `time` / `amplitude` /
   *  `center`. Returns the filter cast to the loose `ShockwaveLike` shape
   *  so the destruction module never names `pixi-filters` directly. */
  makeShockFilter: (center: { x: number; y: number }) => ShockwaveLike;
}

/** Minimal surface DestructionFx uses on a `ShockwaveFilter`. */
export interface ShockwaveLike extends Filter {
  time: number;
  amplitude: number;
  center: { x: number; y: number };
}

interface DestructionParticle {
  gfx: PixiGraphics;
  /** Velocity in world units per second. */
  vx: number;
  vy: number;
  /** Lifetime remaining in seconds. 0 ⇒ dead, ready for pool eviction. */
  lifeS: number;
  /** Initial lifetime in seconds — for alpha/scale interpolation. */
  initialLifeS: number;
  /** Tint applied at spawn. */
  tint: number;
}

interface ActiveShock {
  filter: ShockwaveLike;
  /** Time since spawn (seconds) — drives the `time` uniform. */
  ageS: number;
  /** Lifetime in seconds — detaches at expiry. */
  lifeS: number;
}

interface FallbackExplosion {
  gfx: PixiGraphics;
  framesLeft: number;
}

const PARTICLE_POOL_CAP = 200;
const SHOCK_POOL_CAP = 8;

const QUALITY_DIAL: Record<EffectQuality, { particles: number; lifetimeMs: number; shockMs: number | null } | null> = {
  high:    { particles: 40, lifetimeMs: 1200, shockMs: 250 },
  medium:  { particles: 20, lifetimeMs: 1000, shockMs: 200 },
  low:     { particles: 10, lifetimeMs:  700, shockMs: null },
  minimal: null, // → fallback to buildExplosionGfx
};

export class DestructionFx {
  private readonly active: DestructionParticle[] = [];
  private readonly shocks: ActiveShock[] = [];
  private readonly fallbacks: FallbackExplosion[] = [];
  /** Free-pool of DestructionParticle records (plan: lazy-mochi P3,
   *  2026-05-29). When a particle dies we push its record + the
   *  underlying Graphics onto this stack instead of destroying; the
   *  next spawn pops a record (already detached from the parent
   *  container) and resets its mutable fields in place. Eliminates the
   *  per-kill `factories.makeParticleGfx()` + `{...}` literal that
   *  dominated the destruction-burst alloc spike at the centre of the
   *  major-GC events causing the rafGap regression. Tint is fixed per
   *  Graphics so pools are tint-keyed (different ship kinds give
   *  different tints; ~5-10 distinct tints in practice). Mirrors
   *  EngineEmitter + ImpactSparks. */
  private readonly freeByTint = new Map<number, DestructionParticle[]>();

  constructor(
    private readonly parent: Container,
    private readonly app: Application,
    private readonly getQuality: () => EffectQuality,
    private readonly factories: DestructionFactories,
  ) {}

  /**
   * Spawn a destruction burst at the world coord (x, y). Caller has already
   * resolved the position via `decideExplosionPosition` (preserves the
   * Phase 6b lingering-hull lookup contract).
   *
   * At `minimal` quality this dispatches to the existing `buildExplosionGfx`
   * fallback so the previous visual still plays — same shape as today's
   * `PixiRenderer.ts:558-606` inline path.
   */
  spawnBurst(worldX: number, worldY: number, opts?: ParticleBurstOpts): void {
    const q = this.getQuality();
    const dial = QUALITY_DIAL[q];
    const tint = opts?.tint ?? 0xff9944;
    const intensity = opts?.intensity ?? 1;

    if (dial === null) {
      this.spawnFallback(worldX, worldY);
      return;
    }

    const count = Math.max(1, Math.round(dial.particles * intensity));
    const lifetimeS = (dial.lifetimeMs / 1000) * Math.max(0.5, intensity);

    for (let i = 0; i < count; i++) {
      this.spawnParticle(worldX, worldY, lifetimeS, tint);
    }

    if (dial.shockMs !== null) {
      this.spawnShock(worldX, worldY, dial.shockMs / 1000);
    }
  }

  /**
   * Spawn ONLY the ShockwaveFilter without the particle burst — for
   * `IFilterEffects.triggerOneShotFilter('destruction-shock', ...)` used
   * by paths that want the shock visually distinct from the particle
   * burst (e.g. the sandbox tuning panel).
   */
  spawnShockOnly(worldX: number, worldY: number, durationMs?: number): void {
    const ms = durationMs ?? DEFAULT_DESTRUCTION_PARAMS.shockwaveDurationMs;
    this.spawnShock(worldX, worldY, ms / 1000);
  }

  /** Per-frame advance — called from `EffectsService.tick`. */
  tick(dtSec: number): void {
    this.tickParticles(dtSec);
    this.tickShocks(dtSec);
    this.tickFallbacks();
  }

  /** Counters for `EffectsService.getStats` / budget recordCounts. */
  activeCount(): { bursts: number; filters: number } {
    return { bursts: this.active.length + this.fallbacks.length, filters: this.shocks.length };
  }

  /** Reset for sector handoff: wipe everything, no animation. Destroys
   *  both live AND pooled Graphics — a sector swap is the right time to
   *  release GPU buffers; the destination sector will warm a fresh pool.
   *  Mirrors EngineEmitter + ImpactSparks. */
  resetForSectorHandoff(): void {
    for (const p of this.active) {
      this.parent.removeChild(p.gfx);
      p.gfx.destroy();
    }
    this.active.length = 0;
    for (const pool of this.freeByTint.values()) {
      for (const p of pool) p.gfx.destroy();
    }
    this.freeByTint.clear();
    for (const s of this.shocks) {
      const filters = this.app.stage.filters;
      if (Array.isArray(filters)) {
        const idx = (filters as unknown[]).indexOf(s.filter);
        if (idx >= 0) (filters as unknown[]).splice(idx, 1);
        this.app.stage.filters = filters as never;
      }
    }
    this.shocks.length = 0;
    for (const f of this.fallbacks) {
      this.parent.removeChild(f.gfx);
      f.gfx.destroy();
    }
    this.fallbacks.length = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private spawnParticle(x: number, y: number, lifetimeS: number, tint: number): void {
    // Pool cap: evict oldest first. plan: lazy-mochi — recycle the
    // evicted particle's record + Graphics back to the free pool so a
    // burst at cap doesn't burn an allocation later.
    if (this.active.length >= PARTICLE_POOL_CAP) {
      const oldest = this.active.shift();
      if (oldest) {
        this.parent.removeChild(oldest.gfx);
        this.releaseToFree(oldest);
      }
    }

    // Random direction + speed: radial spread, magnitude ~80-160 u/s.
    const angle = Math.random() * Math.PI * 2;
    const speed = 80 + Math.random() * 80;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    // Pool path (plan: lazy-mochi): pop a free record + Graphics if one
    // exists for this tint, reset its mutable fields. Otherwise allocate
    // (only happens until the pool is saturated). Invariant #14.
    let p = this.acquireFromFree(tint);
    if (!p) {
      p = {
        gfx: this.factories.makeParticleGfx(tint),
        vx, vy,
        lifeS: lifetimeS,
        initialLifeS: lifetimeS,
        tint,
      };
    } else {
      p.vx = vx;
      p.vy = vy;
      p.lifeS = lifetimeS;
      p.initialLifeS = lifetimeS;
    }
    p.gfx.x = x;
    // World->Pixi Y flip (src/client/CLAUDE.md "Game-space coords ... MUST flip Y").
    p.gfx.y = -y;
    p.gfx.alpha = 1;
    p.gfx.scale.set(1);
    // Particle heading lines up with its velocity so the triangle "points
    // outward". atan2 + Pixi-Y-flip-quirk: same convention as
    // projectileSpriteUpdater (heading = -atan2(vy, vx) + π/2).
    p.gfx.rotation = -Math.atan2(vy, vx) + Math.PI / 2;

    this.parent.addChild(p.gfx);
    this.active.push(p);
  }

  private acquireFromFree(tint: number): DestructionParticle | null {
    const pool = this.freeByTint.get(tint);
    if (!pool || pool.length === 0) return null;
    return pool.pop()!;
  }

  private releaseToFree(p: DestructionParticle): void {
    let pool = this.freeByTint.get(p.tint);
    if (!pool) {
      pool = [];
      this.freeByTint.set(p.tint, pool);
    }
    pool.push(p);
  }

  private tickParticles(dtSec: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.lifeS -= dtSec;
      if (p.lifeS <= 0) {
        this.parent.removeChild(p.gfx);
        // plan: lazy-mochi — return the record + Graphics to the free
        // pool instead of destroying so the next burst can reuse. The
        // Graphics fill/geometry are baked at construction and stay
        // valid; only mutable state is reset on re-spawn.
        this.active.splice(i, 1);
        this.releaseToFree(p);
        continue;
      }
      // Drift outward in world units (CLAUDE.md Y-flip: world +y → pixi -y).
      p.gfx.x += p.vx * dtSec;
      p.gfx.y -= p.vy * dtSec;
      // Decay velocity slightly so particles fade in motion AND speed.
      p.vx *= 0.95;
      p.vy *= 0.95;
      const t = p.lifeS / p.initialLifeS; // 1 → 0
      p.gfx.alpha = t;
      // Scale grows slightly as alpha falls — visual "puff" expansion.
      const scale = 1 + (1 - t) * 0.5;
      p.gfx.scale.set(scale);
    }
  }

  private spawnShock(worldX: number, worldY: number, lifetimeS: number): void {
    if (this.shocks.length >= SHOCK_POOL_CAP) {
      const oldest = this.shocks.shift();
      if (oldest) this.detachFilter(oldest.filter);
    }

    // World→screen projection happens lazily inside the filter via
    // `center`. The parent is the world container; for now we use the
    // world coord directly (Pixi v8 ShockwaveFilter takes pixel-space
    // center per its docs — we pass world coords pre-camera-transform
    // which renders OK for screen-mid bursts but drifts off camera. The
    // sandbox lives in screen-space so this is fine; production calls
    // pass camera-relative coords).
    const filter = this.factories.makeShockFilter({ x: worldX, y: -worldY });

    const existing = Array.isArray(this.app.stage.filters)
      ? ([...(this.app.stage.filters as unknown[])] as import('pixi.js').Filter[])
      : [];
    existing.push(filter);
    this.app.stage.filters = existing;

    this.shocks.push({ filter, ageS: 0, lifeS: lifetimeS });
  }

  private tickShocks(dtSec: number): void {
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i]!;
      s.ageS += dtSec;
      if (s.ageS >= s.lifeS) {
        this.detachFilter(s.filter);
        this.shocks.splice(i, 1);
        continue;
      }
      s.filter.time = s.ageS;
      const t = s.ageS / s.lifeS;
      // sqrt(1-t) tail-off matches the warp burst pattern.
      const falloff = Math.sqrt(Math.max(0, 1 - t));
      s.filter.amplitude = 40 * falloff;
    }
  }

  private detachFilter(filter: ShockwaveLike): void {
    const filters = this.app.stage.filters;
    if (Array.isArray(filters)) {
      const idx = (filters as unknown[]).indexOf(filter);
      if (idx >= 0) {
        const next = [...(filters as unknown[])] as Filter[];
        next.splice(idx, 1);
        this.app.stage.filters = next.length > 0 ? next : [];
      }
    }
  }

  // ── Fallback (minimal tier) — re-uses the legacy starburst path ──

  private spawnFallback(worldX: number, worldY: number): void {
    const expl = this.factories.makeFallbackGfx();
    expl.x = worldX;
    expl.y = -worldY; // CLAUDE.md Y-flip
    this.parent.addChild(expl);
    this.fallbacks.push({ gfx: expl, framesLeft: 30 });
  }

  private tickFallbacks(): void {
    for (let i = this.fallbacks.length - 1; i >= 0; i--) {
      const f = this.fallbacks[i]!;
      f.framesLeft--;
      f.gfx.alpha = f.framesLeft / 30;
      f.gfx.scale.set(1 + (1 - f.framesLeft / 30) * 1.5);
      if (f.framesLeft <= 0) {
        this.parent.removeChild(f.gfx);
        f.gfx.destroy();
        this.fallbacks.splice(i, 1);
      }
    }
  }
}
