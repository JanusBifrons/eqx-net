/**
 * `EngineEmitter` — per-ship continuous particle trails for thrust + boost.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` M5; overhauled by
 * the engine-fx pass (plan `majestic-pie`).
 *
 * This is now the SOLE engine visual — the legacy triangle thrust/boost
 * flames were removed (particle-only decision). The plume is additive
 * hot-core particles (white-hot → base → smoke colour-over-life) emerging
 * from the per-kind nozzle, with speed-scaled density + velocity-coherent
 * streaming.
 *
 * Tier dial (callee-side):
 *  - high    : both thrust + boost emitters fire; boost emits larger,
 *              brighter particles layered on top.
 *  - medium  : thrust emitter only (boost emitter disabled first).
 *  - low     : thrust emitter at half rate.
 *  - minimal : thrust emitter at a sparse floor rate — NOT zero, because
 *              there's no longer a flame fallback; every device must still
 *              show some exhaust.
 *
 * Ownership: one entry per (entityId, kind) — `setActive(id, kind, true)`
 * registers, `setActive(id, kind, false)` unregisters. Re-entrant.
 *
 * Position resolution: callee passes a `getPose` callback per tick. This
 * keeps the emitter from holding direct refs to the renderer's sprite
 * maps and lets it work uniformly for players (`mirror.ships`) and drones
 * (`mirror.swarm`).
 *
 * Particles: pooled additive hot-core Graphics (white-baked 2-layer dot;
 * `gfx.tint` ramps the colour over life). Spawned across the nozzle mouth
 * with velocity = ship-velocity inheritance + an astern ejection cone; fade +
 * taper over lifetime. Pool cap 300 (60 emit-rate × ~0.5 s lifetime × ~10
 * ships = 300 — past steady-state worst case).
 */

import type { Container, Graphics as PixiGraphics } from 'pixi.js';
import type { EffectQuality, ContinuousEffectKind } from '@core/contracts/IEffects';
import { DEFAULT_ENGINE_PARAMS } from '../config/effectDefaults';

/** Factory for engine particle Graphics. Pixi import isolation seam. */
export interface EngineFactories {
  makeParticle: (tint: number) => PixiGraphics;
}

/** Pose surface the emitter polls per tick. `vx`/`vy` (game-space velocity,
 *  filled by the renderer from the render mirror) drive speed-scaled emission
 *  + velocity-coherent streaming; absent ⇒ treated as 0 (a stationary engine
 *  still emits at the floor rate). */
export type EnginePoseFn = (
  entityId: string,
) => { x: number; y: number; angle: number; vx?: number; vy?: number } | null;

/** Per-kind engine geometry handed to `setActive` at registration (computed
 *  once by the renderer from the ship catalogue — see `engineGeometry.ts`).
 *  Structurally compatible with `EngineProfile` so the renderer passes it
 *  directly without coupling this module to the render zone. */
export interface EngineProfileInput {
  /** Distance behind ship centre (game units) to the nozzle. */
  sternOffset: number;
  /** Plume-size multiplier (nozzle width / particle size / density). */
  plumeScale: number;
}

/** Fallback nozzle distance when no profile is supplied (tests / legacy
 *  callers). Roughly the fighter rear extent. */
const FALLBACK_STERN_OFFSET = 12;

interface ActiveEmitter {
  entityId: string;
  kind: ContinuousEffectKind;
  /** Wall-clock since last emit (seconds). Drives emit cadence. */
  emitAccumSec: number;
  /** Per-kind nozzle distance behind ship centre (game units). */
  sternOffset: number;
  /** Per-kind plume-size multiplier (nozzle width / particle size / density). */
  plumeScale: number;
}

interface EngineParticle {
  gfx: PixiGraphics;
  /** Base/MID-life colour AND the free-pool routing key. The Graphics is
   *  baked WHITE (additive) — colour-over-life is driven per frame via
   *  `gfx.tint`, ramping white-hot (birth) → this base → `smokeColor` (death).
   *  The pool stays tint-keyed by THIS value (never the transient display
   *  tint) so routing is stable. */
  tint: number;
  /** Late-life smoke colour the per-frame tint ramps toward as it dies. */
  smokeColor: number;
  /** Per-particle size multiplier (random, for plume variation). */
  sizeMul: number;
  vx: number;
  vy: number;
  lifeS: number;
  initialLifeS: number;
}

const PARTICLE_POOL_CAP = 300;

/** White-hot birth colour the per-frame tint ramps DOWN from. */
const HOT_COLOR = 0xffffff;

/** Per-channel integer lerp between two RGB hex colours. Pure scalar math —
 *  no allocation, safe in the per-frame particle loop (Invariant #14). */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const r = (ar + (((b >> 16) & 0xff) - ar) * t) & 0xff;
  const g = (ag + (((b >> 8) & 0xff) - ag) * t) & 0xff;
  const bl = (ab + ((b & 0xff) - ab) * t) & 0xff;
  return (r << 16) | (g << 8) | bl;
}

