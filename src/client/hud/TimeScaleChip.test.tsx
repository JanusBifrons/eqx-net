/**
 * Game time scale (stream step 4d): the HUD shows the sector's speed while it
 * isn't 1×, inside the status capsule (no new screen position). The value is a
 * discrete Zustand scalar written on change (#2); E2E reads `data-time-scale`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StatusCapsule, formatTimeScale } from './GameHud.js';
import { useUIStore } from '../state/store.js';

describe('HUD speed chip', () => {
  afterEach(() => { act(() => useUIStore.getState().setTimeScale(1)); });

  it('formats the speed', () => {
    expect(formatTimeScale(0.8)).toBe('0.8×');
    expect(formatTimeScale(2)).toBe('2×');
    expect(formatTimeScale(0.25)).toBe('0.25×');
    expect(formatTimeScale(0.7000001)).toBe('0.7×');
  });

  it('is hidden at 1× and shows the speed otherwise', () => {
    render(<StatusCapsule scale={1} />);
    expect(screen.getByTestId('hud-status').getAttribute('data-time-scale')).toBe('1');
    expect(screen.queryByTestId('hud-time-scale')).toBeNull();

    act(() => useUIStore.getState().setTimeScale(0.8));
    expect(screen.getByTestId('hud-time-scale').textContent).toBe('0.8×');
    expect(screen.getByTestId('hud-status').getAttribute('data-time-scale')).toBe('0.8');

    act(() => useUIStore.getState().setTimeScale(2));
    expect(screen.getByTestId('hud-time-scale').textContent).toBe('2×');
  });
});
