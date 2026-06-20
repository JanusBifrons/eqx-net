import { Container, Text, TextStyle } from 'pixi.js';
import type { Camera } from './worker/Camera';

/**
 * Pooled screenspace LEVEL-UP icon manager (Phase 4 WS-B1, plan:
 * effervescent-umbrella).
 *
 * On a `ship_level_up` for the local player the renderer pops a transient
 * "LEVEL N" icon over the ship that floats up and fades. Built on the SAME
 * pooling discipline as `DamageNumberManager` (invariant #14 — no per-frame
 * allocation): a free-list of `Text` instances; a fixed-lifetime float-up-and-
 * fade; recycle-not-destroy on expiry (the Pixi v8 vertex/texture buffers stay
 * hot across the push/pop cycle). One icon per trigger (no accumulation —
 * unlike damage numbers, a level-up is a singular discrete event).
 *
 * Counter-scaled by `1/camera.scale` each frame so the icon reads constant-size
 * on screen at any zoom (same trick as DamageNumbers). World-container child so
 * it pans with the camera at the ship anchor.
 */

/** Frames the icon lives before it's recycled. ~75 frames ≈ 1.25 s @ 60 Hz. */
export const ICON_LIFETIME_FRAMES = 75;

/** Frames over which the icon fades out (the tail of its lifetime). */
const FADE_FRAMES = 30;

/** Upward float speed (× invScale, world u/frame). Game space is Y-up; the
 *  Pixi world container is Y-down (`pixiY = -gameY`), so rising on screen means
 *  the Pixi sprite y DECREASES — we subtract. */
const RISE_RATE = 0.8;

/** Free-list cap — generous; level-ups are rare so this never overflows. */
const FREE_POOL_CAP = 16;

interface IconEntry {
  text: Text;
  framesLeft: number;
  /** Pixi-space anchor (already Y-flipped at spawn). */
  baseX: number;
  baseY: number;
  /** Accumulated upward float offset (Pixi-space, negative = up). */
  riseY: number;
}

function makeIconStyle(): TextStyle {
  return new TextStyle({
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: 'bold',
    fill: '#ffc400', // amber — matches the LevelBadge
    stroke: { color: '#000000', width: 4 },
    dropShadow: { color: '#ffffff', alpha: 1, blur: 3, distance: 0, angle: 0 },
  });
}

export class LevelUpIconManager {
  private readonly container: Container;
  private readonly camera: Camera;
  private readonly active: IconEntry[] = [];
  private readonly freeTexts: Text[] = [];

  /** Pool diagnostics (mirrors DamageNumberManager). */
  static debugCounters = { acquireFresh: 0, acquireFromPool: 0, releaseToPool: 0, releaseDestroy: 0 };

  constructor(worldParent: Container, camera: Camera) {
    this.container = new Container();
    worldParent.addChild(this.container);
    this.camera = camera;
  }

  /**
   * Spawn a level-up icon at the GAME-space ship position. `x`/`y` are game
   * space (Y-up); the manager Y-flips to Pixi space internally.
   */
  spawn(gameX: number, gameY: number, newLevel: number): void {
    const text = this.acquireText();
    text.text = `LEVEL ${newLevel}`;
    const px = gameX;
    const py = -gameY; // game Y-up → Pixi Y-down
    text.x = px;
    text.y = py;
    text.alpha = 1;
    this.container.addChild(text);
    this.active.push({ text, framesLeft: ICON_LIFETIME_FRAMES, baseX: px, baseY: py, riseY: 0 });
  }

  /** Advance every active icon one frame: rise + fade + expiry. */
  update(): void {
    const invScale = this.camera.scale.x > 0 ? 1 / this.camera.scale.x : 1;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i]!;
      e.framesLeft--;
      e.riseY -= invScale * RISE_RATE;
      e.text.scale.set(invScale);
      e.text.x = e.baseX;
      e.text.y = e.baseY + e.riseY;
      if (e.framesLeft <= FADE_FRAMES) {
        e.text.alpha = Math.max(0, e.framesLeft / FADE_FRAMES);
      }
      if (e.framesLeft <= 0) {
        this.container.removeChild(e.text);
        this.releaseText(e.text);
        // Swap-remove (order doesn't matter for transient icons).
        this.active[i] = this.active[this.active.length - 1]!;
        this.active.pop();
      }
    }
  }

  getActiveCount(): number {
    return this.active.length;
  }

  destroy(): void {
    for (const e of this.active) {
      e.text.destroy({ texture: true, textureSource: true });
    }
    this.active.length = 0;
    this.freeTexts.length = 0;
    this.container.destroy({ children: true, texture: true, textureSource: true });
  }

  private acquireText(): Text {
    const recycled = this.freeTexts.pop();
    if (recycled) {
      LevelUpIconManager.debugCounters.acquireFromPool++;
      recycled.scale.set(1, 1);
      return recycled;
    }
    LevelUpIconManager.debugCounters.acquireFresh++;
    const fresh = new Text({ text: '', style: makeIconStyle() });
    fresh.anchor.set(0.5, 0.5);
    return fresh;
  }

  private releaseText(text: Text): void {
    if (this.freeTexts.length >= FREE_POOL_CAP) {
      LevelUpIconManager.debugCounters.releaseDestroy++;
      text.destroy({ texture: true, textureSource: true });
      return;
    }
    LevelUpIconManager.debugCounters.releaseToPool++;
    this.freeTexts.push(text);
  }
}
