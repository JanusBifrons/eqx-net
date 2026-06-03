import { Container, Text, TextStyle } from 'pixi.js';
import type { Camera } from './worker/Camera';

/** Max concurrent accumulator buckets (one per target taking damage). */
export const POOL_CAP = 20;

/**
 * Frames the accumulator stays "open" — every new hit on the same target
 * resets this back to STAY_FRAMES, so a sustained beam keeps the number
 * growing instead of spawning a new instance. 60 frames ≈ 1 s @ 60 Hz.
 */
export const STAY_FRAMES = 60;

/**
 * Frames the number takes to fade once the stay window expires. Total
 * lifetime under a single-hit scenario is STAY_FRAMES + FADE_FRAMES
 * (~1.5 s @ 60 Hz). Drives off STAY/FADE so timing tuning stays in one
 * place. The constant is exported so the regression-lock test follows
 * future tuning rather than hard-coding a value.
 */
export const FADE_FRAMES = 30;

/** Backwards-compat alias for tests that referenced the old constant. */
export const LIFETIME_FRAMES = STAY_FRAMES + FADE_FRAMES;

/**
 * Per-frame easing (0..1) the rendered position uses to GLIDE toward the
 * latest hit coord instead of snapping. 0.2 ≈ reaches the target in ~10
 * frames — smooth but keeps up with a moving target under sustained fire.
 * (2026-06-03 smoothness tweak.)
 */
const POSITION_GLIDE = 0.2;

/**
 * Upward float speed (× invScale, world u/frame) applied ONLY during the
 * fade-out so the number lifts off as it disappears. While damage is
 * still landing the number holds steady on the target.
 */
const FADE_RISE_RATE = 1.0;

/**
 * Base font size for the first hit. The displayed text counter-scales
 * 1/camera.scale so it reads constant-size on screen at any zoom AND
 * multiplies a `fontScaleForTotal(total)` factor so the number grows
 * as the running total grows. The growth is log-shaped so a 10 → 100
 * accumulated damage roughly doubles the visual size, but 100 → 1000
 * only adds another 50 %.
 */
const BASE_FONT_SCALE = 1.0;
const MAX_FONT_SCALE = 2.8;

/**
 * `fontScaleForTotal(total)` — pure, exported for tests. 1.0 at total
 * ≤ baseDamage, capped at MAX_FONT_SCALE. Logarithmic so big numbers
 * don't blow up the screen.
 */
export function fontScaleForTotal(total: number): number {
  if (total <= 0) return BASE_FONT_SCALE;
  // 1 at total=0, ~1.32 at 50, ~1.6 at 100, ~2.2 at 500, capped at 2.8.
  const grown = BASE_FONT_SCALE + Math.log10(1 + total / 25) * 0.6;
  return grown > MAX_FONT_SCALE ? MAX_FONT_SCALE : grown;
}

// Colour ramp (2026-06-03 visual tweak). No leading "-" sign — the
// floating number reads as raw magnitude. Damage starts light red and
// deepens toward saturated red as the running total grows; healing
// (`heal: true` — not yet emitted by gameplay, wired ahead) starts light
// green and deepens. White outline gives contrast over any background.
const DMG_LIGHT = 0xff8c8c; // light red — small hit
const DMG_DEEP = 0xff0000; // saturated red — big hit
const HEAL_LIGHT = 0x9cff9c; // light green — small heal
const HEAL_DEEP = 0x00c400; // saturated green — big heal

/** Channel-wise lerp between two 0xRRGGBB ints. `t` clamped to [0,1]. */
function lerpColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/**
 * `colorForTotal(total, heal)` — pure, exported for tests. Maps the
 * accumulated magnitude to a fill colour: light→deep red for damage,
 * light→deep green for heal. Uses the same log curve shape as
 * `fontScaleForTotal` so size and colour intensify together; saturates
 * (full deep colour) around a total of ~400.
 */
export function colorForTotal(total: number, heal = false): number {
  const t = Math.min(1, Math.log10(1 + Math.max(0, total) / 25) * 0.85);
  return heal ? lerpColor(HEAL_LIGHT, HEAL_DEEP, t) : lerpColor(DMG_LIGHT, DMG_DEEP, t);
}

