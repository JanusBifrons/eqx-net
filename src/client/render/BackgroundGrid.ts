import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Camera } from './worker/Camera';

/**
 * Two-tier dynamic background grid. Each frame redraws only the lines
 * inside the current viewport window (padded by one macro cell), so the
 * grid never visually terminates regardless of how far the player flies
 * past the original ±5000u world edge.
 *
 * Tier 1 — micro grid: 200u cells, drawn first, almost invisible. Reads
 * as faint background texture beneath the macro grid.
 *
 * Tier 2 — macro grid: 1000u cells (~50 ship-diameters at 24u/ship),
 * drawn on top, subtle but visible. This is the primary spatial reference
 * the player navigates by.
 *
 * Coord labels are placed at every macro intersection in `gx,gy` form
 * where the unit is one *micro* cell — matching the HUD's "Grid x, y"
 * readout. Labels are keyed by world-space intersection so panning
 * incurs no `text.text` churn (Pixi atlas re-upload is the expensive
 * part). They're suppressed when zoomed out past `LABEL_HIDE_ZOOM`
 * since the dense text would just be noise.
 *
 * Y-flip note: the grid math runs entirely in viewport (Pixi screen)
 * space, which is Y-down. Game logic is Y-up; the renderer flips with
 * `sprite.y = -entity.y` for all viewport-attached content. The lines
 * themselves are symmetric in Y so no flip is needed for geometry, but
 * the *displayed* label digits must invert Y so a label drawn at
 * Pixi-Y = -1000 reads `gy = +5` (matching game-space Y up).
 */

/**
 * Micro cell size in world units. This is also the unit the HUD "Grid
 * x,y" readout counts (`SectorInfoPanel`, `round(pos / 500)`) and the
 * spacing at which coordinate labels are drawn — so every visible
 * micro line carries its own number and the readout always lands on a
 * labelled line. Exported + locked by `BackgroundGrid.labels.test.ts`.
 */
export const GRID_CELL_SIZE = 500;
/**
 * Label spacing. MUST equal `GRID_CELL_SIZE` — labelling at the macro
 * size (the old behaviour) made labels jump 0,5,10 with nothing on the
 * visible grid for the ÷500 readout to correspond to (2026-05-15
 * smoke-test). Do not set this to `MACRO_SIZE`.
 */
export const GRID_LABEL_STEP = GRID_CELL_SIZE;

const CELL_SIZE  = GRID_CELL_SIZE;
const MACRO_SIZE = 2500;

const MICRO_COLOR = 0x1a2040;
// Raised from 0.18 → 0.34: the micro grid is now the primary
// coordinate reference (every line is labelled), so it has to be
// clearly visible, not a near-invisible texture. Still subordinate to
// the macro grid (0.55) which stays the bold orientation lattice.
const MICRO_ALPHA = 0.34;
const MACRO_COLOR = 0x3a4a80;
const MACRO_ALPHA = 0.55;

const LABEL_ALPHA = 0.30;
const LABEL_HIDE_ZOOM = 0.5;
const LABEL_OFFSET_X = 4;
const LABEL_OFFSET_Y = 2;

/** One coordinate label: where to draw it (Pixi space) + the
 *  game-space grid numbers to show. */
export interface GridLabelSpec {
  key: string;
  x: number;
  y: number;
  gx: number;
  gy: number;
}

/**
 * Pure: enumerate the coordinate labels for a (already padded,
 * snapped) Pixi-space view window. One label per `step` intersection.
 * `gx = x / cell`; `gy = -y / cell` flips Pixi-Y-down back to
 * game-Y-up so the printed number matches the HUD readout. Pixi-free
 * so the label density/format is unit-testable (mirrors the
 * `spriteUpdateDecisions` extraction pattern); `BackgroundGrid` only
 * turns these specs into `Text` nodes.
 */
export function computeGridLabels(args: {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  step: number;
  cell: number;
}): GridLabelSpec[] {
  const { xMin, xMax, yMin, yMax, step, cell } = args;
  const out: GridLabelSpec[] = [];
  if (step <= 0 || cell <= 0) return out;
  for (let x = xMin; x <= xMax; x += step) {
    for (let y = yMin; y <= yMax; y += step) {
      out.push({
        key: `${x},${y}`,
        x,
        y,
        gx: x / cell,
        gy: -y / cell,
      });
    }
  }
  return out;
}

const LABEL_STYLE = new TextStyle({
  fontFamily: 'system-ui, sans-serif',
  fontSize: 11,
  fill: 0xffffff,
});

/**
 * Per-frame label-churn sub-costs (F1 of the warp-spool perf
 * investigation — `docs/HANDOFF-warp-spool-perf-followup.md`). Written
 * by `update()` every frame; `PixiRenderer` reads `lastFrameMarkers`
 * right after calling `backgroundGrid.update()` and folds these into
 * the `FrameMarkers` it ships to the main thread. The
 * handoff's leading hypothesis is that this label churn (O(n²) over
 * the padded window, create/destroy every frame while the camera pans
 * fast during spool) is the in-game-vs-sandbox differential — but the
 * markers, not the hypothesis, decide (Invariant #13). The
 * `performance.now()` brackets here are sub-µs and unconditional
 * (negligible + uniform, so the markers-off baseline is the production
 * cost).
 */
