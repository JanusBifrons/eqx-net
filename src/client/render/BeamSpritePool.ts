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
  /**
   * P1a — full-strength SOLID length in world units (measured from `from`). The
   * segment `[from, from+solidLen]` is drawn solid; the remainder
   * `[from+solidLen, to]` fades to nothing (the optimal-range + falloff taper).
   * Only honoured by a `taper` pool. Absent / ≥ the total length ⇒ the whole beam
   * is solid (the legacy single-sprite gradient look for remote beams).
   */
  solidLen?: number;
}

export interface BeamSpriteStyle {
  /** 0xRRGGBB tint applied to the white texture. */
  tint: number;
  /** Stroke width in world units (sprite Y-scale). */
  width: number;
  /** Sprite alpha. */
  alpha: number;
  /** P3.13 — when true, the beam uses a horizontal GRADIENT texture that fades
   *  from opaque at the base to transparent at the tip, so a combat beam tapers
   *  off toward the end of its range (the beam is drawn to the weapon's max
   *  range; the tip fades to nothing). Absent/false ⇒ the flat white texture
   *  (the mining DRILL beam stays a solid connection). */
  taper?: boolean;
}

/**
 * Lazily-built SHARED horizontal gradient texture (P3.13): opaque white for the
 * inner ~55 %, ramping to fully transparent at the right edge. Stretched along
 * the beam's +X by `scale.x`, it tapers the beam toward its tip. Shared across
 * all tapering pools so the beams still batch into one drawcall. Falls back to
 * the flat WHITE texture wherever a 2D canvas isn't available (headless / unit
 * tests / a renderer backend without canvas), so construction never throws.
 */
let _beamGradientTexture: Texture | null = null;
function beamGradientTexture(): Texture {
  if (_beamGradientTexture) return _beamGradientTexture;
  try {
    const W = 256;
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, 1)
        : typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width: W, height: 1 })
          : null;
    const ctx = canvas?.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
      | undefined;
    if (!canvas || !ctx) {
      _beamGradientTexture = Texture.WHITE;
      return _beamGradientTexture;
    }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.55, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 1);
    _beamGradientTexture = Texture.from(canvas as unknown as HTMLCanvasElement);
    return _beamGradientTexture;
  } catch {
    _beamGradientTexture = Texture.WHITE;
    return _beamGradientTexture;
  }
}

/**
 * Lazily-built SHARED LINEAR fade texture (P1a): fully opaque white at the LEFT
 * (base), ramping LINEARLY to transparent at the RIGHT (tip). Stretched along a
 * beam's falloff TAIL (`[from+solidLen, to]`) it fades the beam from full at the
 * optimal range to nothing at max range, so the solid core (a separate
 * `Texture.WHITE` sprite) joins it seamlessly. Falls back to `Texture.WHITE`
 * where no 2D canvas exists (headless / unit tests), so construction never throws.
 */
let _beamFadeTailTexture: Texture | null = null;
function beamFadeTailTexture(): Texture {
  if (_beamFadeTailTexture) return _beamFadeTailTexture;
  try {
    const W = 256;
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, 1)
        : typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width: W, height: 1 })
          : null;
    const ctx = canvas?.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
      | undefined;
    if (!canvas || !ctx) {
      _beamFadeTailTexture = Texture.WHITE;
      return _beamFadeTailTexture;
    }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 1);
    _beamFadeTailTexture = Texture.from(canvas as unknown as HTMLCanvasElement);
    return _beamFadeTailTexture;
  } catch {
    _beamFadeTailTexture = Texture.WHITE;
    return _beamFadeTailTexture;
  }
}

export class BeamSpritePool {
  readonly container: Container;
  private readonly _texture: Texture;
  /** Solid (full-strength) texture for the `solidLen` core segment. */
  private readonly _solidTexture: Texture;
  /** Linear fade texture for the falloff tail (taper pools only). */
  private readonly _fadeTexture: Texture | null;
  private readonly _pool: Sprite[] = [];
  /** Parallel pool of falloff-tail sprites (one per beam, taper + solidLen only). */
  private readonly _fadePool: Sprite[] = [];
  private readonly _style: BeamSpriteStyle;
  /** Number of sprites currently representing live beams (visible). */
  private _liveCount = 0;

