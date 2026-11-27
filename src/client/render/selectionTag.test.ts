/**
 * Lock for `writeSelectionTag` (selection-HUD S6a): the focus tag anchor is
 * the TOP-CENTRE of its selection bracket (same projection + half-size rule as
 * `SelectionBracket`), its on-screen diameter feeds `isIconOnly`, and the
 * fleet centroid is the mean game pose of the selected ships, projected.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { writeSelectionTag, type SelectionTagCamera } from './selectionTag.js';
import { copySelectionTagFeedback, selectionTagFeedbackInit, type SelectionTagFeedback } from './selectionTagFeedback.js';
import { MIN_HALF_PX } from './SelectionBracket.js';
import { isIconOnly } from './pixi/FarZoomIcons.js';

vi.mock('pixi.js', () => ({ Container: class {}, Graphics: class {}, Sprite: class {}, Texture: class {} }));

/** Camera centred on the game origin, 800x600 px, at `zoom` (pixi y down). */
function cam(zoom: number): SelectionTagCamera {
  return {
    scale: { x: zoom },
    screenWidth: 800,
    screenHeight: 600,
    toScreenInto(wx, wy, out) { out.x = 400 + wx * zoom; out.y = 300 + wy * zoom; },
  };
}
/** A drone (swarm kind 1) at game (x, y) with bounding radius r. */
const drone = (x: number, y: number, radius: number) => ({ kind: 1, x, y, angle: 0, radius });
function mirror(swarm: Array<[number, ReturnType<typeof drone>]>): RenderMirror {
  return { ships: new Map(), swarm: new Map(swarm), localPlayerId: null } as unknown as RenderMirror;
}

describe('writeSelectionTag', () => {
  it('starts with nothing selected: NaN anchors, off screen', () => {
    const fb = selectionTagFeedbackInit();
    expect(fb.focusScreenX).toBeNaN();
    expect(fb.focusOnScreen).toBe(false);
    expect(fb.focusScreenDiam).toBe(0);
    expect(fb.selCentroidScreenX).toBeNaN();
    expect(fb.selCentroidOnScreen).toBe(false);
  });

  it('anchors the focus tag at its bracket top-centre (game y up → screen y down)', () => {
    const fb = selectionTagFeedbackInit();
    writeSelectionTag(mirror([[5, drone(10, 20, 10)]]), 'swarm-5', new Set(), cam(2), fb);
    expect(fb.focusScreenX).toBe(420); // 400 + 10 * 2
    // centre y = 300 - 20 * 2 = 260; bracket half = (10 + 8 pad) * 2 = 36
    expect(fb.focusScreenY).toBe(224);
    expect(fb.focusScreenDiam).toBe(40);
    expect(fb.focusOnScreen).toBe(true);
    expect(fb.selCentroidScreenX).toBeNaN();
  });

  it('far zoom: bracket keeps its minimum size and the diameter goes icon-only', () => {
    const fb = selectionTagFeedbackInit();
    writeSelectionTag(mirror([[5, drone(0, 0, 10)]]), 'swarm-5', new Set(), cam(0.05), fb);
    expect(fb.focusScreenY).toBe(300 - MIN_HALF_PX);
    expect(fb.focusScreenDiam).toBeCloseTo(1);
    expect(isIconOnly(fb.focusScreenDiam, false)).toBe(true);
  });

  it('focus far off screen → focusOnScreen false; a gone focus clears the anchor', () => {
    const fb = selectionTagFeedbackInit();
    writeSelectionTag(mirror([[5, drone(5000, 0, 10)]]), 'swarm-5', new Set(), cam(1), fb);
    expect(fb.focusOnScreen).toBe(false);
    expect(fb.focusScreenX).toBe(5400);
    writeSelectionTag(mirror([]), 'swarm-5', new Set(), cam(1), fb);
    expect(fb.focusScreenX).toBeNaN();
    expect(fb.focusScreenDiam).toBe(0);
    expect(fb.focusOnScreen).toBe(false);
  });

  it('a bracket overlapping the viewport edge still counts as on screen', () => {
    const fb = selectionTagFeedbackInit();
    // centre 20 px left of the canvas; bracket half = 20 + 8 = 28 px reaches in
    writeSelectionTag(mirror([[5, drone(-420, 0, 20)]]), 'swarm-5', new Set(), cam(1), fb);
    expect(fb.focusScreenX).toBe(-20);
    expect(fb.focusOnScreen).toBe(true);
  });

  it('projects the selected fleet centroid, skipping ids that do not resolve', () => {
    const fb = selectionTagFeedbackInit();
    const m = mirror([[1, drone(0, 0, 10)], [2, drone(100, 50, 10)]]);
    writeSelectionTag(m, null, new Set(['swarm-1', 'swarm-2', 'swarm-99']), cam(2), fb);
    expect(fb.selCentroidScreenX).toBe(500); // 400 + 50 * 2
    expect(fb.selCentroidScreenY).toBe(250); // 300 - 25 * 2
    expect(fb.selCentroidOnScreen).toBe(true);
    expect(fb.focusScreenX).toBeNaN();
    writeSelectionTag(m, null, new Set(['swarm-99']), cam(2), fb);
    expect(fb.selCentroidScreenX).toBeNaN();
    expect(fb.selCentroidOnScreen).toBe(false);
  });

  it('centroid off screen → selCentroidOnScreen false', () => {
    const fb = selectionTagFeedbackInit();
    writeSelectionTag(mirror([[1, drone(0, 1000, 10)]]), null, new Set(['swarm-1']), cam(1), fb);
    expect(fb.selCentroidScreenY).toBe(-700);
    expect(fb.selCentroidOnScreen).toBe(false);
  });

  it('copySelectionTagFeedback carries every tag field (worker FEEDBACK path)', () => {
    const src: SelectionTagFeedback = {
      focusScreenX: 1, focusScreenY: 2, focusOnScreen: true, focusScreenDiam: 3,
      selCentroidScreenX: 4, selCentroidScreenY: 5, selCentroidOnScreen: true,
    };
    const dst = selectionTagFeedbackInit();
    copySelectionTagFeedback(dst, src);
    expect(dst).toEqual(src);
  });
});
