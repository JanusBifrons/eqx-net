/**
 * Sprite-pool beam renderer — first-class replacement for the Graphics
 * `clear() + moveTo + lineTo + stroke` cycle used to draw laser/hitscan
 * beams (live + remote).
 *
 * Why a pool instead of Graphics:
 *
 *   - Pixi's `Graphics.stroke()` triggers a full path triangulation
 *     pass on every dirty redraw. Under 35-drone hostile combat the
 *     beam endpoints trip the dirty threshold every frame, so the
 *     room was burning N triangulation passes per RAF (was 2N pre-
 *     simplification: one stroke for glow + one for core × N beams).
 *
 *   - Sprites with a SHARED texture batch into a single GPU drawcall.
 *     Updating sprite transforms (position/rotation/scale) is O(1)
 *     and doesn't touch the geometry buffer.
 *
 * Layout: each beam is one Sprite anchored at (0, 0.5) with its
 * texture stretched along the local +X axis. `scale.x = beam length`
 * gives the world-space length; `rotation = atan2(dy, dx)` aligns the
 * sprite to the beam direction; `position = from` puts the
 * anchor-origin at the beam's source point.
 *
 * Pool: sprites added to the container are reused across frames.
 * Unused slots in the pool are hidden (`visible = false`) rather than
 * destroyed — pool size grows to peak-beam-count then plateaus.
 *
 * Filter attach point: the `container` field is the `DisplayObject`
 * subsystems like `LaserGlow` attach filters to. Filters work on
 * Container exactly the same as on Graphics.
 */
import { Container, Sprite, Texture } from 'pixi.js';

export interface BeamView {
  /** World-space `from` point — anchor of the sprite. */
  fromX: number;
  fromY: number;
  /** World-space `to` point — sprite extends to here. */
  toX: number;
  toY: number;
}

export interface BeamSpriteStyle {
  /** 0xRRGGBB tint applied to the white texture. */
  tint: number;
  /** Stroke width in world units (sprite Y-scale). */
  width: number;
  /** Sprite alpha. */
  alpha: number;
}

export class BeamSpritePool {
  readonly container: Container;
  private readonly _texture: Texture;
  private readonly _pool: Sprite[] = [];
  private readonly _style: BeamSpriteStyle;
  /** Number of sprites currently representing live beams (visible). */
  private _liveCount = 0;

  constructor(style: BeamSpriteStyle) {
    this._style = { ...style };
    // Use the WHITE singleton texture — every BeamSpritePool shares
    // it, so the renderer can batch all beams across pools into a
    // single drawcall when they sit under the same parent container.
    this._texture = Texture.WHITE;
    this.container = new Container();
    this.container.label = 'BeamSpritePool';
  }

  /**
   * Sync the pool to render exactly `count` beams. Reads from
   * `beams[0..count-1]`. Sprites beyond `count` are hidden but kept
   * in the pool for later frames (no destroy churn).
   *
   * Caller is responsible for the "did anything actually change?"
   * dirty-flag gate above this call site — if no beam moved, the
   * pool still gets re-set to the same values, which is cheap
   * (transform writes, no geometry rebuild).
   */
  setBeams(beams: readonly BeamView[], count: number): void {
    for (let i = 0; i < count; i++) {
      const b = beams[i]!;
      let sprite = this._pool[i];
      if (!sprite) {
        sprite = new Sprite(this._texture);
        // Anchor at (0, 0.5) → sprite's local origin is at the FROM
        // end and its Y-center is on the beam's line. scale.x stretches
        // along the beam direction; scale.y becomes the stroke width.
        sprite.anchor.set(0, 0.5);
        sprite.tint = this._style.tint;
        sprite.alpha = this._style.alpha;
        this._pool[i] = sprite;
        this.container.addChild(sprite);
      }
      sprite.visible = true;
      // World-space line: from (b.fromX, b.fromY) to (b.toX, b.toY).
      // Pixi screen Y is flipped vs game-space Y per the project's
      // pixiY = -gameY convention (see src/client/CLAUDE.md), so we
      // mirror that here.
      const dx = b.toX - b.fromX;
      const dy = -(b.toY - b.fromY); // flip Y for Pixi
      const len = Math.hypot(dx, dy);
      sprite.x = b.fromX;
      sprite.y = -b.fromY;
      sprite.rotation = Math.atan2(dy, dx);
      sprite.scale.set(len, this._style.width);
    }
    // Hide stale sprites left over from a higher-count frame.
    for (let i = count; i < this._pool.length; i++) {
      const s = this._pool[i];
      if (s && s.visible) s.visible = false;
    }
    this._liveCount = count;
  }

  /** Hide all beams (e.g. when the lasers slice becomes empty). */
  hideAll(): void {
    for (let i = 0; i < this._pool.length; i++) {
      const s = this._pool[i];
      if (s && s.visible) s.visible = false;
    }
    this._liveCount = 0;
  }

  /** Test-only: number of beams currently visible. */
  get liveCount(): number {
    return this._liveCount;
  }

  /** Test-only: total pool size (visible + hidden). */
  get poolSize(): number {
    return this._pool.length;
  }
}
