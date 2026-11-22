/**
 * Warp spool bar (capital playtest S8, owner 2026-11-22): the countdown is a
 * whole number of seconds (rounded up) that counts down, and the bar draws over
 * the left strip (its anchor's z tier is above `Z.railStrip`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { LayoutProvider } from '../layout/LayoutProvider';
import { ANCHOR_STYLES } from '../layout/anchors';
import { Z } from '../layout/zIndex';
import { HyperspaceOverlay, SPOOL_BAR_ANCHOR, spoolSecondsLeft } from './HyperspaceOverlay';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  stubMedia();
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  useUIStore.setState({ transitState: 'DOCKED', transitSpoolMs: null, transitProgress: 0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useUIStore.setState({ transitState: 'DOCKED', transitSpoolMs: null, transitProgress: 0 });
});

describe('spoolSecondsLeft', () => {
  it('rounds up to whole seconds', () => {
    expect(spoolSecondsLeft(3000)).toBe(3);
    expect(spoolSecondsLeft(2999)).toBe(3);
    expect(spoolSecondsLeft(2001)).toBe(3);
    expect(spoolSecondsLeft(2000)).toBe(2);
    expect(spoolSecondsLeft(1)).toBe(1);
    expect(spoolSecondsLeft(0)).toBe(0);
    expect(spoolSecondsLeft(-5)).toBe(0);
  });
});

describe('HyperspaceOverlay spool bar', () => {
  it('shows an integer countdown that counts down', () => {
    render(<LayoutProvider><HyperspaceOverlay onCancel={() => {}} /></LayoutProvider>);
    act(() => { useUIStore.setState({ transitState: 'SPOOLING', transitSpoolMs: 3000, transitProgress: 0.25 }); });
    act(() => { vi.advanceTimersByTime(50); });
    const text = (): string => screen.getByTestId('hyperspace-countdown').textContent ?? '';
    expect(text()).toBe('3');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(text()).toBe('2');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(text()).toBe('1');
    expect(text()).toMatch(/^\d+$/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(text()).toBe('0');
    // The hidden progress attribute is unchanged.
    expect(screen.getByTestId('hyperspace-fill').getAttribute('data-progress')).toBe('0.250');
  });

  it('renders in the over-strip anchor, above the left strip', () => {
    render(<LayoutProvider><HyperspaceOverlay onCancel={() => {}} /></LayoutProvider>);
    act(() => { useUIStore.setState({ transitState: 'SPOOLING', transitSpoolMs: 3000 }); });
    const host = screen.getByTestId('hyperspace-overlay').closest('[data-anchor]');
    expect(host?.getAttribute('data-anchor')).toBe(SPOOL_BAR_ANCHOR);
    expect(SPOOL_BAR_ANCHOR).toBe('middle-left-over');
    const z = Number(ANCHOR_STYLES[SPOOL_BAR_ANCHOR].zIndex);
    expect(z).toBe(Z.overStrip);
    expect(z).toBeGreaterThan(Z.railStrip);
    expect(z).toBeLessThan(Z.drawer);
    expect(ANCHOR_STYLES['left-strip'].zIndex).toBe(Z.railStrip);
    // Same placement as middle-left; only the tier differs.
    expect({ ...ANCHOR_STYLES[SPOOL_BAR_ANCHOR], zIndex: 0 }).toEqual({ ...ANCHOR_STYLES['middle-left'], zIndex: 0 });
  });
});
