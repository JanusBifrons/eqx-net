import { describe, expect, it } from 'vitest';
import { cargoChanged, cargoFillState, cargoWeight, formatLootPickup } from './lootView';

describe('lootView (P1a-1)', () => {
  it('formats a pickup popup', () => {
    expect(formatLootPickup({ goods: { salvage: 7 }, blueprints: 0 })).toBe('+7 Salvage');
    expect(formatLootPickup({ goods: {}, blueprints: 1 })).toBe('+1 blueprint');
    expect(formatLootPickup({ goods: {}, blueprints: 0 })).toBe('');
  });

  it('cargoChanged detects real changes only', () => {
    const view = { goods: { salvage: 3 }, blueprints: 0 };
    expect(cargoChanged(view, { goods: { salvage: 3 }, blueprints: [] })).toBe(false);
    expect(cargoChanged(view, { goods: { salvage: 4 }, blueprints: [] })).toBe(true);
    expect(cargoChanged(view, undefined)).toBe(true);
    expect(cargoChanged(null, undefined)).toBe(false);
    expect(cargoChanged(null, { goods: { alloy: 1 }, blueprints: [] })).toBe(true);
  });

  it('weight + fill state (amber at 80 %, red when full)', () => {
    expect(cargoWeight({ goods: { salvage: 10, alloy: 5 }, blueprints: 2 })).toBe(20);
    expect(cargoFillState(10, 100)).toBe('ok');
    expect(cargoFillState(80, 100)).toBe('high');
    expect(cargoFillState(100, 100)).toBe('full');
  });
});
