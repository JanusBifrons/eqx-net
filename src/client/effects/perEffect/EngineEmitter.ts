/**
 * `EngineEmitter` — per-ship continuous particle trails for thrust + boost.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` M5.
 *
 * The existing `boostFlames` / `thrustFlames` Graphics taper triangles in
 * `PixiRenderer.ts:116-128` + `pixi/spriteBuilders.ts` are KEPT as the
 * `minimal` tier fallback (and as the immediate flame at high/medium/low).
 * `EngineEmitter` adds a particle trail BEHIND the ship's stern that
 * complements the legacy flame — small fast-fading particles that imply
 * exhaust velocity.
 *
 * Tier dial (callee-side):
 *  - high    : both thrust + boost emitters fire; boost emits larger,
 *              brighter particles layered on top.
 *  - medium  : thrust emitter only (boost emitter disabled — boost trail
 *              dropped first because the legacy boost flame already reads
 *              loud enough on its own).
 *  - low     : thrust emitter at half rate.
 *  - minimal : no particles (legacy Graphics flames are the only visual).
 *
 * Ownership: one entry per (entityId, kind) — `setActive(id, kind, true)`
 * registers, `setActive(id, kind, false)` unregisters. Re-entrant.
 *
 * Position resolution: callee passes a `getPose` callback per tick. This
 * keeps the emitter from holding direct refs to the renderer's sprite
 * maps and lets it work uniformly for players (`mirror.ships`) and drones
 * (`mirror.swarm`).
 *
 * Particles: hand-rolled Graphics (same pattern as DestructionFx) — small
 * circles with random outward velocity from the stern, fade + shrink over
 * lifetime. Pool cap 300 (60 emit-rate × 0.5 s lifetime × ~10 ships =
 * 300 — past steady-state worst case).
 */

import type { Container, Graphics as PixiGraphics } from 'pixi.js';
import type { EffectQuality, ContinuousEffectKind } from '@core/contracts/IEffects';
import { DEFAULT_ENGINE_PARAMS } from '../config/effectDefaults';

/** Factory for engine particle Graphics. Pixi import isolation seam. */
export interface EngineFactories {
  makeParticle: (tint: number) => PixiGraphics;
}

/** Pose surface the emitter polls per tick. */
export type EnginePoseFn = (entityId: string) => { x: number; y: number; angle: number } | null;

interface ActiveEmitter {
  entityId: string;
  kind: ContinuousEffectKind;
  /** Wall-clock since last emit (seconds). Drives emit cadence. */
  emitAccumSec: number;
}

interface EngineParticle {
  gfx: PixiGraphics;
  /** Tint baked into `gfx` — used to route the record back to the
   *  right free-pool on death. The factory sets this at construction
   *  and we never repaint it (Pixi v8 Graphics fill is finalised at
   *  build time; cheaper to keep tint-segregated pools). */
  tint: number;
  vx: number;
  vy: number;
  lifeS: number;
  initialLifeS: number;
}

const PARTICLE_POOL_CAP = 300;

const QUALITY_DIAL: Record<EffectQuality, { thrustRateMul: number; boostEnabled: boolean }> = {
  high:    { thrustRateMul: 1.0, boostEnabled: true },
  medium:  { thrustRateMul: 1.0, boostEnabled: false },
  low:     { thrustRateMul: 0.5, boostEnabled: false },
  minimal: { thrustRateMul: 0.0, boostEnabled: false },
};

export class EngineEmitter {
  /** Active emitters keyed by `${entityId}:${kind}`. */
  private readonly emitters = new Map<string, ActiveEmitter>();
  /** All particles across all emitters — pool-capped, oldest-out. */
  private readonly particles: EngineParticle[] = [];
  /** Free-pool of EngineParticle records (post-2026-05-28 — capture
   *  8y3njt). When a particle dies we push its record + the underlying
   *  Graphics onto this stack instead of destroying; the next emit
   *  pops a record (already detached from the parent container) and
   *  resets its fields in place. Eliminates the per-frame
   *  `factories.makeParticle()` + `{...}` literal that dominated client
   *  allocation under continuous thrust. Tint is fixed per Graphics so
   *  pools are tint-keyed (only 2 distinct tints in practice: thrust
   *  orange + boost blue). */
  private readonly freeByTint = new Map<number, EngineParticle[]>();

  constructor(
    private readonly parent: Container,
    private readonly getQuality: () => EffectQuality,
    private readonly factories: EngineFactories,
  ) {}

  /**
   * Register or unregister a continuous emitter. Re-entrant: calling with
   * the same (id, kind, active) is a no-op.
   */
  setActive(entityId: string, kind: ContinuousEffectKind, active: boolean): void {
    // Engine emitter only handles 'thrust' and 'boost'. 'shield' is M8.
    if (kind !== 'thrust' && kind !== 'boost') return;
    const key = `${entityId}:${kind}`;
    const exists = this.emitters.has(key);
    if (active && !exists) {
      this.emitters.set(key, { entityId, kind, emitAccumSec: 0 });
    } else if (!active && exists) {
      this.emitters.delete(key);
    }
  }