export interface GridFrameMarkers {
  /** `computeGridLabels` enumeration cost (ms). */
  labelSpecMs: number;
  /** New-`Text` instantiation + `addChild` loop cost (ms). */
  textCreateMs: number;
  /** Off-screen label `destroy()` + `labels.delete` sweep cost (ms). */
  cleanupMs: number;
  /** Live label `Text` count after this frame's add/sweep. */
  labelCount: number;
}

export class BackgroundGrid {
  private readonly microLines = new Graphics();
  private readonly macroLines = new Graphics();
  private readonly labelContainer = new Container();
  private readonly labels = new Map<string, Text>();
  private readonly seen = new Set<string>();
  /**
   * Plan: combat-fx-hunt (2026-05-31) — last-built grid-bounds cache.
   * Pre-fix `update(camera)` cleared + rebuilt micro + macro lines
   * every frame regardless of whether the camera moved past a cell
   * boundary. With ~30 lines × 3 Pixi ops × 60 Hz = ~5400 graphics
   * ops/sec — the #2 per-frame allocator after HealthBars.
   *
   * Grid bounds snap to multiples of `CELL_SIZE` / `MACRO_SIZE`, so
   * for a stationary or slowly-moving camera the bounds stay
   * identical for many frames. Sentinels (NaN) force the first
   * paint after attach.
   */
  private prevMicroXMin = Number.NaN;
  private prevMicroXMax = Number.NaN;
  private prevMicroYMin = Number.NaN;
  private prevMicroYMax = Number.NaN;
  private prevMacroXMin = Number.NaN;
  private prevMacroXMax = Number.NaN;
  private prevMacroYMin = Number.NaN;
  private prevMacroYMax = Number.NaN;

  /**
   * F1 instrumentation — last frame's label-churn sub-costs. Mutated in
   * place by `update()` (no per-frame allocation); read by
   * `PixiRenderer.update()` immediately after `backgroundGrid.update()`.
   * See `GridFrameMarkers`.
   */
  readonly lastFrameMarkers: GridFrameMarkers = {
    labelSpecMs: 0,
    textCreateMs: 0,
    cleanupMs: 0,
    labelCount: 0,
  };

  attach(camera: Camera): void {
    camera.addChild(this.microLines);
    camera.addChild(this.macroLines);
    camera.addChild(this.labelContainer);
  }

