import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WarpInWarningBanner, severityForRelation } from './WarpInWarningBanner';
import { useUIStore } from '../state/store';

describe('WarpInWarningBanner (wave-system Phase 5 + WS-11 R2.21)', () => {
  beforeEach(() => {
    // Force HUD-visible (not loading) + clear any prior warnings.
    useUIStore.setState({ loadingCosmeticOnly: true, warpWarnings: [] });
  });
  afterEach(() => cleanup());

  // P3.9 — the banner is ALWAYS MOUNTED and its idle state is VISIBLE: when
  // there are no incoming warps it shows a "nothing incoming" chip with TEXT,
  // not an invisible empty <Box> (the R2.21 idle the user "never saw").
  it('renders a VISIBLE idle chip (always-mounted) when there are no warnings', () => {
    render(<WarpInWarningBanner />);
    const banner = screen.getByTestId('warp-warning-banner');
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('data-warning-active')).toBe('0');
    const idle = screen.getByTestId('warp-warning-idle');
    expect(idle).not.toBeNull();
    // The idle readout must carry visible text (pre-fix it was an empty Box,
    // so this FAILS on that code).
    expect((idle.textContent ?? '').toLowerCase()).toMatch(/incoming|clear|nothing/);
    expect(screen.queryByTestId('warp-warning')).toBeNull();
  });

  // P3.9 — the banner does NOT unmount during the load curtain (it dropped its
  // `useShouldRenderHud` gate): even with the HUD marked not-visible it renders.
  it('stays mounted even when the HUD is not in its visible state', () => {
    useUIStore.setState({ loadingCosmeticOnly: false });
    render(<WarpInWarningBanner />);
    expect(screen.getByTestId('warp-warning-banner')).not.toBeNull();
    expect(screen.getByTestId('warp-warning-idle')).not.toBeNull();
  });

  // R2.21 — a hostile drone wave (the default relation) reads RED (error).
  it('colours a hostile warning RED (default relation, MuiAlert error)', () => {
    useUIStore.getState().addWarpWarning({
      id: 'squad-0',
      label: 'Legionnaire',
      count: 8,
      countdownMs: 300_000,
    });
    render(<WarpInWarningBanner />);
    const el = screen.getByTestId('warp-warning');
    expect(el.getAttribute('data-warning-relation')).toBe('hostile');
    // The MUI Alert reflects severity="error" via its standardError class.
    expect(el.className).toContain('MuiAlert-standardError');
    expect(screen.getByTestId('warp-warning-banner').getAttribute('data-warning-active')).toBe('1');
  });

  // R2.21 — relation maps to colour: neutral→amber(warning), friendly→green(success).
  it('colours neutral amber and friendly green', () => {
    const now = (globalThis.performance ?? Date).now();
    useUIStore.setState({
      warpWarnings: [
        { id: 'n1', label: 'Ace', count: 1, countdownMs: 60_000, observedAtMs: now, relation: 'neutral' },
        { id: 'f1', label: 'Wing', count: 2, countdownMs: 60_000, observedAtMs: now, relation: 'friendly' },
      ],
    });
    render(<WarpInWarningBanner />);
    const els = screen.getAllByTestId('warp-warning');
    const byId = new Map(els.map((e) => [e.getAttribute('data-warning-id'), e]));
    expect(byId.get('n1')!.className).toContain('MuiAlert-standardWarning');
    expect(byId.get('f1')!.className).toContain('MuiAlert-standardSuccess');
  });

  it('severityForRelation maps the enum to MUI colours', () => {
    expect(severityForRelation('hostile')).toBe('error');
    expect(severityForRelation('neutral')).toBe('warning');
    expect(severityForRelation('friendly')).toBe('success');
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
