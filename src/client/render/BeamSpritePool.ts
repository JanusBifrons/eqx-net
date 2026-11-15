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
import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js';
import type { BeamLineLight } from './beamStyles.js';
import { CROSS_SECTION_ROWS, crossSectionPixels, type BeamCrossSection } from './beamCrossSection.js';

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
  /**
   * Per-beam style override (the capital heavy beam, plan beam-slices §8): its
   * tint / width / alpha replace the pool's for this beam only, so heavy and
   * fighter beams share ONE pool (same textures, so they still batch). It draws
   * in the pool's `styledContainer`, outside the glow-filtered `container`.
   * Absent/null: the pool's style. The texture stays the pool's.
   */
  style?: BeamSpriteStyle | null;
  /** Where a no-hit pulse crosses what its mount last hit on this line (the
   *  heavy beam's kill follow-through burning through the wreck), set by
   *  `BeamHitMemory.track`; the hit spot lights there. NaN/absent: none. */
  passX?: number;
  passY?: number;
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
  /** `?fx=new` glow overlay (`FxBeams`) halo / flow / flare size multiplier
   *  for a beam drawn with this style. Absent: 1 (the fighter look). */
  glowScale?: number;
  /** Fewest screen px the core is drawn wide when `setBeams` is given the
   *  camera scale, so a capital-scale beam stays heavy at capital zoom (like
   *  the naval shells' `SHELL_MIN_SCREEN_PX`). Absent: world width only. */
  minScreenPx?: number;
  /** A baked colour cross-section (the capital heavy beam: a white-hot core
   *  through saturated violet to soft glowing edges). Drawn untinted on one
   *  tiny texture shared by every beam of this profile, `span` × the core
   *  width wide. Absent: the flat texture tinted `tint`. */
  crossSection?: BeamCrossSection;
  /** The beam is a light along its whole length (`addBeamLights`; the
   *  heavy beam). Absent: a hit light and a soft one at its middle. */
  lineLight?: BeamLineLight;
}

/** The core width a `style` beam is drawn at (world u): its `width`, but
 *  never under `minScreenPx` on screen when `cameraScale` (px per u) is known. */
export function beamCoreWidth(style: BeamSpriteStyle, cameraScale?: number): number {
  return style.minScreenPx !== undefined && cameraScale !== undefined && cameraScale > 0
    ? Math.max(style.width, style.minScreenPx / cameraScale)
    : style.width;
}

/** The shared solid / fade-tail textures of a cross-section profile. */
interface CrossSectionTextures { readonly solid: Texture; readonly fade: Texture }
const _crossSectionTextures = new Map<BeamCrossSection, CrossSectionTextures>();
/** Fade-tail texture width (its alpha ramps 1 → 0 left to right). */
const CROSS_SECTION_FADE_W = 64;

function bufferTexture(px: Uint8Array, width: number, height: number): Texture {
  return new Texture({
    source: new BufferImageSource({
      resource: px, width, height, alphaMode: 'premultiplied-alpha', scaleMode: 'linear',
    }),
  });
}

/** Lazily-built textures of `cs` (from pixel buffers: no canvas, so they are
 *  real headless too), shared by every beam drawn with that profile: the
 *  heavy beams batch together. */
