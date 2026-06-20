/**
 * Per-edge flow MATERIAL → connector tint (Phase 3 WS-D / PR2 / #12; Invariant
 * #13 — failing test FIRST).
 *
 * The grid pulse now tags each flashed edge with its flow material
 * (minerals / repair / construction). The client maps it to a connector tint:
 *   - minerals     → orange (the existing CONNECTOR_MINERAL_COLOR)
 *   - repair       → green  (healing)
 *   - construction → cyan   (building)
 *   - idle (no flash) → muted blue (unchanged)
 *
 * `connectorVisualInto` gains a trailing `material` param (defaults to
 * 'minerals' for byte-identical back-compat). Before the fix the param doesn't
 * exist, so the green/cyan tint assertions read the orange mineral colour.
 */
import { describe, it, expect } from 'vitest';
import {
  connectorVisualInto,
  CONNECTOR_IDLE_COLOR,
  CONNECTOR_MINERAL_COLOR,
  CONNECTOR_REPAIR_COLOR,
  CONNECTOR_CONSTRUCTION_COLOR,
  type ConnectorVisual,
} from './connectorVisual.js';
import { FLASH_DURATION_MS } from '../../../core/structures/structureGridConstants.js';

const blank = (): ConnectorVisual => ({
  color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0,
  pulseActive: false, pulseT: 0, pulseColor: 0, pulseAlpha: 0, pulseWidth: 0,
});

describe('connectorVisualInto — per-edge material tint (WS-D #12)', () => {
  const now = 1000;
  const flashUntil = now + FLASH_DURATION_MS;

  it('repair flow → GREEN healing tint (distinct from mineral orange + idle blue)', () => {
    const v = connectorVisualInto(blank(), flashUntil, now, 1, 0, 'repair');
    expect(v.color).toBe(CONNECTOR_REPAIR_COLOR);
    expect(v.color).not.toBe(CONNECTOR_MINERAL_COLOR);
    expect(v.color).not.toBe(CONNECTOR_IDLE_COLOR);
    expect(v.pulseActive).toBe(true); // still flowing
  });

  it('construction flow → CYAN building tint', () => {
    const v = connectorVisualInto(blank(), flashUntil, now, 1, 0, 'construction');
    expect(v.color).toBe(CONNECTOR_CONSTRUCTION_COLOR);
    expect(v.color).not.toBe(CONNECTOR_MINERAL_COLOR);
    expect(v.color).not.toBe(CONNECTOR_REPAIR_COLOR);
  });

  it('minerals flow → the existing orange (default, back-compat)', () => {
    const explicit = connectorVisualInto(blank(), flashUntil, now, 1, 0, 'minerals');
    expect(explicit.color).toBe(CONNECTOR_MINERAL_COLOR);
    // Omitting the material defaults to minerals (byte-identical to pre-WS-D).
    const defaulted = connectorVisualInto(blank(), flashUntil, now, 1, 0);
    expect(defaulted.color).toBe(CONNECTOR_MINERAL_COLOR);
  });

  it('IDLE (no flash) is muted blue regardless of the material arg', () => {
    const v = connectorVisualInto(blank(), /*flashUntil*/ 0, now, 1, 0, 'repair');
    expect(v.color).toBe(CONNECTOR_IDLE_COLOR);
    expect(v.pulseActive).toBe(false);
  });

  it('the three active tints are mutually distinct', () => {
    expect(CONNECTOR_REPAIR_COLOR).not.toBe(CONNECTOR_MINERAL_COLOR);
    expect(CONNECTOR_REPAIR_COLOR).not.toBe(CONNECTOR_CONSTRUCTION_COLOR);
    expect(CONNECTOR_CONSTRUCTION_COLOR).not.toBe(CONNECTOR_MINERAL_COLOR);
  });
});
