import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetaLandingScreen } from './MetaLandingScreen.js';
import { useUIStore } from '../state/store.js';

/**
 * RTL tests for the server-health gate on the pre-game landing screen.
 *
 * The store is reset between cases via `setServerHealth('unknown', null)`
 * + writing the field directly through the store API; the join callback
 * is a fresh `vi.fn()` per test so each case asserts in isolation.
 */
describe('MetaLandingScreen — server-health gate', () => {
  beforeEach(() => {
    useUIStore.getState().setServerHealth('unknown', null);
  });

  it('disables the Join button when serverHealth is "unknown" (initial state)', () => {
    const onJoin = vi.fn();
    render(<MetaLandingScreen onJoin={onJoin} />);
    const btn = screen.getByTestId('meta-join-button');
    expect(btn).toBeDisabled();
  });

  it('enables the Join button only when serverHealth is "healthy"', () => {
    const onJoin = vi.fn();
    useUIStore.getState().setServerHealth('healthy', 750);
    render(<MetaLandingScreen onJoin={onJoin} />);
    expect(screen.getByTestId('meta-join-button')).toBeEnabled();
  });

  it('disables the Join button + shows error banner when unreachable', () => {
    useUIStore.getState().setServerHealth('unreachable', null);
    render(<MetaLandingScreen onJoin={vi.fn()} />);
    expect(screen.getByTestId('meta-join-button')).toBeDisabled();
    const banner = screen.getByTestId('server-health-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute('data-state')).toBe('unreachable');
    expect(banner.textContent ?? '').toMatch(/unavailable/i);
  });

  it('disables the Join button + shows info banner when warming', () => {
    useUIStore.getState().setServerHealth('warming', 750);
    render(<MetaLandingScreen onJoin={vi.fn()} />);
    expect(screen.getByTestId('meta-join-button')).toBeDisabled();
    const banner = screen.getByTestId('server-health-banner');
    expect(banner.getAttribute('data-state')).toBe('warming');
    expect(banner.textContent ?? '').toMatch(/starting up/i);
  });

  it('hides the banner entirely when healthy', () => {
    useUIStore.getState().setServerHealth('healthy', 750);
    render(<MetaLandingScreen onJoin={vi.fn()} />);
    expect(screen.queryByTestId('server-health-banner')).toBeNull();
  });

  it('renders playersOnline from the store; falls back to dash when null', () => {
    useUIStore.getState().setServerHealth('healthy', 842);
    const { rerender } = render(<MetaLandingScreen onJoin={vi.fn()} />);
    expect(screen.getByTestId('meta-player-count-number').textContent).toBe('842');

    useUIStore.getState().setServerHealth('unreachable', null);
    rerender(<MetaLandingScreen onJoin={vi.fn()} />);
    expect(screen.getByTestId('meta-player-count-number').textContent).toBe('—');
  });
});
