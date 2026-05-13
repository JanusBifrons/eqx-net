import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  LostConnectionOverlay,
  SHOW_DEBOUNCE_MS,
  HIDE_DEBOUNCE_MS,
} from './LostConnectionOverlay.js';
import { useUIStore } from '../state/store.js';

/**
 * RTL tests for the in-game lost-connection overlay.
 *
 * Two-stage gate (2026-05-13):
 *   1. `wantsVisible = connectionStatus is disconnected/error AND phase === 'game'`
 *   2. `visible` follows `wantsVisible` with a SHOW_DEBOUNCE_MS / HIDE_DEBOUNCE_MS
 *      lag — short blips don't flicker the overlay.
 *
 * The countdown timer ticks only once the overlay is `visible`.
 */
describe('LostConnectionOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUIStore.getState().setPhase('game');
    useUIStore.getState().setConnectionStatus('connected');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when connected', () => {
    render(<LostConnectionOverlay />);
    expect(screen.queryByTestId('lost-connection-overlay')).toBeNull();
  });

  it('renders nothing when disconnected outside the game phase', () => {
    useUIStore.getState().setPhase('meta');
    useUIStore.getState().setConnectionStatus('disconnected');
    render(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS + 100); });
    expect(screen.queryByTestId('lost-connection-overlay')).toBeNull();
  });

  it('does NOT render immediately on disconnect — waits for the show debounce', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    render(<LostConnectionOverlay />);
    // Just-disconnected: overlay must not be visible yet.
    expect(screen.queryByTestId('lost-connection-overlay')).toBeNull();
    // Almost-but-not-quite the debounce window: still hidden.
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS - 100); });
    expect(screen.queryByTestId('lost-connection-overlay')).toBeNull();
    // Past the debounce: now visible.
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByTestId('lost-connection-overlay')).toBeInTheDocument();
  });

  it('does NOT render at all when disconnect resolves within the show debounce (no flicker)', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    const { rerender } = render(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS - 200); });
    // Recover BEFORE the debounce expires.
    act(() => { useUIStore.getState().setConnectionStatus('connected'); });
    rerender(<LostConnectionOverlay />);
    // Run well past the original show-debounce point.
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS); });
    expect(screen.queryByTestId('lost-connection-overlay')).toBeNull();
  });

  it('keeps rendering through brief intermittent recoveries (no blink-out)', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    const { rerender } = render(<LostConnectionOverlay />);
    // Push past show debounce to make overlay visible.
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS + 100); });
    expect(screen.getByTestId('lost-connection-overlay')).toBeInTheDocument();
    // Brief recovery shorter than hide debounce — overlay stays.
    act(() => { useUIStore.getState().setConnectionStatus('connected'); });
    rerender(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(HIDE_DEBOUNCE_MS - 200); });
    expect(screen.getByTestId('lost-connection-overlay')).toBeInTheDocument();
    // Drops again — hide timer cancelled, overlay still visible.
    act(() => { useUIStore.getState().setConnectionStatus('disconnected'); });
    rerender(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(HIDE_DEBOUNCE_MS); });
    expect(screen.getByTestId('lost-connection-overlay')).toBeInTheDocument();
  });

  it('hides after a sustained recovery longer than the hide debounce', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    const { rerender } = render(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS + 100); });
    expect(screen.getByTestId('lost-connection-overlay')).toBeInTheDocument();
    // Sustained recovery.
    act(() => { useUIStore.getState().setConnectionStatus('connected'); });
    rerender(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(HIDE_DEBOUNCE_MS + 100); });
    expect(screen.queryByTestId('lost-connection-overlay')).toBeNull();
  });

  it('counts down each second once visible', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    render(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS + 100); });
    expect(screen.getByTestId('lost-connection-countdown').textContent).toMatch(/15s/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('lost-connection-countdown').textContent).toMatch(/14s/);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('lost-connection-countdown').textContent).toMatch(/11s/);
  });

  it('routes to "meta" phase when the countdown expires', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    render(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS + 100); });
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(useUIStore.getState().phase).toBe('meta');
  });

  it('routes to "meta" phase immediately when the manual button is clicked', () => {
    useUIStore.getState().setConnectionStatus('disconnected');
    render(<LostConnectionOverlay />);
    act(() => { vi.advanceTimersByTime(SHOW_DEBOUNCE_MS + 100); });
    fireEvent.click(screen.getByTestId('lost-connection-return-button'));
    expect(useUIStore.getState().phase).toBe('meta');
  });
});
