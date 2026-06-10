import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WarpInWarningBanner } from './WarpInWarningBanner';
import { useUIStore } from '../state/store';

describe('WarpInWarningBanner (wave-system Phase 5)', () => {
  beforeEach(() => {
    // Force HUD-visible (not loading) + clear any prior warnings.
    useUIStore.setState({ loadingCosmeticOnly: true, warpWarnings: [] });
  });
  afterEach(() => cleanup());

  it('renders nothing when there are no warnings', () => {
    render(<WarpInWarningBanner />);
    expect(screen.queryByTestId('warp-warning-banner')).toBeNull();
  });

  it('renders a squad warning as "8 × Legionnaires"', () => {
    useUIStore.getState().addWarpWarning({
      id: 'squad-0',
      label: 'Legionnaire',
      count: 8,
      countdownMs: 300_000,
    });
    render(<WarpInWarningBanner />);
    const el = screen.getByTestId('warp-warning');
    expect(el.getAttribute('data-warning-count')).toBe('8');
    expect(el.textContent).toContain('8 × Legionnaires');
    // ~300 s remaining at first render (countdown just started).
    expect(Number(el.getAttribute('data-warning-secs'))).toBeGreaterThan(290);
  });

  it('renders a single-ship player warning without the plural "s"', () => {
    useUIStore.getState().addWarpWarning({ id: 'p1', label: 'Ace', count: 1, countdownMs: 60_000 });
    render(<WarpInWarningBanner />);
    const el = screen.getByTestId('warp-warning');
    expect(el.textContent).toContain('1 × Ace warping in');
    expect(el.textContent).not.toContain('Aces');
  });

  it('renders one banner per distinct warning', () => {
    const add = useUIStore.getState().addWarpWarning;
    add({ id: 'squad-0', label: 'Legionnaire', count: 8, countdownMs: 300_000 });
    add({ id: 'p1', label: 'Ace', count: 1, countdownMs: 60_000 });
    render(<WarpInWarningBanner />);
    expect(screen.getAllByTestId('warp-warning')).toHaveLength(2);
  });

  it('an already-elapsed warning shows 0 s', () => {
    // Stamp observedAtMs far in the past by adding with a tiny countdown.
    useUIStore.getState().addWarpWarning({ id: 'old', label: 'Legionnaire', count: 8, countdownMs: 0 });
    render(<WarpInWarningBanner />);
    const el = screen.getByTestId('warp-warning');
    expect(el.getAttribute('data-warning-secs')).toBe('0');
  });
});
