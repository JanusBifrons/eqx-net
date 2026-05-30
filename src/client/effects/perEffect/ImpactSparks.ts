/**
 * `ImpactSparks` — short-lived radial spark burst at damage impact points.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` M7.
 *
 * Triggered by `EffectsService.spawnBurst('impact', x, y, { tint })` which
 * is in turn driven by `mirror.pendingEffectTriggers` entries pushed from
 * `ColyseusClient.handleDamage` at the moment a `DamageEvent` lands. Each
 * burst is small (~10 particles) and short-lived (~320 ms) — visually a
 * "flash of sparks" without the heavy destruction burst's footprint.
 *
 * Tier dial (callee-side):
 *  - high    : 24 particles
 *  - medium  : 12 particles
 *  - low     : 6 particles
 *  - minimal : skip entirely (the floating damage number alone reads
 *              the hit; sparks are decorative-only at this tier)
 *
 * Authoritative-only on first pass per the plan's deliberate asymmetry
 * with damage numbers (which have a predicted path via clientShotId).
 * The reserved design space — `mirror.pendingEffectCancels` + a `tag`
 * field on triggers — is documented in `src/client/CLAUDE.md` Effects
 * section.
 *
 * Hand-rolled Graphics particles in the same pattern as DestructionFx /
 * EngineEmitter. Pool cap 160 (16 concurrent bursts × 24 particles
 * worst case + headroom).
 */

import type { Container, Graphics as PixiGraphics } from 'pixi.js';
import type { EffectQuality, ParticleBurstOpts } from '@core/contracts/IEffects';

export interface ImpactFactories {
  makeSpark: (tint: number) => PixiGraphics;
}

interface SparkParticle {
  gfx: PixiGraphics;
  /** Tint baked into `gfx` — used to route the record back to the
   *  right free-pool on death. Pixi v8 Graphics fill is finalised at
   *  build time; cheaper to keep tint-segregated pools (matches the
   *  EngineEmitter pattern). */
  tint: number;
  vx: number;
  vy: number;
  lifeS: number;
  initialLifeS: number;
}

const PARTICLE_POOL_CAP = 160;
const DEFAULT_LIFETIME_S = 0.32;

const QUALITY_DIAL: Record<EffectQuality, number | null> = {
  high: 24,
  medium: 12,
  low: 6,
  minimal: null, // skip
};

export interface ImpactSparksOptions {
  /** When true, spawnBurst is a no-op (plan: melodic-engelbart Step 2b
   *  kill switch). */
  particlesDisabled?: boolean;
}

export class ImpactSparks {
  private readonly active: SparkParticle[] = [];
  /** Free-pool of SparkParticle records (plan: lazy-mochi P3, 2026-05-29).
   *  When a spark dies we push its record + the underlying Graphics
   *  onto this stack instead of destroying; the next spawn pops a
   *  record (already detached from the parent container) and resets
   *  its mutable fields in place. Eliminates the per-hit
   *  `factories.makeSpark()` + `{...}` literal that dominated client
   *  allocation in combat (24 sparks per hit × every hit). Tint is
   *  fixed per Graphics so pools are tint-keyed (two distinct tints
   *  in practice: shield-hit cyan + hull-hit orange). Mirrors
   *  EngineEmitter's freeByTint pool. */
  private readonly freeByTint = new Map<number, SparkParticle[]>();
  private readonly particlesDisabled: boolean;

  constructor(
    private readonly parent: Container,
    private readonly getQuality: () => EffectQuality,
    private readonly factories: ImpactFactories,
    options: ImpactSparksOptions = {},
  ) {
    this.particlesDisabled = options.particlesDisabled === true;
  }

  /**
   * Spawn a spark burst at the given world coord. Tint defaults to a
   * warm hull-hit colour; callers typically pass the shield-hit cyan or
   * the hull-hit orange they've derived from the `DamageEvent.hitLayer`.
   */
  spawnBurst(worldX: number, worldY: number, opts?: ParticleBurstOpts): void {
    if (this.particlesDisabled) return;
    const q = this.getQuality();
    const count = QUALITY_DIAL[q];
    if (count === null) return; // minimal: skip

    const tint = opts?.tint ?? 0xff8844;
    const intensity = opts?.intensity ?? 1;
    const scaledCount = Math.max(1, Math.round(count * intensity));
    const lifetimeS = DEFAULT_LIFETIME_S * Math.max(0.5, intensity);

    for (let i = 0; i < scaledCount; i++) {
      this.spawnParticle(worldX, worldY, lifetimeS, tint);
    }
  }

  tick(dtSec: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.lifeS -= dtSec;
      if (p.lifeS <= 0) {
        this.parent.removeChild(p.gfx);
        // plan: lazy-mochi — return the record + Graphics to the free
        // pool instead of destroying so the next burst can reuse. The
        // Graphics fill/geometry are baked at construction and stay
        // valid; only mutable state (pos / alpha / scale / vx / vy /
        // lifeS) is reset on re-spawn.
        this.active.splice(i, 1);
        this.releaseToFree(p);
        continue;
      }
      p.gfx.x += p.vx * dtSec;
      p.gfx.y -= p.vy * dtSec;
      // Sparks decay velocity faster than destruction particles.
      p.vx *= 0.88;
      p.vy *= 0.88;
      const t = p.lifeS / p.initialLifeS;
      p.gfx.alpha = t;
      p.gfx.scale.set(t * 0.9 + 0.1);
    }
  }

  activeCount(): number {
    return this.active.length;
  }

  /** Wipe everything on sector handoff. Destroys both live and pooled
   *  Graphics — a sector swap is the right time to release the GPU
   *  buffers; the destination sector will warm a fresh pool. Mirrors
   *  EngineEmitter.resetForSectorHandoff. */
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
  }

  // ── Private ──────────────────────────────────────────────────────────

  private spawnParticle(x: number, y: number, lifetimeS: number, tint: number): void {
    if (this.active.length >= PARTICLE_POOL_CAP) {
      const oldest = this.active.shift();
      if (oldest) {
        this.parent.removeChild(oldest.gfx);
        this.releaseToFree(oldest);
      }
    }
    const angle = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 80; // sparks are fast
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    // Pool path (plan: lazy-mochi): pop a free record + Graphics if one
    // exists for this tint, reset its mutable fields. Otherwise allocate
    // (only happens until the pool is saturated). Invariant #14.
    let p = this.acquireFromFree(tint);
    if (!p) {
      p = {
        gfx: this.factories.makeSpark(tint),
        tint,
        vx, vy,
        lifeS: lifetimeS,
        initialLifeS: lifetimeS,
      };
    } else {
      p.vx = vx;
      p.vy = vy;
      p.lifeS = lifetimeS;
      p.initialLifeS = lifetimeS;
    }
    p.gfx.x = x;
    p.gfx.y = -y; // CLAUDE.md Y-flip
    p.gfx.alpha = 1;
    p.gfx.scale.set(1, 1);
    this.parent.addChild(p.gfx);
    this.active.push(p);
  }

  private acquireFromFree(tint: number): SparkParticle | null {
    const pool = this.freeByTint.get(tint);
    if (!pool || pool.length === 0) return null;
    return pool.pop()!;
  }

  private releaseToFree(p: SparkParticle): void {
    let pool = this.freeByTint.get(p.tint);
    if (!pool) {
      pool = [];
      this.freeByTint.set(p.tint, pool);
    }
    pool.push(p);
  }
}