const QUALITY_DIAL: Record<EffectQuality, { thrustRateMul: number; boostEnabled: boolean }> = {
  high:    { thrustRateMul: 1.0, boostEnabled: true },
  medium:  { thrustRateMul: 1.0, boostEnabled: false },
  low:     { thrustRateMul: 0.5, boostEnabled: false },
  // Particle-only: minimal must still show a sparse plume (no flame fallback).
  minimal: { thrustRateMul: 0.35, boostEnabled: false },
};

export interface EngineEmitterOptions {
  /** When true, tick() skips all particle emission. Registration
   *  (setActive) still tracks active emitters cheaply so toggling the
   *  flag off mid-session would resume emission. Plan: melodic-engelbart
   *  Step 2b kill switch. */
  particlesDisabled?: boolean;
}

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
  private readonly particlesDisabled: boolean;

  constructor(
    private readonly parent: Container,
    private readonly getQuality: () => EffectQuality,
    private readonly factories: EngineFactories,
    options: EngineEmitterOptions = {},
  ) {
    this.particlesDisabled = options.particlesDisabled === true;
  }

  /**
   * Register or unregister a continuous emitter. Re-entrant: calling with
   * the same (id, kind, active) is a no-op.
   */
  setActive(
    entityId: string,
    kind: ContinuousEffectKind,
    active: boolean,
    profile?: EngineProfileInput,
  ): void {
    // Engine emitter only handles 'thrust' and 'boost'. 'shield' is M8.
    if (kind !== 'thrust' && kind !== 'boost') return;
    const key = `${entityId}:${kind}`;
    const exists = this.emitters.has(key);
    if (active && !exists) {
      this.emitters.set(key, {
        entityId,
        kind,
        emitAccumSec: 0,
        sternOffset: profile?.sternOffset ?? FALLBACK_STERN_OFFSET,
        plumeScale: profile?.plumeScale ?? 1,
      });
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
    if (this.particlesDisabled) {
      // Still advance live particles so any in-flight pooling cleans up,
      // but skip every emit. With the flag set from boot, there are no
      // live particles so this is effectively a no-op.
      this.tickParticles(dtSec);
      return;
    }
    const q = this.getQuality();
    const dial = QUALITY_DIAL[q];

    for (const e of this.emitters.values()) {
      const params = e.kind === 'thrust'
        ? { rateHz: DEFAULT_ENGINE_PARAMS.thrustEmitRateHz * dial.thrustRateMul, lifetimeMs: DEFAULT_ENGINE_PARAMS.thrustLifetimeMs, spread: DEFAULT_ENGINE_PARAMS.thrustSpread, tint: 0xff8844, smokeColor: DEFAULT_ENGINE_PARAMS.thrustSmokeColor, nozzleWidth: DEFAULT_ENGINE_PARAMS.thrustNozzleWidth, ejectSpeed: DEFAULT_ENGINE_PARAMS.thrustEjectSpeed, streamFactor: DEFAULT_ENGINE_PARAMS.thrustStreamFactor, refSpeed: DEFAULT_ENGINE_PARAMS.thrustRefSpeed, minRateFrac: DEFAULT_ENGINE_PARAMS.thrustMinRateFrac }
        : { rateHz: dial.boostEnabled ? DEFAULT_ENGINE_PARAMS.boostEmitRateHz : 0, lifetimeMs: DEFAULT_ENGINE_PARAMS.boostLifetimeMs, spread: DEFAULT_ENGINE_PARAMS.boostSpread, tint: 0x88ccff, smokeColor: DEFAULT_ENGINE_PARAMS.boostSmokeColor, nozzleWidth: DEFAULT_ENGINE_PARAMS.boostNozzleWidth, ejectSpeed: DEFAULT_ENGINE_PARAMS.boostEjectSpeed, streamFactor: DEFAULT_ENGINE_PARAMS.boostStreamFactor, refSpeed: DEFAULT_ENGINE_PARAMS.boostRefSpeed, minRateFrac: DEFAULT_ENGINE_PARAMS.boostMinRateFrac };
      if (params.rateHz <= 0) continue;

      // Poll the pose ONCE per emitter per tick (not per-particle): all
      // particles this tick share the pose + the speed reading is taken once.
      const pose = getPose(e.entityId);
      if (!pose) continue;

      // Speed-scaled emission: faster ship → denser plume (and longer jet),
      // slow/idle thrust → a sputter at `minRateFrac`. Fixes "they don't
      // spawn more/less when the engine moves faster".
      const speed = Math.hypot(pose.vx ?? 0, pose.vy ?? 0);
      const speedFrac = Math.max(params.minRateFrac, Math.min(1, speed / params.refSpeed));
      const rateHz = params.rateHz * speedFrac;
      if (rateHz <= 0) continue;

      const nozzleWidth = params.nozzleWidth * e.plumeScale;
      const ejectSpeed = params.ejectSpeed * (0.6 + 0.4 * speedFrac);
      const intervalSec = 1 / rateHz;
      e.emitAccumSec += dtSec;
      // Catch-up cap: never spawn more than 5 particles per tick from one
      // emitter (defensive against long pauses → giant catch-up bursts).
      let emittedThisTick = 0;
      while (e.emitAccumSec >= intervalSec && emittedThisTick < 5) {
        this.emitParticle(pose, params.spread, params.tint, params.lifetimeMs / 1000, e.sternOffset, nozzleWidth, ejectSpeed, params.streamFactor, params.smokeColor);
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
    pose: { x: number; y: number; angle: number; vx?: number; vy?: number },
    spread: number,
    tint: number,
    lifetimeS: number,
    sternOffset: number,
    nozzleWidth: number,
    ejectSpeed: number,
    streamFactor: number,
    smokeColor: number,
  ): void {
    if (this.particles.length >= PARTICLE_POOL_CAP) {
      const oldest = this.particles.shift();
      if (oldest) {
        this.parent.removeChild(oldest.gfx);
        this.releaseToFree(oldest);
      }
    }

    // Nozzle position (game-space). Forward = (-sin θ, cos θ); the stern
    // (astern) direction is the opposite, (sin θ, -cos θ). `pose.angle` is
    // now game-space (the renderer un-negates it — see entityPoseFromSprite),
    // and `sternOffset` is the per-kind hull rear extent so the plume emerges
    // AT the engine, not a flat 25 u behind centre.
    const sinA = Math.sin(pose.angle);
    const cosA = Math.cos(pose.angle);
    let sx = pose.x + sinA * sternOffset;
    let sy = pose.y - cosA * sternOffset;
    // Positional spread across the nozzle mouth, PERPENDICULAR to the thrust
    // axis. Perp(astern) = (cos θ, sin θ). Gives the plume width instead of a
    // single emit point.
    const perp = (Math.random() - 0.5) * nozzleWidth;
    sx += cosA * perp;
    sy += sinA * perp;

    // Velocity = a fraction of the ship's own velocity (so the plume TRAILS
    // the moving ship instead of being deposited in world space — the
    // "circle/arc when fast" bug) PLUS an astern ejection cone. (-sin, cos)
    // of (angle+π) is the astern direction.
    const heading = pose.angle + Math.PI; // pointing astern
    const spreadAngle = heading + (Math.random() - 0.5) * spread;
    const ejs = ejectSpeed * (0.8 + Math.random() * 0.4); // ±20% per-particle
    const vx = (pose.vx ?? 0) * streamFactor - Math.sin(spreadAngle) * ejs;
    const vy = (pose.vy ?? 0) * streamFactor + Math.cos(spreadAngle) * ejs;

    const sizeMul = 0.8 + Math.random() * 0.6; // ±, plume variation

    // Pool path: pop a free record + Graphics if one exists for this
    // tint, reset its mutable fields. Otherwise allocate (only happens
    // until the pool is saturated). Invariant #14 — capture 8y3njt.
    let p = this.acquireFromFree(tint);
    if (!p) {
      p = {
        gfx: this.factories.makeParticle(tint),
        tint,
        smokeColor,
        sizeMul,
        vx, vy,
        lifeS: lifetimeS,
        initialLifeS: lifetimeS,
      };
    } else {
      p.smokeColor = smokeColor;
      p.sizeMul = sizeMul;
      p.vx = vx;
      p.vy = vy;
      p.lifeS = lifetimeS;
      p.initialLifeS = lifetimeS;
    }
    // Apply Y-flip when writing to Pixi. Birth state = white-hot, full alpha,
    // birth size — `tickParticles` re-derives tint/alpha/scale each frame.
    p.gfx.x = sx;
    p.gfx.y = -sy;
    p.gfx.alpha = 1;
    p.gfx.tint = HOT_COLOR;
    p.gfx.scale.set(sizeMul);
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
      const t = p.lifeS / p.initialLifeS; // 1 at birth → 0 at death
      p.gfx.alpha = t;
      // Taper the plume: bright + larger near the nozzle, shrinking with age.
      p.gfx.scale.set(p.sizeMul * (0.45 + 0.55 * t));
      // Colour-over-life: white-hot (birth) → base hue (mid) → smoke (death).
      // First 40 % of life ramps hot→base; the rest ramps base→smoke.
      p.gfx.tint = t > 0.6
        ? lerpColor(HOT_COLOR, p.tint, (1 - t) / 0.4)
        : lerpColor(p.tint, p.smokeColor, (0.6 - t) / 0.6);
    }
  }
}