  /**
   * Per-frame: emit new particles per active emitter (gated by quality
   * tier) + advance all live particles.
   *
   * `getPose` is the per-frame ship-position lookup. The emitter reads
   * the pose at the moment of emission so particles spawn at the current
   * stern, then drift independently. NEVER stores pose between frames.
   */
  tick(dtSec: number, getPose: EnginePoseFn): void {
    const q = this.getQuality();
    const dial = QUALITY_DIAL[q];

    for (const e of this.emitters.values()) {
      const params = e.kind === 'thrust'
        ? { rateHz: DEFAULT_ENGINE_PARAMS.thrustEmitRateHz * dial.thrustRateMul, lifetimeMs: DEFAULT_ENGINE_PARAMS.thrustLifetimeMs, spread: DEFAULT_ENGINE_PARAMS.thrustSpread, tint: 0xff8844 }
        : { rateHz: dial.boostEnabled ? DEFAULT_ENGINE_PARAMS.boostEmitRateHz : 0, lifetimeMs: DEFAULT_ENGINE_PARAMS.boostLifetimeMs, spread: DEFAULT_ENGINE_PARAMS.boostSpread, tint: 0x88ccff };
      if (params.rateHz <= 0) continue;

      const intervalSec = 1 / params.rateHz;
      e.emitAccumSec += dtSec;
      // Catch-up cap: never spawn more than 5 particles per tick from one
      // emitter (defensive against long pauses → giant catch-up bursts).
      let emittedThisTick = 0;
      while (e.emitAccumSec >= intervalSec && emittedThisTick < 5) {
        const pose = getPose(e.entityId);
        if (!pose) break;
        this.emitParticle(pose, params.spread, params.tint, params.lifetimeMs / 1000);
        e.emitAccumSec -= intervalSec;
        emittedThisTick++;
      }
      // Drop accumulator if we hit the cap to avoid runaway.
      if (emittedThisTick >= 5) e.emitAccumSec = 0;
    }

    this.tickParticles(dtSec);
  }

  /** Counts for the budget. */
  activeCount(): { emitters: number; particles: number } {
    return { emitters: this.emitters.size, particles: this.particles.length };
  }

  /** Wipe everything on sector handoff. Destroys both live and pooled
   *  Graphics — a sector swap is the right time to release the GPU
   *  buffers; the destination sector will warm a fresh pool. */
  resetForSectorHandoff(): void {
    for (const p of this.particles) {
      this.parent.removeChild(p.gfx);
      p.gfx.destroy();
    }
    this.particles.length = 0;
    for (const pool of this.freeByTint.values()) {
      for (const p of pool) p.gfx.destroy();
    }
    this.freeByTint.clear();
    this.emitters.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────

  private emitParticle(
    pose: { x: number; y: number; angle: number },
    spread: number,
    tint: number,
    lifetimeS: number,
  ): void {
    if (this.particles.length >= PARTICLE_POOL_CAP) {
      const oldest = this.particles.shift();
      if (oldest) {
        this.parent.removeChild(oldest.gfx);
        this.releaseToFree(oldest);
      }
    }

    // Ship-relative stern offset (game-space). Ship's forward is
    // -sin(angle), cos(angle); stern is the opposite direction. We emit
    // ~25 u behind the ship's centre + some spread.
    const sternOffsetWorld = -25;
    const sx = pose.x + Math.sin(pose.angle) * (-sternOffsetWorld); // = pose.x - sin*25 = stern X
    const sy = pose.y - Math.cos(pose.angle) * (-sternOffsetWorld); // = pose.y + cos*25 = stern Y

    // Velocity: behind the ship with a random spread cone.
    const heading = pose.angle + Math.PI; // pointing astern
    const spreadAngle = heading + (Math.random() - 0.5) * spread;
    const speed = 60 + Math.random() * 40;
    const vx = -Math.sin(spreadAngle) * speed;
    const vy = Math.cos(spreadAngle) * speed;

    // Pool path: pop a free record + Graphics if one exists for this
    // tint, reset its mutable fields. Otherwise allocate (only happens
    // until the pool is saturated). Invariant #14 — capture 8y3njt.
    let p = this.acquireFromFree(tint);
    if (!p) {
      p = {
        gfx: this.factories.makeParticle(tint),
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
      // Pixi v8 Graphics doesn't carry stale state we need to reset
      // here — alpha + scale are set by tickParticles on the next frame
      // before paint, and position is set just below.
    }
    // Apply Y-flip when writing to Pixi.
    p.gfx.x = sx;
    p.gfx.y = -sy;
    p.gfx.alpha = 1;
    p.gfx.scale.set(1, 1);
    this.parent.addChild(p.gfx);
    this.particles.push(p);
  }

  private acquireFromFree(tint: number): EngineParticle | null {
    const pool = this.freeByTint.get(tint);
    if (!pool || pool.length === 0) return null;
    return pool.pop()!;
  }

  private releaseToFree(p: EngineParticle): void {
    let pool = this.freeByTint.get(p.tint);
    if (!pool) {
      pool = [];
      this.freeByTint.set(p.tint, pool);
    }
    pool.push(p);
  }

  private tickParticles(dtSec: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.lifeS -= dtSec;
      if (p.lifeS <= 0) {
        this.parent.removeChild(p.gfx);
        // Capture 8y3njt — return the record + Graphics to the free
        // pool instead of destroying so the next emit can reuse. The
        // Graphics fill / geometry are baked at construction and stay
        // valid; only mutable state (pos / alpha / scale) is reset on
        // re-emit.
        this.particles.splice(i, 1);
        this.releaseToFree(p);
        continue;
      }
      // Drift in world; Pixi Y is flipped on write.
      p.gfx.x += p.vx * dtSec;
      p.gfx.y -= p.vy * dtSec;
      const t = p.lifeS / p.initialLifeS;
      p.gfx.alpha = t;
      p.gfx.scale.set(t * 1.2);
    }
  }
}
