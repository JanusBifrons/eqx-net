import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Viewport } from 'pixi-viewport';

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

const CELL_SIZE  = 500;
const MACRO_SIZE = 2500;

const MICRO_COLOR = 0x1a2040;
const MICRO_ALPHA = 0.18;
const MACRO_COLOR = 0x3a4a80;
const MACRO_ALPHA = 0.55;

const LABEL_ALPHA = 0.22;
const LABEL_HIDE_ZOOM = 0.5;
const LABEL_OFFSET_X = 4;
const LABEL_OFFSET_Y = 2;

const LABEL_STYLE = new TextStyle({
  fontFamily: 'system-ui, sans-serif',
  fontSize: 11,
  fill: 0xffffff,
});

export class BackgroundGrid {
  private readonly microLines = new Graphics();
  private readonly macroLines = new Graphics();
  private readonly labelContainer = new Container();
  private readonly labels = new Map<string, Text>();
  private readonly seen = new Set<string>();

  attach(viewport: Viewport): void {
    viewport.addChild(this.microLines);
    viewport.addChild(this.macroLines);
    viewport.addChild(this.labelContainer);
  }

  update(viewport: Viewport): void {
    const cx = viewport.center.x;
    const cy = viewport.center.y;
    // Pad by MACRO_SIZE so the visible window includes any line one macro
    // cell beyond the screen edge — prevents edges popping in at the seam.
    const halfW = viewport.worldScreenWidth  * 0.5 + MACRO_SIZE;
    const halfH = viewport.worldScreenHeight * 0.5 + MACRO_SIZE;

    const xMinMicro = Math.floor((cx - halfW) / CELL_SIZE) * CELL_SIZE;
    const xMaxMicro = Math.ceil ((cx + halfW) / CELL_SIZE) * CELL_SIZE;
    const yMinMicro = Math.floor((cy - halfH) / CELL_SIZE) * CELL_SIZE;
    const yMaxMicro = Math.ceil ((cy + halfH) / CELL_SIZE) * CELL_SIZE;

    this.microLines.clear();
    for (let x = xMinMicro; x <= xMaxMicro; x += CELL_SIZE) {
      this.microLines.moveTo(x, yMinMicro).lineTo(x, yMaxMicro);
    }
    for (let y = yMinMicro; y <= yMaxMicro; y += CELL_SIZE) {
      this.microLines.moveTo(xMinMicro, y).lineTo(xMaxMicro, y);
    }
    this.microLines.stroke({ color: MICRO_COLOR, width: 1, alpha: MICRO_ALPHA });

    const xMinMacro = Math.floor((cx - halfW) / MACRO_SIZE) * MACRO_SIZE;
    const xMaxMacro = Math.ceil ((cx + halfW) / MACRO_SIZE) * MACRO_SIZE;
    const yMinMacro = Math.floor((cy - halfH) / MACRO_SIZE) * MACRO_SIZE;
    const yMaxMacro = Math.ceil ((cy + halfH) / MACRO_SIZE) * MACRO_SIZE;

    this.macroLines.clear();
    for (let x = xMinMacro; x <= xMaxMacro; x += MACRO_SIZE) {
      this.macroLines.moveTo(x, yMinMacro).lineTo(x, yMaxMacro);
    }
    for (let y = yMinMacro; y <= yMaxMacro; y += MACRO_SIZE) {
      this.macroLines.moveTo(xMinMacro, y).lineTo(xMaxMacro, y);
    }
    this.macroLines.stroke({ color: MACRO_COLOR, width: 1, alpha: MACRO_ALPHA });

    // Labels: only when zoomed in enough that 11px text is legible.
    this.seen.clear();
    if (viewport.scale.x >= LABEL_HIDE_ZOOM) {
      for (let mx = xMinMacro; mx <= xMaxMacro; mx += MACRO_SIZE) {
        for (let my = yMinMacro; my <= yMaxMacro; my += MACRO_SIZE) {
          const key = `${mx},${my}`;
          this.seen.add(key);
          if (!this.labels.has(key)) {
            const gx = mx / CELL_SIZE;
            const gy = -my / CELL_SIZE;
            const text = new Text({ text: `${gx},${gy}`, style: LABEL_STYLE });
            text.alpha = LABEL_ALPHA;
            text.position.set(mx + LABEL_OFFSET_X, my + LABEL_OFFSET_Y);
            this.labelContainer.addChild(text);
            this.labels.set(key, text);
          }
        }
      }
    }

    for (const [key, text] of this.labels) {
      if (!this.seen.has(key)) {
        text.destroy();
        this.labels.delete(key);
      }
    }
  }

  destroy(): void {
    for (const text of this.labels.values()) text.destroy();
    this.labels.clear();
    this.labelContainer.destroy({ children: true });
    this.microLines.destroy();
    this.macroLines.destroy();
  }
}
