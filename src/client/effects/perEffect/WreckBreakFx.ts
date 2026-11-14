/**
 * `WreckBreakFx` — capital destruction S3: the break-up of a capital into
 * wreck pieces (docs/architecture/capital-destruction.md "S3").
 *
 * One burst at the kill point: a short, small white core flash (larger for a
 * clean snap; the renderer adds FxExplosions fireballs there too), dust
 * that billows out and fades, and hot shards flung outward that spin, cool and
 * fade. Particles, never bodies: purely visual, nothing collides.
 *
 * Everything is sized from the wreck's radius (world units), so a battleship's
 * break-up reads at the zoom it is seen at. Counts follow the effects tier:
 *
 *   high 70 dust + 40 shards · medium 40 + 24 · low 18 + 10 · minimal 8 + 4
 *
 * The pool (`MAX_DUST` + `MAX_SHARDS` + `MAX_FLASHES`) is built on the FIRST
 * break-up (never for a session without one) and reused; its container is only
 * on the stage while something is live, so an idle pool adds no display
 * objects. The per-frame tick allocates nothing (invariant #14).
 */
import { Container, Graphics } from 'pixi.js';
import type { EffectQuality, ParticleBurstOpts } from '@core/contracts/IEffects';

const MAX_DUST = 140;
const MAX_SHARDS = 80;
const MAX_FLASHES = 4;

/** Per-tier counts for one break-up. */
export const WRECK_BREAK_DIAL: Record<EffectQuality, { dust: number; shards: number }> = {
  high: { dust: 70, shards: 40 },
  medium: { dust: 40, shards: 24 },
  low: { dust: 18, shards: 10 },
  minimal: { dust: 8, shards: 4 },
};

/** The core flash: short and small (money-shot review: a hull-wide white disc
 *  and grey halo read as a UI overlay and hid the break). The fireballs
 *  (FxExplosions, spawned by the renderer at the same point) carry the blast. */
const FLASH_LIFE_S = 0.22;
/** Core flash start / end radius, as a share of the wreck radius. */
const FLASH_R0 = 0.02;
const FLASH_R1 = 0.08;
const DUST_TINT = 0x7a6c62;
/** Dust puffs: thinner and smaller than #518 (money-shot review: opaque flat
 *  discs sat over the fireballs and the break), still billowing out. */
const DUST_ALPHA = 0.32;
/** Owner decision 2026-11-13 ("smaller kill blast"): the dust hid the
 *  cracks spreading from the kill point. It now stays within the kill
 *  blast's reach (`WRECK_BLAST_REACH`, ~0.11 of the wreck radius; was
 *  flung out to ~0.4) and lifts in ~1.2 s (was ~3 s). */
const DUST_GROW = 0.018;
const DUST_SPEED_MIN = 0.02;
const DUST_SPEED_VAR = 0.06;
const DUST_LIFE_S = 1.0;
const DUST_LIFE_VAR_S = 0.7;
const SHARD_HOT = 0xffc070;
const SHARD_COLD = 0x3a2a22;

interface Particle {
  gfx: Graphics;
  x: number; y: number; vx: number; vy: number;
  spin: number; size: number; grow: number;
  life: number; life0: number;
  /** 0 dust, 1 shard, 2 flash. */
  kind: number;
}

