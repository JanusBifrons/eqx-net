/**
 * Placement-preview connector RESTYLE (Phase 3 WS-D / PR1 / #6; Invariant #13 —
 * failing test FIRST).
 *
 * The placement preview used to draw every would-connect hub as SOLID green and
 * the over-cap remainder as RED "overflow". The new semantics (the user's "show
 * which one WILL connect vs which COULD"):
 *   - SOLID green   → the hub(s) that WILL connect on confirm (within the cap)   ('selected')
 *   - DOTTED green   → in-range, legal, but past the multi-connect cap (won't link) ('deferred')
 *   - RED            → can't connect at all (LOS / range / capacity)              ('blocked')
 *
 * Pixi v8 has no native dashed stroke, so a 'deferred' line is emitted as short
 * segments — `previewLineVisualParams('deferred', …)` carries a `dash` pattern
 * (on/off world-unit lengths) the renderer walks. This locks the PURE params:
 * the discriminants exist, 'selected' is solid green, 'deferred' is dotted green
 * with a positive dash pattern, and they are visually distinguishable.
 */
import { describe, it, expect } from 'vitest';
import {
  previewLineVisualParams,
  PREVIEW_OK_COLOR,
  PREVIEW_DEFERRED_COLOR,
  type PreviewLineKind,
} from './connectorVisual.js';

describe('previewLineVisualParams — selected vs deferred (WS-D PR1 / #6)', () => {
  it("'selected' → SOLID green, no dash (the hub that WILL connect)", () => {
    const v = previewLineVisualParams('selected', 1);
    expect(v.color).toBe(PREVIEW_OK_COLOR);
    expect(v.alpha).toBeGreaterThan(0);
    expect(v.glowAlpha).toBeGreaterThan(0); // solid lines glow
    // A solid line has no dash pattern (undefined or zero-length).
    expect(v.dash === undefined || v.dash.on <= 0).toBe(true);
  });

  it("'deferred' → DOTTED green with a positive dash pattern (could-but-won't)", () => {
    const v = previewLineVisualParams('deferred', 1);
    // Green family (it's a legal in-range pairing that just lost the cap race),
    // distinct from the solid 'selected' green so the player reads "deferred".
    expect(v.color).toBe(PREVIEW_DEFERRED_COLOR);
    expect(v.alpha).toBeGreaterThan(0); // unlike 'skip', it IS drawn
    // The dash pattern is what makes it dotted (Pixi v8 has no native dash).
    expect(v.dash).toBeDefined();
    expect(v.dash!.on).toBeGreaterThan(0);
    expect(v.dash!.off).toBeGreaterThan(0);
  });

  it("'selected' and 'deferred' are visually distinguishable (solid vs dotted)", () => {
    const sel = previewLineVisualParams('selected', 1);
    const def = previewLineVisualParams('deferred', 1);
    // Either a different tint OR a dash pattern distinguishes them; we use BOTH.
    expect(def.dash).toBeDefined();
    expect(sel.dash === undefined || sel.dash.on <= 0).toBe(true);
  });

  it('the dash on/off lengths stay ~constant on screen (scale-aware)', () => {
    // Like line widths, the dash segments divide by zoom so a dotted line reads
    // the same density at any zoom.
    const zoomedOut = previewLineVisualParams('deferred', 0.5).dash!;
    const zoomedIn = previewLineVisualParams('deferred', 4).dash!;
    expect(zoomedOut.on).toBeGreaterThan(zoomedIn.on);
  });

  it('back-compat: ok / overflow / blocked / skip still resolve', () => {
    for (const k of ['ok', 'overflow', 'blocked', 'skip'] as PreviewLineKind[]) {
      const v = previewLineVisualParams(k, 1);
      expect(Number.isFinite(v.alpha)).toBe(true);
    }
  });
});
