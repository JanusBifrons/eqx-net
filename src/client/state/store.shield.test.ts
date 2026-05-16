import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store.js';

/**
 * Phase 7 lock — shieldPct is a discrete, purity-clean UI scalar (sibling
 * of hullPct). The HUD bar CSS-tweens between the anchors set here from
 * DamageEvent / ShieldEventMessage; there is NO continuous shield wire
 * traffic (locked design). This test pins the store contract.
 */
describe('store — shieldPct (Phase 7)', () => {
  beforeEach(() => {
    useUIStore.setState({ shieldPct: 100, hullPct: 100 });
  });

  it('defaults to 100 and is independent of hullPct', () => {
    expect(useUIStore.getState().shieldPct).toBe(100);
    useUIStore.getState().setHullPct(40);
    expect(useUIStore.getState().shieldPct).toBe(100); // hull change does not touch shield
    expect(useUIStore.getState().hullPct).toBe(40);
  });

  it('setShieldPct updates only shieldPct', () => {
    useUIStore.getState().setShieldPct(0);
    expect(useUIStore.getState().shieldPct).toBe(0);
    expect(useUIStore.getState().hullPct).toBe(100);
    useUIStore.getState().setShieldPct(73);
    expect(useUIStore.getState().shieldPct).toBe(73);
  });
});