export function crossSectionTextures(cs: BeamCrossSection): CrossSectionTextures {
  let t = _crossSectionTextures.get(cs);
  if (!t) {
    const H = CROSS_SECTION_ROWS, W = CROSS_SECTION_FADE_W;
    t = {
      solid: bufferTexture(crossSectionPixels(cs, 1, H), 1, H),
      fade: bufferTexture(crossSectionPixels(cs, W, H, (x) => 1 - x / (W - 1)), W, H),
    };
    _crossSectionTextures.set(cs, t);
  }
  return t;
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

/** One drawing lane of a pool: its container and pooled core / tail sprites. */
interface BeamLane {
  readonly container: Container;
  readonly pool: Sprite[];
  /** Parallel pool of falloff-tail sprites (taper + solidLen only). */
  readonly fadePool: Sprite[];
  /** Sprites in use this frame. */
  used: number;
}

function makeLane(container: Container): BeamLane {
  return { container, pool: [], fadePool: [], used: 0 };
}

function hideFrom(lane: BeamLane, from: number): void {
  for (let i = from; i < lane.pool.length; i++) {
    const s = lane.pool[i];
    if (s && s.visible) s.visible = false;
    const f = lane.fadePool[i];
    if (f && f.visible) f.visible = false;
  }
}

export class BeamSpritePool {
  /** The pool's own beams (its style): the container `LaserGlow` filters. */
  readonly container: Container;
  /**
   * Beams with a per-beam `style` override (the capital heavy beam) draw here,
   * a SIBLING the owner adds next to `container`, never inside it: the
   * container-wide glow filter (`LaserGlow`, one colour for every remote beam)
   * would otherwise wash the override's own colour into the pool's glow (the
   * violet heavy beam read as a thin orange line). It has no filter, so no
   * extra filter pass; same shared textures, so its sprites still batch.
   */
  readonly styledContainer: Container;
  private readonly _texture: Texture;
  /** Solid (full-strength) texture for the `solidLen` core segment. */
  private readonly _solidTexture: Texture;
  /** Linear fade texture for the falloff tail (taper pools only). */
  private readonly _fadeTexture: Texture | null;
  private readonly _main: BeamLane;
  private readonly _styled: BeamLane;
  /** Core / tail sprite drawn for beam `i` this frame (test + feedback reads). */
  private readonly _coreOf: Sprite[] = [];
  private readonly _fadeOf: (Sprite | null)[] = [];
  /** Core width (world u) beam `i` was drawn at this frame (test reads). */
  private readonly _coreWOf: number[] = [];
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
    this.styledContainer = new Container();
    this.styledContainer.label = 'BeamSpritePool.styled';
    this.styledContainer.visible = false;
    this._main = makeLane(this.container);
    this._styled = makeLane(this.styledContainer);
  }

  /**
   * Sync the pool to render exactly `count` beams. Reads from
   * `beams[0..count-1]`. Sprites beyond `count` are hidden but kept
   * in the pool for later frames (no destroy churn). A beam with a `style`
   * override draws in `styledContainer`, the rest in `container`.
   *
   * `cameraScale` (screen px per world unit): a style with `minScreenPx` draws
   * its core at least that many px wide. Omitted: world widths only.
   *
   * Caller is responsible for the "did anything actually change?"
   * dirty-flag gate above this call site — if no beam moved, the
   * pool still gets re-set to the same values, which is cheap
   * (transform writes, no geometry rebuild).
   */
  setBeams(beams: readonly BeamView[], count: number, cameraScale?: number): void {
    const taper = this._fadeTexture !== null;
    this._main.used = 0;
    this._styled.used = 0;
    for (let i = 0; i < count; i++) {
      const b = beams[i]!;
      const lane = b.style ? this._styled : this._main;
      const li = lane.used++;
      let sprite = lane.pool[li];
      if (!sprite) {
        sprite = new Sprite(this._texture);
        // Anchor at (0, 0.5) → sprite's local origin is at the FROM
        // end and its Y-center is on the beam's line. scale.x stretches
        // along the beam direction; scale.y becomes the stroke width.
        sprite.anchor.set(0, 0.5);
        lane.pool[li] = sprite;
        lane.container.addChild(sprite);
      }
      this._coreOf[i] = sprite;
      this._fadeOf[i] = null;
      sprite.visible = true;
      const st = b.style ?? this._style;
      // A cross-section style carries its colours in its own texture: drawn
      // untinted, `span` × the core width wide (the soft edges sit outside
      // the core). Textures are `texH` px tall, so scale.y = drawn width / texH.
      const xs = st.crossSection ? crossSectionTextures(st.crossSection) : null;
      const tint = xs ? 0xffffff : st.tint;
      sprite.tint = tint;
      sprite.alpha = st.alpha;
      const coreW = beamCoreWidth(st, cameraScale);
      this._coreWOf[i] = coreW;
      const drawnW = xs ? coreW * st.crossSection!.span : coreW;
      const solidTex = xs ? xs.solid : this._solidTexture;
      const fadeTex = xs ? xs.fade : this._fadeTexture;
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

      if ((taper || xs) && b.solidLen !== undefined) {
        // P1a — explicit solid length: draw a full-strength SOLID core
        // [0, solidLen] (clips solid at any hit) plus a LINEAR fade TAIL
        // [solidLen, len] (the optimal→max falloff band, fading to nothing). This
        // replaces the single stretched-gradient sprite whose fade was anchored to
        // a FRACTION of the drawn length (so it fled the optimal range and read as
        // "goes forever / solid past the guide / never tapers").
        const solidLen = Math.max(0, Math.min(b.solidLen, len));
        sprite.texture = solidTex;
        // scale.x renders `world units = scale.x × texture.width`, so the world
        // length must be DIVIDED by the texture width. The solid core uses the
        // 1×1 WHITE texture (÷1 = no-op), but the fade tail below uses the 256-px
        // gradient texture — without the division it rendered 256× too long, so
        // the "fade" stretched ~19 200 u and the beam looked solid to infinity /
        // ran off the screen (the "renders infinitely" bug; headless tests use
        // the 1×1 WHITE fallback so they never saw it).
        sprite.scale.set(Math.max(solidLen, 0.0001) / solidTex.width, drawnW / solidTex.height);
        const tailLen = len - solidLen;
        let fade = lane.fadePool[li];
        if (tailLen > 0.01) {
          if (!fade) {
            fade = new Sprite(fadeTex!);
            fade.anchor.set(0, 0.5);
            lane.fadePool[li] = fade;
            lane.container.addChild(fade);
          }
          this._fadeOf[i] = fade;
          fade.texture = fadeTex!;
          fade.visible = true;
          fade.tint = tint;
          fade.alpha = st.alpha;
          fade.x = b.fromX + Math.cos(rot) * solidLen;
          fade.y = -b.fromY + Math.sin(rot) * solidLen;
          fade.rotation = rot;
          // ÷ texture width (256 for the real gradient) — see the solid-core note.
          fade.scale.set(tailLen / fadeTex!.width, drawnW / fadeTex!.height);
        } else if (fade) {
          this._fadeOf[i] = fade;
          fade.visible = false;
        }
      } else {
        // Legacy single-sprite path: the per-style texture (gradient if taper,
        // else WHITE) stretched to the full length. Used by remote/mining beams.
        // A per-beam style that does not taper (the heavy beam) draws solid
        // even in a taper pool: full strength to its end point.
        // ÷ texture width (256 for the taper gradient) — see the solid-core note;
        // without it remote/enemy beams rendered 256× too long too.
        const tex = b.style && !b.style.taper ? solidTex : this._texture;
        sprite.texture = tex;
        sprite.scale.set(len / tex.width, drawnW / tex.height);
        const fade = lane.fadePool[li];
        if (fade) fade.visible = false;
      }
    }
    // Hide stale sprites left over from a higher-count frame (both lanes).
    hideFrom(this._main, this._main.used);
    hideFrom(this._styled, this._styled.used);
    this.styledContainer.visible = this._styled.used > 0;
    this._liveCount = count;
  }

  /** Hide all beams (e.g. when the lasers slice becomes empty). */
  hideAll(): void {
    hideFrom(this._main, 0);
    hideFrom(this._styled, 0);
    this.styledContainer.visible = false;
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
    return this._liveCount > 0 ? (this._coreOf[0]?.x ?? null) : null;
  }

  get renderedFromY(): number | null {
    return this._liveCount > 0 ? -(this._coreOf[0]?.y ?? 0) : null;
  }

  /** Test-only: total pool size (visible + hidden, both lanes). */
  get poolSize(): number {
    return this._main.pool.length + this._styled.pool.length;
  }

  /** Test-only (P1a): the drawn SOLID-core WORLD length for beam `i` (= scale.x ×
   *  texture width, so it's correct for any texture width — see the setBeams
   *  texture-width note), or null when no such sprite is visible. */
  solidLenAt(i: number): number | null {
    const s = i < this._liveCount ? this._coreOf[i] : undefined;
    return s && s.visible ? s.scale.x * s.texture.width : null;
  }

  /** Test-only (P1a): the falloff-TAIL sprite state for beam `i` — visibility,
   *  drawn WORLD length (= scale.x × texture width, correct for any texture
   *  width) and pixi-space start x — or null when the pool has no tail sprite for
   *  that index. */
  fadeTailAt(i: number): { visible: boolean; lenX: number; x: number } | null {
    const f = i < this._liveCount ? this._fadeOf[i] : undefined;
    return f ? { visible: f.visible, lenX: f.scale.x * f.texture.width, x: f.x } : null;
  }

  /** Test-only: beam `i`'s drawn core — tint, core WORLD width (`width`; the
   *  opaque body), the whole sprite's WORLD width (`drawnWidth` = scale.y ×
   *  texture height; wider than `width` by a cross-section's `span`), the
   *  container it sits in and its texture — or null. */
  coreAt(i: number): { tint: number; width: number; drawnWidth: number; parent: Container | null; texture: Texture } | null {
    const s = i < this._liveCount ? this._coreOf[i] : undefined;
    if (!s || !s.visible) return null;
    return { tint: s.tint, width: this._coreWOf[i]!, drawnWidth: s.scale.y * s.texture.height, parent: s.parent, texture: s.texture };
  }
}