interface DamageNumberEntry {
  text: Text;
  targetId: string;
  total: number;
  /** True for a healing number (green ramp) vs damage (red ramp). */
  heal: boolean;
  stayLeft: number;
  fadeLeft: number;
  /**
   * Smooth-motion state (2026-06-03). `targetX/targetY` is the latest
   * hit world-coord (Y-flipped); `curX/curY` is the actually-rendered
   * position that GLIDES toward the target each frame instead of
   * snapping (snapping per hit was the "jolts around / resets position"
   * bug). `riseY` is the extra upward float applied ONLY during the
   * fade-out so the number sits steady on the target while damage is
   * landing, then drifts off as it fades.
   */
  targetX: number;
  targetY: number;
  curX: number;
  curY: number;
  riseY: number;
  /**
   * Per-tag predicted contributions, lazily allocated only when at
   * least one tagged add() happens against this bucket. Auth-only
   * buckets (the dominant case) never allocate this map. Lets
   * `cancelByTag` subtract precisely on rollback so the visible total
   * matches the post-rollback truth.
   */
  pendingByTag?: Map<string, number>;
}

/** Fresh per-Text style. Each Text owns its style so its `fill` can be
 *  set independently (the colour ramp is per-bucket). White outline +
 *  subtle dark drop-shadow for legibility over bright FX. */
function makeNumberStyle(): TextStyle {
  return new TextStyle({
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: 'bold',
    fill: DMG_LIGHT,
    // Two-layer outline (2026-06-03): a crisp BLACK stroke hugging the
    // glyph, then a WHITE halo just outside it via a zero-distance white
    // drop-shadow. Reads as "red number → black border → white border"
    // without the cost of stacking a second Text per bucket. (Pixi v8
    // TextStyle supports only one `stroke`, so the outer ring is the
    // shadow.)
    stroke: { color: '#000000', width: 4 },
    dropShadow: { color: '#ffffff', alpha: 1, blur: 3, distance: 0, angle: 0 },
  });
}

/**
 * Floating damage-number manager — accumulator model (plan:
 * melodic-engelbart Step 4, 2026-05-30).
 *
 * One bucket per targetId at any time. Each incoming hit either
 * - reuses the existing bucket → adds to its total, resets its stay
 *   window, re-anchors at the new hit world-coord (so the number
 *   tracks the action), and grows the font scale; OR
 * - creates a fresh bucket if no entry exists for that targetId.
 *
 * After STAY_FRAMES with no new hits, the bucket enters its fade
 * window (FADE_FRAMES). When the fade completes, the bucket is
 * destroyed.
 *
 * Why this shape: pre-accumulator the manager `new Text(...)`'d per
 * hit, capped at POOL_CAP=20 with FIFO eviction. Under sustained beam
 * fire (~30 Hz spawn) it created + destroyed Text geometries each
 * second; aggregating into ~1 bucket per active target reduces the
 * Text-construction churn by an order of magnitude. The imperative-
 * taco hostile CDP profile (2026-05-30) flagged the spawn path as a
 * top non-FX allocator after the FX hypothesis was falsified.
 *
 * Counter-scale: numbers are world-container children so they pan
 * with the camera at the hit anchor, but `1/camera.scale` is applied
 * per frame so visual size is constant regardless of zoom. The
 * accumulated-damage size factor multiplies on top of that.
 */
/**
 * Free-list cap. A bucket destruction returns its Text to this list
 * instead of calling `text.destroy()`; a fresh bucket pops from this
 * list instead of `new Text(...)`. Sized to POOL_CAP * 2 so the worst-
 * case bucket-churn workload (rollback storm — 5000 predict-then-
 * cancel cycles) reuses Text instances rather than thrashing Pixi's
 * geometry allocator. Above the cap, excess Texts are actually
 * destroyed (defensive — keeps memory bounded if the workload
 * pathologically dwarfs POOL_CAP).
 */
const FREE_POOL_CAP = POOL_CAP * 2;

export class DamageNumberManager {
  private readonly container: Container;
  private readonly camera: Camera;
  private readonly byTarget = new Map<string, DamageNumberEntry>();
  /**
   * Free list of Text instances available for reuse. Bucket destruction
   * pushes; bucket creation pops. Sprites stay in the same Pixi
   * geometry buffers (which the v8 allocator caches) across the
   * push/pop cycle — no `new Text()` call, no `destroy()` call.
   */
  private readonly freeTexts: Text[] = [];

  constructor(worldParent: Container, camera: Camera) {
    this.container = new Container();
    worldParent.addChild(this.container);
    this.camera = camera;
  }

  /** Set the visible text (rounded magnitude, no sign) + ramp colour. */
  private applyDisplay(entry: DamageNumberEntry): void {
    entry.text.text = `${Math.round(entry.total)}`;
    entry.text.style.fill = colorForTotal(entry.total, entry.heal);
  }