function lerpColor(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

export class WreckBreakFx {
  private readonly layer = new Container();
  private readonly pool: Particle[] = [];
  private built = false;
  private live = 0;
  private seed = 0x9e3779b9;

  constructor(
    private readonly world: Container,
    private readonly getQuality: () => EffectQuality,
    private readonly particlesDisabled = false,
  ) {
    this.layer.label = 'wreckBreakFx';
  }

  /** A deterministic-enough 0..1 stream (no Math.random in tests' way). */
  private rnd(): number {
    this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return this.seed / 4294967296;
  }

  private build(): void {
    this.built = true;
    const mk = (kind: number): Particle => {
      const g = new Graphics();
      if (kind === 0) g.circle(0, 0, 1).fill({ color: 0xffffff, alpha: 1 });
      else if (kind === 1) g.poly([0, -1.6, 0.7, 1, -0.7, 1]).fill({ color: 0xffffff });
      else {
        g.circle(0, 0, 1.6).fill({ color: 0xffffff, alpha: 0.3 });
        g.circle(0, 0, 1).fill({ color: 0xffffff, alpha: 1 });
      }
      g.visible = false;
      this.layer.addChild(g);
      return { gfx: g, x: 0, y: 0, vx: 0, vy: 0, spin: 0, size: 1, grow: 0, life: 0, life0: 1, kind };
    };
    for (let i = 0; i < MAX_DUST; i++) this.pool.push(mk(0));
    for (let i = 0; i < MAX_SHARDS; i++) this.pool.push(mk(1));
    for (let i = 0; i < MAX_FLASHES; i++) this.pool.push(mk(2));
  }

  /** The oldest free (else oldest live) particle of a kind. */
  private take(kind: number): Particle | null {
    let best: Particle | null = null;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (p.kind !== kind) continue;
      if (p.life <= 0) return p;
      if (best === null || p.life < best.life) best = p;
    }
    return best;
  }

  /** Game-space kill point (Y up); `opts.radius` = the wreck's radius. */
  spawnBurst(worldX: number, worldY: number, opts?: ParticleBurstOpts): void {
    if (!this.built) this.build();
    if (this.layer.parent === null) this.world.addChild(this.layer);
    const R = Math.max(20, opts?.radius ?? 200);
    const px = worldX, py = -worldY; // Pixi space
    // The flash: always, even with particles off.
    const f = this.take(2);
    if (f !== null) this.arm(f, px, py, 0, 0, 0, R * FLASH_R0, R * FLASH_R1 * (opts?.flashScale ?? 1), FLASH_LIFE_S);
    if (!this.particlesDisabled) {
      const dial = WRECK_BREAK_DIAL[this.getQuality()];
      for (let i = 0; i < dial.dust; i++) {
        const p = this.take(0);
        if (p === null) break;
        const a = this.rnd() * Math.PI * 2, sp = R * (DUST_SPEED_MIN + this.rnd() * DUST_SPEED_VAR);
        const j = R * 0.02 * this.rnd();
        this.arm(p, px + Math.cos(a) * j, py + Math.sin(a) * j, Math.cos(a) * sp, Math.sin(a) * sp, 0,
          R * (0.006 + this.rnd() * 0.012), R * DUST_GROW, DUST_LIFE_S + this.rnd() * DUST_LIFE_VAR_S);
      }
      for (let i = 0; i < dial.shards; i++) {
        const p = this.take(1);
        if (p === null) break;
        const a = this.rnd() * Math.PI * 2, sp = R * (0.25 + this.rnd() * 0.9);
        this.arm(p, px, py, Math.cos(a) * sp, Math.sin(a) * sp, (this.rnd() - 0.5) * 12,
          R * (0.008 + this.rnd() * 0.018), 0, 1.4 + this.rnd() * 1.6);
        p.gfx.rotation = a;
      }
    }
  }

  private arm(p: Particle, x: number, y: number, vx: number, vy: number, spin: number, size: number, grow: number, life: number): void {
    if (p.life <= 0) this.live++;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.spin = spin; p.size = size; p.grow = grow;
    p.life = life; p.life0 = life;
    p.gfx.visible = true;
    p.gfx.position.set(x, y);
    p.gfx.scale.set(size);
  }

  /** Per frame (alloc-free). */
  tick(dtSec: number): void {
    if (this.live === 0) return;
    const drag = Math.exp(-0.9 * dtSec);
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (p.life <= 0) continue;
      p.life -= dtSec;
      if (p.life <= 0) {
        p.gfx.visible = false;
        this.live--;
        continue;
      }
      const u = 1 - p.life / p.life0; // 0 → 1 over life
      const g = p.gfx;
      if (p.kind === 2) {
        // Flash: swell fast, fade out (ease-out).
        const e = 1 - (1 - u) * (1 - u);
        g.scale.set(p.size + (p.grow - p.size) * e);
        g.alpha = 1 - e;
        continue;
      }
      p.vx *= drag; p.vy *= drag;
      p.x += p.vx * dtSec; p.y += p.vy * dtSec;
      g.position.set(p.x, p.y);
      if (p.kind === 0) {
        g.scale.set(p.size + p.grow * u);
        g.alpha = DUST_ALPHA * (1 - u);
        g.tint = DUST_TINT;
      } else {
        g.rotation += p.spin * dtSec;
        g.tint = lerpColor(SHARD_HOT, SHARD_COLD, Math.min(1, u * 1.5));
        g.alpha = u < 0.7 ? 1 : (1 - u) / 0.3;
      }
    }
    if (this.live === 0) this.world.removeChild(this.layer);
  }

  activeCount(): number { return this.live; }

  resetForSectorHandoff(): void {
    for (const p of this.pool) { p.life = 0; p.gfx.visible = false; }
    this.live = 0;
    if (this.layer.parent !== null) this.layer.parent.removeChild(this.layer);
  }
}
