import { Graphics } from 'pixi.js';
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
 * Y-flip note: the grid math runs entirely in viewport (Pixi screen)
 * space, which is Y-down. Game logic is Y-up; the renderer flips with
 * `sprite.y = -entity.y` for all viewport-attached content. The lines
 * themselves are symmetric in Y so no flip is needed for geometry.
 *
 * 2026-05-31: coordinate label rendering REMOVED. User-driven removal
 * after heap-leak hunt confirmed grid labels were the dominant Text
 * churn source under combat (761 fresh / 566 destroyed Text instances
 * per 60 s of held-thrust). The `computeGridLabels` pure helper +
 * `GridLabelSpec` interface + `GRID_LABEL_STEP` constant stay
 * exported because `BackgroundGrid.labels.test.ts` locks the
 * label-spec geometry — keeping the function alive preserves the
 * regression lock even though `update()` no longer instantiates Text
 * nodes from the specs.
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

/**
 * Screen spacing (CSS px) below which a grid tier is hidden, and at which
 * it is fully shown. Between the two it fades in linearly.
 *
 * 2026-11-12 (fullscreen hairlines): at a capital zoom the 500 u tier sits
 * ~6 px apart (battleship floor 0.0127), a near-solid hatch. A tier that
 * close carries no navigation information, so it fades out instead.
 */
export const GRID_HIDE_SPACING_PX = 8;
export const GRID_FULL_SPACING_PX = 24;

/**
 * Pure: the visibility factor (0..1) of a grid tier whose cells are
 * `cellWorld` units wide at camera `scale`. 0 hides the tier.
 */
export function gridTierAlpha(cellWorld: number, scale: number): number {
  const px = cellWorld * scale;
  if (!(px > GRID_HIDE_SPACING_PX)) return 0;
  if (px >= GRID_FULL_SPACING_PX) return 1;
  return (px - GRID_HIDE_SPACING_PX) / (GRID_FULL_SPACING_PX - GRID_HIDE_SPACING_PX);
}

/**
 * Stroke styles, built once. `pixelLine` draws each line exactly one
 * device pixel wide at ANY zoom. A `width: 1` stroke is one WORLD unit:
 * at a capital zoom (scale 0.01-0.15) that is a 0.01-0.15 px quad, which
 * the GPU only lights when it happens to cover a pixel centre, so the
 * whole lattice flashed in as hard 1 px lines on some frames and dropped
 * out on others as the camera moved (the "full-screen hairlines" the
 * 2026-11-12 showcase reviews flagged). Lock: BackgroundGrid.hairline.test.ts.
 */
const MICRO_STROKE = { color: MICRO_COLOR, width: 1, alpha: MICRO_ALPHA, pixelLine: true } as const;
const MACRO_STROKE = { color: MACRO_COLOR, width: 1, alpha: MACRO_ALPHA, pixelLine: true } as const;

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

    // Fade a tier out when its lines crowd together on screen. A hidden
    // tier is not rebuilt; its bounds cache resets so it repaints when it
    // comes back into view.
    const scale = camera.scale.x;
    const microAlpha = gridTierAlpha(CELL_SIZE, scale);
    const macroAlpha = gridTierAlpha(MACRO_SIZE, scale);
    this.microLines.visible = microAlpha > 0;
    this.microLines.alpha = microAlpha;
    this.macroLines.visible = macroAlpha > 0;
    this.macroLines.alpha = macroAlpha;
    if (microAlpha <= 0) this.prevMicroXMin = Number.NaN;
    if (macroAlpha <= 0) this.prevMacroXMin = Number.NaN;

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
    if (microAlpha > 0 && microBoundsChanged) {
      this.microLines.clear();
      for (let x = xMinMicro; x <= xMaxMicro; x += CELL_SIZE) {
        this.microLines
          .moveTo(x, yMinMicro)
          .lineTo(x, yMaxMicro)
          .stroke(MICRO_STROKE);
      }
      for (let y = yMinMicro; y <= yMaxMicro; y += CELL_SIZE) {
        this.microLines
          .moveTo(xMinMicro, y)
          .lineTo(xMaxMicro, y)
          .stroke(MICRO_STROKE);
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
    if (macroAlpha > 0 && macroBoundsChanged) {
      this.macroLines.clear();
      for (let x = xMinMacro; x <= xMaxMacro; x += MACRO_SIZE) {
        this.macroLines
          .moveTo(x, yMinMacro)
          .lineTo(x, yMaxMacro)
          .stroke(MACRO_STROKE);
      }
      for (let y = yMinMacro; y <= yMaxMacro; y += MACRO_SIZE) {
        this.macroLines
          .moveTo(xMinMacro, y)
          .lineTo(xMaxMacro, y)
          .stroke(MACRO_STROKE);
      }
      this.prevMacroXMin = xMinMacro;
      this.prevMacroXMax = xMaxMacro;
      this.prevMacroYMin = yMinMacro;
      this.prevMacroYMax = yMaxMacro;
    }

    // Label rendering REMOVED 2026-05-31 (user direction post heap-leak
    // hunt). Coordinate text labels were the dominant Text + Texture
    // churn source under combat. The `lastFrameMarkers` fields are
    // zeroed so the F1 instrumentation consumer in PixiRenderer still
    // reads stable values; the `GridFrameMarkers` interface stays for
    // back-compat with that consumer.
    this.lastFrameMarkers.labelSpecMs = 0;
    this.lastFrameMarkers.textCreateMs = 0;
    this.lastFrameMarkers.cleanupMs = 0;
    this.lastFrameMarkers.labelCount = 0;
  }

  destroy(): void {
    this.microLines.destroy();
    this.macroLines.destroy();
  }
}