  /**
   * Apply a damage (or, with `heal`, healing) hit. If a bucket for
   * `targetId` already exists, accumulate; otherwise spawn a fresh
   * bucket (evicting the oldest if at cap). `tag` (a `clientShotId`) is
   * recorded per-contribution so a later `cancelByTag` can subtract
   * precisely. A bucket's heal/damage flavour is set on first creation.
   */
  spawn(targetId: string, x: number, y: number, damage: number, tag?: string, heal = false): void {
    if (damage <= 0) return;
    let entry = this.byTarget.get(targetId);
    if (entry) {
      entry.total += damage;
      entry.stayLeft = STAY_FRAMES;
      entry.fadeLeft = FADE_FRAMES;
      entry.text.alpha = 1;
      // Don't SNAP to the new hit coord — that was the jolt. Update the
      // glide target and reset any fade-rise so the number eases back
      // onto the target while fresh damage lands.
      entry.targetX = x;
      entry.targetY = -y;
      entry.riseY = 0;
      this.applyDisplay(entry);
      if (tag !== undefined) {
        if (!entry.pendingByTag) entry.pendingByTag = new Map();
        entry.pendingByTag.set(tag, (entry.pendingByTag.get(tag) ?? 0) + damage);
      }
      return;
    }

    if (this.byTarget.size >= POOL_CAP) {
      this.evictOldest();
    }

    // Reuse a pooled Text if available, else allocate. Either way the
    // text content + transform are mutated to this bucket's state — the
    // Pixi v8 vertex/texture buffers are kept hot across cycles.
    const text = this.acquireText();
    text.x = x;
    text.y = -y;
    text.alpha = 1;
    this.container.addChild(text);
    const fresh: DamageNumberEntry = {
      text,
      targetId,
      total: damage,
      heal,
      stayLeft: STAY_FRAMES,
      fadeLeft: FADE_FRAMES,
      // Fresh number appears AT the hit (cur == target), no glide-in from
      // a stale position. text.x/y set above so it's visible pre-update.
      targetX: x,
      targetY: -y,
      curX: x,
      curY: -y,
      riseY: 0,
    };
    this.applyDisplay(fresh);
    if (tag !== undefined) {
      fresh.pendingByTag = new Map();
      fresh.pendingByTag.set(tag, damage);
    }
    this.byTarget.set(targetId, fresh);
  }

  /**
   * Hard-cancel the predicted contribution of `tag` to every bucket
   * (a `clientShotId`; a multi-mount salvo shares one). Subtracts the
   * recorded contribution from each affected bucket's total. If a
   * bucket drops to zero or below, it is destroyed. Returns the count
   * of buckets touched (NOT the total damage removed) for parity with
   * the pre-accumulator API.
   */
  cancelByTag(tag: string): number {
    let removed = 0;
    for (const [id, entry] of this.byTarget) {
      if (!entry.pendingByTag) continue;
      const contribution = entry.pendingByTag.get(tag);
      if (contribution === undefined) continue;
      entry.total -= contribution;
      entry.pendingByTag.delete(tag);
      removed++;
      if (entry.total <= 0) {
        this.destroyEntry(id, entry);
      } else {
        this.applyDisplay(entry);
      }
    }
    return removed;
  }

  /**
   * Tick every active bucket: glide toward the latest hit coord (no
   * snap), float up only while fading, counter-scale + total-scale,
   * advance the stay/fade countdown, destroy on expiry.
   */
  update(): void {
    const invScale = this.camera.scale.x > 0 ? 1 / this.camera.scale.x : 1;
    for (const [id, entry] of this.byTarget) {
      // Smoothly glide the rendered position toward the latest hit
      // anchor. GLIDE is a per-frame easing factor — small enough to
      // read as motion, large enough to keep up with a moving target
      // under sustained fire. Removes the per-hit position snap.
      entry.curX += (entry.targetX - entry.curX) * POSITION_GLIDE;
      entry.curY += (entry.targetY - entry.curY) * POSITION_GLIDE;

      const visualScale = invScale * fontScaleForTotal(entry.total);
      entry.text.scale.set(visualScale);

      if (entry.stayLeft > 0) {
        entry.stayLeft--;
        entry.text.alpha = 1;
        // Hold steady on the target while damage is landing — ease any
        // residual fade-rise back to zero so a renewed combo re-seats
        // the number on the target rather than leaving it drifted up.
        entry.riseY += (0 - entry.riseY) * POSITION_GLIDE;
      } else if (entry.fadeLeft > 0) {
        entry.fadeLeft--;
        entry.text.alpha = entry.fadeLeft / FADE_FRAMES;
        // Now drift up as it fades out (the classic float-off).
        entry.riseY -= invScale * FADE_RISE_RATE;
      }

      entry.text.x = entry.curX;
      entry.text.y = entry.curY + entry.riseY;

      if (entry.stayLeft === 0 && entry.fadeLeft === 0) {
        this.destroyEntry(id, entry);
      }
    }
  }