  constructor(style: BeamSpriteStyle) {
    this._style = { ...style };
    // Combat beams (taper) use the shared gradient texture so they fade toward
    // the tip; everything else uses the WHITE singleton. Both are shared, so a
    // pool's beams still batch into a single drawcall (P3.13).
    this._texture = style.taper ? beamGradientTexture() : Texture.WHITE;
    this._solidTexture = Texture.WHITE;
    this._fadeTexture = style.taper ? beamFadeTailTexture() : null;
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
    const taper = this._fadeTexture !== null;
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
      const rot = Math.atan2(dy, dx);
      sprite.x = b.fromX;
      sprite.y = -b.fromY;
      sprite.rotation = rot;

      if (taper && b.solidLen !== undefined) {
        // P1a — explicit solid length: draw a full-strength SOLID core
        // [0, solidLen] (clips solid at any hit) plus a LINEAR fade TAIL
        // [solidLen, len] (the optimal→max falloff band, fading to nothing). This
        // replaces the single stretched-gradient sprite whose fade was anchored to
        // a FRACTION of the drawn length (so it fled the optimal range and read as
        // "goes forever / solid past the guide / never tapers").
        const solidLen = Math.max(0, Math.min(b.solidLen, len));
        sprite.texture = this._solidTexture;
        // scale.x renders `world units = scale.x × texture.width`, so the world
        // length must be DIVIDED by the texture width. The solid core uses the
        // 1×1 WHITE texture (÷1 = no-op), but the fade tail below uses the 256-px
        // gradient texture — without the division it rendered 256× too long, so
        // the "fade" stretched ~19 200 u and the beam looked solid to infinity /
        // ran off the screen (the "renders infinitely" bug; headless tests use
        // the 1×1 WHITE fallback so they never saw it). textures are 1 px tall.
        sprite.scale.set(Math.max(solidLen, 0.0001) / this._solidTexture.width, this._style.width);
        const tailLen = len - solidLen;
        let fade = this._fadePool[i];
        if (tailLen > 0.01) {
          if (!fade) {
            fade = new Sprite(this._fadeTexture!);
            fade.anchor.set(0, 0.5);
            fade.tint = this._style.tint;
            fade.alpha = this._style.alpha;
            this._fadePool[i] = fade;
            this.container.addChild(fade);
          }
          fade.visible = true;
          fade.x = b.fromX + Math.cos(rot) * solidLen;
          fade.y = -b.fromY + Math.sin(rot) * solidLen;
          fade.rotation = rot;
          // ÷ texture width (256 for the real gradient) — see the solid-core note.
          fade.scale.set(tailLen / this._fadeTexture!.width, this._style.width);
        } else if (fade) {
          fade.visible = false;
        }
      } else {
        // Legacy single-sprite path: the per-style texture (gradient if taper,
        // else WHITE) stretched to the full length. Used by remote/mining beams.
        // ÷ texture width (256 for the taper gradient) — see the solid-core note;
        // without it remote/enemy beams rendered 256× too long too.
        sprite.texture = this._texture;
        sprite.scale.set(len / this._texture.width, this._style.width);
        const fade = this._fadePool[i];
        if (fade) fade.visible = false;
      }
    }
    // Hide stale sprites left over from a higher-count frame (both pools).
    for (let i = count; i < this._pool.length; i++) {
      const s = this._pool[i];
      if (s && s.visible) s.visible = false;
      const f = this._fadePool[i];
      if (f && f.visible) f.visible = false;
    }
    this._liveCount = count;
  }

  /** Hide all beams (e.g. when the lasers slice becomes empty). */
  hideAll(): void {
    for (let i = 0; i < this._pool.length; i++) {
      const s = this._pool[i];
      if (s && s.visible) s.visible = false;
      const f = this._fadePool[i];
      if (f && f.visible) f.visible = false;
    }
    this._liveCount = 0;
  }

  /** Test-only: number of beams currently visible. */
  get liveCount(): number {
    return this._liveCount;
  }

  /**
   * E2E observable — the WORLD-space `from` X of the first drawn beam (the
   * sprite's actual transform), or `null` when nothing is drawn. Used by
   * `data-beam-rendered-from-x` to detect the render-cache detach bug
   * (reads what's DRAWN, not a recompute). World-space, so it undoes the
   * `pixiY = -gameY` flip applied in `setBeams`.
   */
  get renderedFromX(): number | null {
    return this._liveCount > 0 ? (this._pool[0]?.x ?? null) : null;
  }

  get renderedFromY(): number | null {
    return this._liveCount > 0 ? -(this._pool[0]?.y ?? 0) : null;
  }

  /** Test-only: total pool size (visible + hidden). */
  get poolSize(): number {
    return this._pool.length;
  }

  /** Test-only (P1a): the drawn SOLID-core WORLD length for beam `i` (= scale.x ×
   *  texture width, so it's correct for any texture width — see the setBeams
   *  texture-width note), or null when no such sprite is visible. */
  solidLenAt(i: number): number | null {
    const s = this._pool[i];
    return s && s.visible ? s.scale.x * s.texture.width : null;
  }

  /** Test-only (P1a): the falloff-TAIL sprite state for beam `i` — visibility,
   *  drawn WORLD length (= scale.x × texture width, correct for any texture
   *  width) and pixi-space start x — or null when the pool has no tail sprite for
   *  that index. */
  fadeTailAt(i: number): { visible: boolean; lenX: number; x: number } | null {
    const f = this._fadePool[i];
    return f ? { visible: f.visible, lenX: f.scale.x * f.texture.width, x: f.x } : null;
  }
}
