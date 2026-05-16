import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ShieldHullBar, hullColor } from './ShieldHullBar.js';
import { useUIStore } from '../state/store.js';

/**
 * Phase 8 lock — the tiny shield+hull HUD widget. Asserts the E2E hook
 * attributes track Zustand and the hull colour thresholds (green/amber/
 * red). The width CSS-transition (the locked "client tweens the bar")
 * is a style concern not asserted here; the discrete-anchor wiring is
 * locked in store.shield.test.ts + shieldHull.test.ts.
 */
describe('ShieldHullBar (Phase 8)', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ shieldPct: 100, hullPct: 100 });
  });

  it('exposes rounded shield/hull pct as E2E data attributes', () => {
    useUIStore.setState({ shieldPct: 73.4, hullPct: 19.8 });
    const { getByTestId } = render(<ShieldHullBar />);
    const root = getByTestId('shield-hull-bar');
    expect(root.getAttribute('data-shield-pct')).toBe('73');
    expect(root.getAttribute('data-hull-pct')).toBe('20');
  });

  it('hullColor: green > 50, amber 26-50, red <= 25', () => {
    expect(hullColor(100)).toBe('#44dd55');
    expect(hullColor(51)).toBe('#44dd55');
    expect(hullColor(50)).toBe('#ffbb33');
    expect(hullColor(26)).toBe('#ffbb33');
    expect(hullColor(25)).toBe('#ff4444');
    expect(hullColor(0)).toBe('#ff4444');
  });

  it('renders the SHLD and HULL captions', () => {
    const { getByText } = render(<ShieldHullBar />);
    expect(getByText('SHLD')).toBeTruthy();
    expect(getByText('HULL')).toBeTruthy();
  });
});
