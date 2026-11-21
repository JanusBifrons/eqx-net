/**
 * The ship-speed telegraph (Stop / ⅓ / ⅔ / Full) is a Command control, never
 * a Fly one (owner, 2026-11-21: Fly is manual piloting only). Fly hides it for
 * every hull, capitals included.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { HelmPanel } from './HelmPanel.js';

function inGame(pilotMode: 'pilot' | 'spectator', buildMode = false): void {
  useUIStore.setState({ phase: 'game', travelling: true, helmAvailable: true, helmActive: false, helmSpeed: 3, pilotMode, buildMode });
}

afterEach(() => {
  cleanup();
  useUIStore.setState({ pilotMode: 'pilot', buildMode: false, helmAvailable: false, travelling: false });
});

describe('HelmPanel', () => {
  it('is hidden in Fly, even when the ship takes helm orders', () => {
    inGame('pilot');
    render(<HelmPanel />);
    expect(screen.queryByTestId('helm-panel')).toBeNull();
  });

  it('shows in Command', () => {
    inGame('spectator');
    render(<HelmPanel />);
    expect(screen.getByTestId('helm-panel')).toBeTruthy();
  });

  it('is hidden in Build', () => {
    inGame('spectator', true);
    render(<HelmPanel />);
    expect(screen.queryByTestId('helm-panel')).toBeNull();
  });
});
