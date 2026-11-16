import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { curtainAlphaAt, LoadCurtain } from './LoadCurtain';

/**
 * WS-14 / R2.26-curtain — "ship-change briefly flashes the destination sector".
 *
 * Root cause: the load curtain was raised early (the Bug-A fix) but its RISE was
 * a 200 ms alpha tween, so for that window it was semi-transparent — and the
 * destination sector's first frame rendered sooner, flashing through. The fix
 * makes the curtain RISE instant (opaque before any reveal) while keeping the
 * FADE-OUT (the arrival reveal) smooth.
 *
 * These assertions FAIL on the pre-fix code (rising tweened over 200 ms, so
 * `curtainAlphaAt(0, 1, 16)` was ≈ 0.08, not 1).
 */
const FADE_MS = 380; // CURTAIN_FADE_MS

describe('curtainAlphaAt — instant rise, smooth fade-out (R2.26-curtain)', () => {
  it('the RISE is instant — fully opaque immediately, no flash window', () => {
    expect(curtainAlphaAt(0, 1, 0)).toBe(1);
    expect(curtainAlphaAt(0, 1, 16)).toBe(1);
    expect(curtainAlphaAt(0.3, 1, 1)).toBe(1); // partial rise also snaps opaque
  });

  it('the FADE-OUT (arrival reveal) is smooth over the fade window', () => {
    expect(curtainAlphaAt(1, 0, 0)).toBe(1); // starts opaque
    expect(curtainAlphaAt(1, 0, FADE_MS / 2)).toBeCloseTo(0.5, 5); // mid-fade
    expect(curtainAlphaAt(1, 0, FADE_MS)).toBe(0); // fully revealed
    expect(curtainAlphaAt(1, 0, FADE_MS * 2)).toBe(0); // clamped past the window
  });

  it('a no-op (target === from) returns the target', () => {
    expect(curtainAlphaAt(1, 1, 50)).toBe(1);
    expect(curtainAlphaAt(0, 0, 50)).toBe(0);
  });
});

/**
 * The curtain owns no filter. A filter on `app.stage` renders the whole frame
 * into a non-MSAA filter texture (no antialiasing) and pays full-screen passes;
 * the old shader warp chain that used to share this class attached one.
 */
describe('LoadCurtain — never attaches a stage filter', () => {
  it('raising and lowering the curtain leaves app.stage.filters empty', () => {
    const stage = new Container();
    const app = { stage, ticker: { add: () => {}, remove: () => {} } };
    const curtain = new LoadCurtain(app as never, { warpTickMs: 0 });
    curtain.setLoadCurtain(true);
    curtain.setLoadCurtain(false);
    const attached = Array.isArray(stage.filters) ? stage.filters.length : stage.filters ? 1 : 0;
    expect(attached).toBe(0);
    expect(stage.children.length).toBe(1); // the curtain's own container
  });
});
