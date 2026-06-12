import { describe, it, expect } from 'vitest';
import {
  connectorVisualParams,
  connectorVisualInto,
  cometSegment,
  previewLineVisualParams,
  CONNECTOR_IDLE_COLOR,
  CONNECTOR_MINERAL_COLOR,
  CONNECTOR_FLOW_PULSE_COLOR,
  CONNECTOR_PULSE_PERIOD_MS,
  PREVIEW_OK_COLOR,
  PREVIEW_BLOCKED_COLOR,
  PREVIEW_OVERFLOW_COLOR,
  type ConnectorVisual,
  type CometSegment,
} from './connectorVisual.js';
import { FLASH_DURATION_MS } from '../../../core/structures/structureGridConstants.js';

const blankVisual = (): ConnectorVisual => ({
  color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0,
  pulseActive: false, pulseT: 0, pulseColor: 0, pulseAlpha: 0, pulseWidth: 0,
});

describe('connectorVisualParams', () => {
  it('idle (no flash) → muted blue, low alpha, thin, no glow', () => {
    const v = connectorVisualParams(/*flashUntil*/ 0, /*now*/ 1000, /*scale*/ 1);
    expect(v.color).toBe(CONNECTOR_IDLE_COLOR);
    expect(v.alpha).toBeCloseTo(0.3, 6);
    expect(v.glowAlpha).toBe(0);
    expect(v.width).toBeGreaterThanOrEqual(1);
  });

  it('just-flashed (flashProgress≈0) → mineral colour, bright, thick, full glow', () => {
    const now = 1000;
    const v = connectorVisualParams(now + FLASH_DURATION_MS, now, 1);
    expect(v.color).toBe(CONNECTOR_MINERAL_COLOR);
    expect(v.alpha).toBeCloseTo(0.9, 4); // 0.9 - 0*0.5
    expect(v.glowAlpha).toBeCloseTo(0.3, 4); // (1-0)*0.3
    expect(v.glowWidth).toBeCloseTo(v.width * 3, 6);
  });

  it('mid-flash fades alpha + glow toward idle', () => {
    const now = 1000;
    // Halfway through the flash window.
    const v = connectorVisualParams(now + FLASH_DURATION_MS / 2, now, 1);
    expect(v.alpha).toBeCloseTo(0.9 - 0.5 * 0.5, 4); // 0.65
    expect(v.glowAlpha).toBeCloseTo(0.5 * 0.3, 4); // 0.15
  });

  it('line widths scale with zoom (≥ 1 device px)', () => {
    const idleZoomedOut = connectorVisualParams(0, 1000, 0.25);
    expect(idleZoomedOut.width).toBeCloseTo(4, 6); // max(1/0.25, 1) = 4
    const idleZoomedIn = connectorVisualParams(0, 1000, 4);
    expect(idleZoomedIn.width).toBe(1); // max(1/4, 1) = 1
  });
});

describe('connectorVisualInto — directional flow pulse (R2.2)', () => {
  it('writes INTO the passed struct (no allocation) and returns it', () => {
    const out = blankVisual();
    const r = connectorVisualInto(out, 0, 1000, 1);
    expect(r).toBe(out); // same reference — reused scratch, invariant #14
  });

  it('idle (now ≥ flashUntil) → no pulse, idle base', () => {
    const v = connectorVisualInto(blankVisual(), /*flashUntil*/ 0, /*now*/ 1000, 1);
    expect(v.color).toBe(CONNECTOR_IDLE_COLOR);
    expect(v.pulseActive).toBe(false);
    expect(v.pulseAlpha).toBe(0);
  });

  it('flowing → pulse active in the distinct flow-pulse colour, base brightens', () => {
    const now = 1000;
    const v = connectorVisualInto(blankVisual(), now + FLASH_DURATION_MS, now, 1);
    expect(v.color).toBe(CONNECTOR_MINERAL_COLOR); // base brighten (unchanged)
    expect(v.pulseActive).toBe(true);
    expect(v.pulseColor).toBe(CONNECTOR_FLOW_PULSE_COLOR);
    expect(v.pulseColor).not.toBe(v.color); // comet is a DISTINCT tint
    expect(v.pulseAlpha!).toBeGreaterThan(0);
  });

  it('pulse phase advances with time and shifts by phaseOffset', () => {
    const flashUntil = 1_000_000;
    const a = connectorVisualInto(blankVisual(), flashUntil, 0, 1, 0).pulseT!;
    const b = connectorVisualInto(blankVisual(), flashUntil, CONNECTOR_PULSE_PERIOD_MS / 4, 1, 0).pulseT!;
    expect(b).toBeGreaterThan(a); // quarter-period later ⇒ further along
    // A phaseOffset of 0.25 at t=0 lands at the same phase as a quarter-period.
    const c = connectorVisualInto(blankVisual(), flashUntil, 0, 1, 0.25).pulseT!;
    expect(c).toBeCloseTo(0.25, 6);
  });
});

describe('cometSegment — travels source→dest (R2.2 direction lock)', () => {
  const mid = (c: CometSegment) => (c.x0 + c.x1) / 2;
  const out: CometSegment = { x0: 0, y0: 0, x1: 0, y1: 0 };

  it('sourceIsLo: small phase sits near the LOW endpoint, large phase near the HIGH', () => {
    const near = mid(cometSegment(out, 0.1, true, 0, 0, 100, 0, 1));
    const far = mid(cometSegment(out, 0.9, true, 0, 0, 100, 0, 1));
    expect(near).toBeLessThan(far); // comet moved a → b as phase advanced
    expect(near).toBeLessThan(50);
    expect(far).toBeGreaterThan(50);
  });

  it('source is the HIGH endpoint ⇒ direction REVERSES (b → a)', () => {
    const near = mid(cometSegment(out, 0.1, false, 0, 0, 100, 0, 1));
    const far = mid(cometSegment(out, 0.9, false, 0, 0, 100, 0, 1));
    expect(near).toBeGreaterThan(far); // reversed: small phase near b, large near a
    expect(near).toBeGreaterThan(50);
    expect(far).toBeLessThan(50);
  });
});

describe('previewLineVisualParams (WS-5 R2.17)', () => {
  it('ok → green, visible, glowing', () => {
    const v = previewLineVisualParams('ok', 1);
    expect(v.color).toBe(PREVIEW_OK_COLOR);
    expect(v.alpha).toBeGreaterThan(0);
    expect(v.glowAlpha).toBeGreaterThan(0);
  });

  it('overflow → a DISTINCT red (≠ ok green, ≠ blocked red), drawn', () => {
    const v = previewLineVisualParams('overflow', 1);
    expect(v.color).toBe(PREVIEW_OVERFLOW_COLOR);
    expect(v.color).not.toBe(PREVIEW_OK_COLOR);
    expect(v.color).not.toBe(PREVIEW_BLOCKED_COLOR);
    expect(v.alpha).toBeGreaterThan(0); // unlike 'skip', overflow IS drawn
  });

  it('blocked → dim red, no glow', () => {
    const v = previewLineVisualParams('blocked', 1);
    expect(v.color).toBe(PREVIEW_BLOCKED_COLOR);
    expect(v.glowAlpha).toBe(0);
  });

  it('skip → alpha 0 (not drawn)', () => {
    const v = previewLineVisualParams('skip', 1);
    expect(v.alpha).toBe(0);
    expect(v.width).toBe(0);
  });
});