  update(camera: Camera): void {
    const cx = camera.center.x;
    const cy = camera.center.y;
    // Pad by MACRO_SIZE so the visible window includes any line one macro
    // cell beyond the screen edge — prevents edges popping in at the seam.
    const halfW = camera.worldScreenWidth  * 0.5 + MACRO_SIZE;
    const halfH = camera.worldScreenHeight * 0.5 + MACRO_SIZE;

    const xMinMicro = Math.floor((cx - halfW) / CELL_SIZE) * CELL_SIZE;
    const xMaxMicro = Math.ceil ((cx + halfW) / CELL_SIZE) * CELL_SIZE;
    const yMinMicro = Math.floor((cy - halfH) / CELL_SIZE) * CELL_SIZE;
    const yMaxMicro = Math.ceil ((cy + halfH) / CELL_SIZE) * CELL_SIZE;

    // Pixi v8 Graphics: stroke per segment, NOT once at end. A trailing
    // single `stroke()` after many chained moveTo+lineTo strokes only
    // the most-recently-built subpath — earlier subpaths get pushed to
    // history but the trailing stroke applies only to current. Visible
    // on the micro grid (400 lines, only the last rendered → looked
    // empty); less visible on the macro grid (16 lines). 2026-05-14.
    //
    // Plan: combat-fx-hunt (2026-05-31) — dirty-flag cache. Rebuild
    // ONLY when the snapped bounds change. The bounds snap to
    // CELL_SIZE multiples, so a stationary camera (held-fire combat)
    // skips the rebuild every frame after the first. Each rebuild
    // was ~30 lines × 3 Pixi ops in v8 = fresh ShapePath /
    // GpuGraphicsContext per line, the #2 source of GC pressure
    // under combat after HealthBars.
    const microBoundsChanged =
      xMinMicro !== this.prevMicroXMin
      || xMaxMicro !== this.prevMicroXMax
      || yMinMicro !== this.prevMicroYMin
      || yMaxMicro !== this.prevMicroYMax;
    if (microBoundsChanged) {
      this.microLines.clear();
      for (let x = xMinMicro; x <= xMaxMicro; x += CELL_SIZE) {
        this.microLines
          .moveTo(x, yMinMicro)
          .lineTo(x, yMaxMicro)
          .stroke({ color: MICRO_COLOR, width: 1, alpha: MICRO_ALPHA });
      }
      for (let y = yMinMicro; y <= yMaxMicro; y += CELL_SIZE) {
        this.microLines
          .moveTo(xMinMicro, y)
          .lineTo(xMaxMicro, y)
          .stroke({ color: MICRO_COLOR, width: 1, alpha: MICRO_ALPHA });
      }
      this.prevMicroXMin = xMinMicro;
      this.prevMicroXMax = xMaxMicro;
      this.prevMicroYMin = yMinMicro;
      this.prevMicroYMax = yMaxMicro;
    }

    const xMinMacro = Math.floor((cx - halfW) / MACRO_SIZE) * MACRO_SIZE;
    const xMaxMacro = Math.ceil ((cx + halfW) / MACRO_SIZE) * MACRO_SIZE;
    const yMinMacro = Math.floor((cy - halfH) / MACRO_SIZE) * MACRO_SIZE;
    const yMaxMacro = Math.ceil ((cy + halfH) / MACRO_SIZE) * MACRO_SIZE;

    const macroBoundsChanged =
      xMinMacro !== this.prevMacroXMin
      || xMaxMacro !== this.prevMacroXMax
      || yMinMacro !== this.prevMacroYMin
      || yMaxMacro !== this.prevMacroYMax;
    if (macroBoundsChanged) {
      this.macroLines.clear();
      for (let x = xMinMacro; x <= xMaxMacro; x += MACRO_SIZE) {
        this.macroLines
          .moveTo(x, yMinMacro)
          .lineTo(x, yMaxMacro)
          .stroke({ color: MACRO_COLOR, width: 1, alpha: MACRO_ALPHA });
      }
      for (let y = yMinMacro; y <= yMaxMacro; y += MACRO_SIZE) {
        this.macroLines
          .moveTo(xMinMacro, y)
          .lineTo(xMaxMacro, y)
          .stroke({ color: MACRO_COLOR, width: 1, alpha: MACRO_ALPHA });
      }
      this.prevMacroXMin = xMinMacro;
      this.prevMacroXMax = xMaxMacro;
      this.prevMacroYMin = yMinMacro;
      this.prevMacroYMax = yMaxMacro;
    }

    // Labels at EVERY micro intersection (500u) so each visible micro
    // line carries its number and the HUD's ÷500 readout always lands
    // on a labelled line. Still gated by zoom so 11px text stays
    // legible (and the label count stays bounded when zoomed out).
    this.seen.clear();
    // F1 brackets — split label-spec enumeration vs Text-create vs the
    // off-screen cleanup sweep so the analyzer can attribute the
    // sandbox-vs-game differential. performance.now() is sub-µs +
    // uniform; unconditional is fine (markers-off baseline = prod cost).
    let labelSpecMs = 0;
    let textCreateMs = 0;
    if (camera.scale.x >= LABEL_HIDE_ZOOM) {
      const specStart = performance.now();
      const specs = computeGridLabels({
        xMin: xMinMicro,
        xMax: xMaxMicro,
        yMin: yMinMicro,
        yMax: yMaxMicro,
        step: GRID_LABEL_STEP,
        cell: GRID_CELL_SIZE,
      });
      labelSpecMs = performance.now() - specStart;

      const createStart = performance.now();
      for (const spec of specs) {
        this.seen.add(spec.key);
        if (!this.labels.has(spec.key)) {
          const text = new Text({ text: `${spec.gx},${spec.gy}`, style: LABEL_STYLE });
          text.alpha = LABEL_ALPHA;
          text.position.set(spec.x + LABEL_OFFSET_X, spec.y + LABEL_OFFSET_Y);
          this.labelContainer.addChild(text);
          this.labels.set(spec.key, text);
        }
      }
      textCreateMs = performance.now() - createStart;
    }

    const cleanupStart = performance.now();
    for (const [key, text] of this.labels) {
      if (!this.seen.has(key)) {
        // Pixi v8 Text owns its dynamic glyph atlas (Texture +
        // TextureSource + WebGLTexture). Plain `.destroy()` leaks all
        // three — confirmed by 2026-05-31 heap snapshot diff.
        text.destroy({ texture: true, textureSource: true });
        this.labels.delete(key);
      }
    }
    const cleanupMs = performance.now() - cleanupStart;

    this.lastFrameMarkers.labelSpecMs = labelSpecMs;
    this.lastFrameMarkers.textCreateMs = textCreateMs;
    this.lastFrameMarkers.cleanupMs = cleanupMs;
    this.lastFrameMarkers.labelCount = this.labels.size;
  }

  destroy(): void {
    for (const text of this.labels.values()) {
      text.destroy({ texture: true, textureSource: true });
    }
    this.labels.clear();
    this.labelContainer.destroy({ children: true });
    this.microLines.destroy();
    this.macroLines.destroy();
  }
}
