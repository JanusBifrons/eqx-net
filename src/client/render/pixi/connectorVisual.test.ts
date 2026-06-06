import { describe, it, expect } from 'vitest';
import {
  connectorVisualParams,
  CONNECTOR_IDLE_COLOR,
  CONNECTOR_MINERAL_COLOR,
} from './connectorVisual.js';
import { FLASH_DURATION_MS } from '../../../core/structures/structureGridConstants.js';

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
