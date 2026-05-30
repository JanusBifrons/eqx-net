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

interface DamageNumberEntry {
  text: Text;
  targetId: string;
  total: number;
  stayLeft: number;
  fadeLeft: number;
  /**
   * Per-tag predicted contributions, lazily allocated only when at
   * least one tagged add() happens against this bucket. Auth-only
   * buckets (the dominant case) never allocate this map. Lets
   * `cancelByTag` subtract precisely on rollback so the visible total
   * matches the post-rollback truth.
   */
  pendingByTag?: Map<string, number>;
}

const STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 14,
  fontWeight: 'bold',
  fill: '#ffffff',
  dropShadow: {
    color: '#ff0000',
    blur: 2,
    distance: 1,
    angle: Math.PI / 2,
  },
});

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

  /**
   * Apply a damage hit. If a bucket for `targetId` already exists,
   * accumulate; otherwise spawn a fresh bucket (evicting the oldest
   * if at cap). `tag` (a `clientShotId`) is recorded per-contribution
   * so a later `cancelByTag` can subtract precisely.
   */
  spawn(targetId: string, x: number, y: number, damage: number, tag?: string): void {
    if (damage <= 0) return;
    let entry = this.byTarget.get(targetId);
    if (entry) {
      entry.total += damage;
      entry.stayLeft = STAY_FRAMES;
      entry.fadeLeft = FADE_FRAMES;
      entry.text.alpha = 1;
      entry.text.x = x;
      entry.text.y = -y;
      entry.text.text = `-${entry.total}`;
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
    const text = this.acquireText(`-${damage}`);
    text.x = x;
    text.y = -y;
    text.alpha = 1;
    this.container.addChild(text);
    const fresh: DamageNumberEntry = {
      text,
      targetId,
      total: damage,
      stayLeft: STAY_FRAMES,
      fadeLeft: FADE_FRAMES,
    };
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
        entry.text.text = `-${entry.total}`;
      }
    }
    return removed;
  }

  /**
   * Tick every active bucket: drift upward, counter-scale + total-
   * scale, advance the stay/fade countdown, destroy on expiry.
   */
  update(): void {
    const invScale = this.camera.scale.x > 0 ? 1 / this.camera.scale.x : 1;
    for (const [id, entry] of this.byTarget) {
      entry.text.y -= invScale;
      const visualScale = invScale * fontScaleForTotal(entry.total);
      entry.text.scale.set(visualScale);

      if (entry.stayLeft > 0) {
        entry.stayLeft--;
        entry.text.alpha = 1;
      } else if (entry.fadeLeft > 0) {
        entry.fadeLeft--;
        entry.text.alpha = entry.fadeLeft / FADE_FRAMES;
      }
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
      entry.text.destroy();
    }
    this.byTarget.clear();
    // The free-list's Texts are children of `this.container`, which
    // `destroy({ children: true })` walks + destroys recursively. Free
    // list itself doesn't need explicit clearing.
    this.freeTexts.length = 0;
    this.container.destroy({ children: true });
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

  private acquireText(initialText: string): Text {
    const recycled = this.freeTexts.pop();
    if (recycled) {
      recycled.text = initialText;
      // Reset transform fields the previous bucket may have mutated.
      // scale.set + alpha are re-applied each `update()`, but reset
      // here so a spawn-then-zero-ticks bucket renders correctly.
      recycled.scale.set(1, 1);
      return recycled;
    }
    const fresh = new Text({ text: initialText, style: STYLE });
    fresh.anchor.set(0.5, 0.5);
    return fresh;
  }

  private releaseText(text: Text): void {
    if (this.freeTexts.length >= FREE_POOL_CAP) {
      // Overflow — defensive bound. Above POOL_CAP × 2 reusable Texts
      // there's no real-world workload that would consume them; drop
      // the excess so memory stays bounded.
      text.destroy();
      return;
    }
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
