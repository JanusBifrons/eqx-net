/**
 * The status capsule's shield/hull ring is the pilot's shield toggle (owner
 * ask, playtest 2026-11-21): a tap drops the shields, a tap while dropped
 * raises them, and the ring shows DOWN while they are dropped (from the store,
 * which the own-ship snapshot slice feeds).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

const sendSetShields = vi.fn((_up: boolean) => true);
vi.mock('../net/shieldClient', () => ({ sendSetShields: (up: boolean) => sendSetShields(up) }));
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => null }));

import { StatusCapsule } from './GameHud.js';
import { useUIStore } from '../state/store.js';

function toggle(): HTMLElement {
  return document.querySelector('[data-testid="hud-shield-toggle"]') as HTMLElement;
}

describe('shield ring toggle', () => {
  beforeEach(() => {
    cleanup();
    sendSetShields.mockClear();
    useUIStore.setState({ buildMode: false, pilotMode: 'pilot', shieldsLowered: false, shieldPct: 100 });
  });

  it('a click drops the shields', () => {
    render(<StatusCapsule scale={1} />);
    expect(toggle()).not.toBeNull();
    expect(toggle().getAttribute('data-shields')).toBe('up');
    fireEvent.click(toggle());
    expect(sendSetShields).toHaveBeenCalledTimes(1);
    expect(sendSetShields).toHaveBeenCalledWith(false);
  });

  it('a touch is one fresh press: the trailing synthesized click does not double-fire', () => {
    render(<StatusCapsule scale={1} />);
    fireEvent.touchStart(toggle());
    fireEvent.click(toggle());
    expect(sendSetShields).toHaveBeenCalledTimes(1);
    expect(sendSetShields).toHaveBeenCalledWith(false);
  });

  it('shows DOWN while dropped, and a tap raises them', () => {
    useUIStore.setState({ shieldsLowered: true, shieldPct: 0 });
    const { getByText } = render(<StatusCapsule scale={1} />);
    expect(toggle().getAttribute('data-shields')).toBe('down');
    expect(getByText('DOWN')).not.toBeNull();
    fireEvent.click(toggle());
    expect(sendSetShields).toHaveBeenCalledWith(true);
  });

  it('the ring takes taps while the rest of the capsule lets them through', () => {
    render(<StatusCapsule scale={1} />);
    expect(toggle().style.pointerEvents).toBe('auto');
    expect((document.querySelector('[data-testid="hud-status"]') as HTMLElement).style.pointerEvents).toBe('none');
  });

  it('keeps its full drawn width in the layout, so the credits beside it never overlap', () => {
    render(<StatusCapsule scale={1} />);
    // The tap padding must sit outside the ring width (app CSS is border-box).
    expect(toggle().style.boxSizing).toBe('content-box');
  });

  it('puts DOWN above the ring, not inside its hole', () => {
    useUIStore.setState({ shieldsLowered: true, shieldPct: 0 });
    const { getByText } = render(<StatusCapsule scale={1} />);
    const down = getByText('DOWN') as HTMLElement;
    expect(down.style.bottom).toBe('100%');
    expect(down.style.top).toBe('');
  });
});
