/**
 * Regression lock — grid coordinate-label density.
 *
 * THE BUG (smoke-test, 2026-05-15, user: "the grid coordinates aren't
 * right ... It's just the grid cells readout which is wrong"):
 *
 *   The HUD "Grid x,y" readout counts MICRO cells (`round(pos/500)`),
 *   but `BackgroundGrid` only drew a coordinate label at every MACRO
 *   intersection (every 2500u) and the micro grid was near-invisible
 *   (alpha 0.18). So the only readable labels jumped 0, 5, 10, … and
 *   the readout number never lined up with a visible labelled line —
 *   the readout was "right" arithmetically but had nothing on-grid to
 *   correspond to. User decision: keep the ÷500 unit, make every micro
 *   cell visible and labelled so each thin line is one unit.
 *
 * THE FIX: labels are emitted at every `GRID_LABEL_STEP` intersection,
 * and `GRID_LABEL_STEP === GRID_CELL_SIZE` (500) — NOT the macro size
 * (2500). Consecutive labels therefore differ by exactly 1 unit, so
 * each visible 500u cell carries its own number and the HUD readout
 * lands on a labelled line.
 *
 * WHY THIS LEVEL: which intersections get a label and what number each
 * shows is pure logic with no Pixi/worker seam — exactly the
 * `spriteUpdateDecisions` / `shouldDetachWarpVisual` extraction
 * pattern. `computeGridLabels` owns it; `BackgroundGrid` only turns
 * the specs into `Text` nodes.
 *
 * These assertions fail against the pre-fix module (macro-spaced
 * labels, gx stepping by 5); reverting `GRID_LABEL_STEP` back to the
 * macro size re-fails them.
 */
import { describe, it, expect } from 'vitest';
import {
  computeGridLabels,
  GRID_LABEL_STEP,
  GRID_CELL_SIZE,
} from './BackgroundGrid.js';

describe('computeGridLabels', () => {
  it('labels every micro cell, NOT every macro cell (the bug)', () => {
    // A 0..2500 window: a macro-spaced labeller yields 2 labels
    // (gx 0 and 5); the fix yields 6 (gx 0..5).
    const specs = computeGridLabels({
      xMin: 0,
      xMax: 2500,
      yMin: 0,
      yMax: 0,
      step: GRID_LABEL_STEP,
      cell: GRID_CELL_SIZE,
    });
    const gxs = specs.filter((s) => s.y === 0).map((s) => s.gx).sort((a, b) => a - b);
    expect(gxs).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('GRID_LABEL_STEP is the micro cell size, not the macro size', () => {
    // The whole defect was the label step being the macro (2500).
    // Lock the constant so a revert fails loudly here.
    expect(GRID_LABEL_STEP).toBe(GRID_CELL_SIZE);
    expect(GRID_CELL_SIZE).toBe(500);
  });

  it('consecutive labels differ by exactly 1 unit on each axis', () => {
    const specs = computeGridLabels({
      xMin: 1000,
      xMax: 2500,
      yMin: -1000,
      yMax: 0,
      step: GRID_LABEL_STEP,
      cell: GRID_CELL_SIZE,
    });
    const row = specs.filter((s) => s.y === 0).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      expect(row[i]!.gx - row[i - 1]!.gx).toBe(1);
      expect(row[i]!.x - row[i - 1]!.x).toBe(GRID_CELL_SIZE);
    }
  });

  it('flips Pixi Y → game Y for the displayed number (gy = -y/cell)', () => {
    // BackgroundGrid runs in Pixi space (Y-down); the displayed grid
    // number must read game-space (Y-up). A label at Pixi y=-1000 is
    // game gy = +2 (matches the HUD `round(ship.y/500)`).
    const specs = computeGridLabels({
      xMin: 0,
      xMax: 0,
      yMin: -1000,
      yMax: -1000,
      step: GRID_LABEL_STEP,
      cell: GRID_CELL_SIZE,
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.gx).toBe(0);
    expect(specs[0]!.gy).toBe(2);
  });

  it('keys are unique per intersection (no duplicate Text churn)', () => {
    const specs = computeGridLabels({
      xMin: 0,
      xMax: 1500,
      yMin: -1500,
      yMax: 0,
      step: GRID_LABEL_STEP,
      cell: GRID_CELL_SIZE,
    });
    const keys = new Set(specs.map((s) => s.key));
    expect(keys.size).toBe(specs.length);
  });
});
