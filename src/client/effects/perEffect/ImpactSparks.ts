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

export class ImpactSparks {
  private readonly active: SparkParticle[] = [];

  constructor(
    private readonly parent: Container,
    private readonly getQuality: () => EffectQuality,
    private readonly factories: ImpactFactories,
  ) {}

  /**
   * Spawn a spark burst at the given world coord. Tint defaults to a
   * warm hull-hit colour; callers typically pass the shield-hit cyan or
   * the hull-hit orange they've derived from the `DamageEvent.hitLayer`.
   */
  spawnBurst(worldX: number, worldY: number, opts?: ParticleBurstOpts): void {
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
        p.gfx.destroy();
        this.active.splice(i, 1);
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

  resetForSectorHandoff(): void {
    for (const p of this.active) {
      this.parent.removeChild(p.gfx);
      p.gfx.destroy();
    }
    this.active.length = 0;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private spawnParticle(x: number, y: number, lifetimeS: number, tint: number): void {
    if (this.active.length >= PARTICLE_POOL_CAP) {
      const oldest = this.active.shift();
      if (oldest) {
        this.parent.removeChild(oldest.gfx);
        oldest.gfx.destroy();
      }
    }
    const gfx = this.factories.makeSpark(tint);
    gfx.x = x;
    gfx.y = -y; // CLAUDE.md Y-flip
    const angle = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 80; // sparks are fast
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    this.parent.addChild(gfx);
    this.active.push({ gfx, vx, vy, lifeS: lifetimeS, initialLifeS: lifetimeS });
  }
}