  /**
   * Number of active buckets — surface for tests + the renderer
   * feedback channel. Drives `RendererFeedback.damageNumberActiveCount`
   * each frame so integration tests can observe spawn/accumulate/
   * expire without rendering.
   */
  getActiveCount(): number {
    return this.byTarget.size;
  }

  destroy(): void {
    for (const [, entry] of this.byTarget) {
      // Pixi v8 Text owns its own glyph atlas (Texture + TextureSource
      // + WebGLTexture chain). `.destroy()` without
      // `{ texture: true, textureSource: true }` leaks the GPU
      // resources. Heap diff 2026-05-31 confirmed.
      entry.text.destroy({ texture: true, textureSource: true });
    }
    this.byTarget.clear();
    // Free-list Texts are children of `this.container`; the
    // `destroy({ children: true, texture: true, textureSource: true })`
    // call below cascades full disposal to them.
    this.freeTexts.length = 0;
    this.container.destroy({ children: true, texture: true, textureSource: true });
  }

  /**
   * Recycle a bucket's Text instead of destroying it. The Text comes
   * off the container's child list but stays alive — its Pixi v8
   * vertex/texture buffers persist for the next acquireText() call.
   */
  private destroyEntry(id: string, entry: DamageNumberEntry): void {
    this.container.removeChild(entry.text);
    this.releaseText(entry.text);
    this.byTarget.delete(id);
  }

  /** 2026-05-31 diagnostic: count fresh allocs vs pool reuses. Exposed
   *  via window for the active-combat-heap-diff probe to inspect. */
  static debugCounters = { acquireFresh: 0, acquireFromPool: 0, releaseToPool: 0, releaseDestroy: 0 };
  static {
    if (typeof window !== 'undefined') {
      (window as unknown as { __damageNumberDebug?: typeof DamageNumberManager.debugCounters })
        .__damageNumberDebug = DamageNumberManager.debugCounters;
    }
  }

  private acquireText(): Text {
    const recycled = this.freeTexts.pop();
    if (recycled) {
      DamageNumberManager.debugCounters.acquireFromPool++;
      // Reset transform fields the previous bucket may have mutated.
      // text + fill are set by applyDisplay() right after acquire;
      // scale.set + alpha are re-applied each `update()`, but reset
      // here so a spawn-then-zero-ticks bucket renders correctly.
      recycled.scale.set(1, 1);
      return recycled;
    }
    DamageNumberManager.debugCounters.acquireFresh++;
    const fresh = new Text({ text: '', style: makeNumberStyle() });
    fresh.anchor.set(0.5, 0.5);
    return fresh;
  }

  private releaseText(text: Text): void {
    if (this.freeTexts.length >= FREE_POOL_CAP) {
      DamageNumberManager.debugCounters.releaseDestroy++;
      // Overflow — defensive bound. Above POOL_CAP × 2 reusable Texts
      // there's no real-world workload that would consume them; drop
      // the excess so memory stays bounded.
      //
      // Full GPU-resource disposal: Pixi v8 Text owns its own glyph
      // atlas (Texture + TextureSource + WebGLTexture). `.destroy()`
      // without `{ texture: true, textureSource: true }` leaks them.
      // Heap diff 2026-05-31 showed +84 untracked Texture chains over
      // 60 s of combat.
      text.destroy({ texture: true, textureSource: true });
      return;
    }
    DamageNumberManager.debugCounters.releaseToPool++;
    this.freeTexts.push(text);
  }

  /**
   * Pool-cap overflow: evict the bucket with the least life remaining
   * (closest to natural expiry). Sustained-fire steady-state stays at
   * a stable count; the eviction path only fires on a burst of new
   * targets above POOL_CAP simultaneously.
   */
  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestLife = Infinity;
    for (const [id, entry] of this.byTarget) {
      const life = entry.stayLeft + entry.fadeLeft;
      if (life < oldestLife) {
        oldestLife = life;
        oldestId = id;
      }
    }
    if (oldestId !== null) {
      const old = this.byTarget.get(oldestId)!;
      this.destroyEntry(oldestId, old);
    }
  }
}
