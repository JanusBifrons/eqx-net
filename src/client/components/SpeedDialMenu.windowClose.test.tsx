/**
 * Opening a game window closes the speed dial (phone stills, 2026-11-20).
 *
 * Symptom: Build ▸ Industry ▸ place a Refinery ▸ tap it ▸ cog. The building
 * settings window (GameWindow, full screen on a phone) opened, but the dial's
 * build menu stayed open underneath and its "Silicon Works" entry poked out
 * under the window's bottom-right edge.
 *
 * Fix: GameWindow announces each open (onGameWindowOpen) and the dial folds
 * back to its closed root menu on it — the same state its own close() resets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { GameWindow } from './GameWindow.js';
import { StructureSettingsModal } from './StructureSettingsModal.js';

let openWindow: () => void = () => {};

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  openWindow = () => setOpen(true);
  return (
    <>
      <SpeedDialMenu />
      <GameWindow open={open} onClose={() => setOpen(false)} testId="test-window">
        <div>window body</div>
      </GameWindow>
    </>
  );
}

const fabExpanded = (): string | null => screen.getByTestId('speed-dial-fab').getAttribute('aria-expanded');

describe('SpeedDialMenu closes when a game window opens', () => {
  beforeEach(() => {
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, isGalaxyMapOpen: false });
  });

  it('closes the open build drill when a GameWindow opens', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    expect(fabExpanded()).toBe('true');
    expect(screen.getByTestId('speed-dial-back')).toBeTruthy();

    act(() => openWindow());

    expect(screen.getByTestId('test-window')).toBeTruthy();
    expect(fabExpanded()).toBe('false');
  });

  it('re-opens at the root menu after a window closed it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    act(() => openWindow());

    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(fabExpanded()).toBe('true');
    expect(screen.queryByTestId('speed-dial-back')).toBeNull();
    expect(screen.getByTestId('speed-dial-build')).toBeTruthy();
  });

  it('leaves a closed dial closed when a window opens', () => {
    render(<Harness />);
    act(() => openWindow());
    expect(fabExpanded()).toBe('false');
  });

  it('closes the open build drill when the building settings side panel opens', () => {
    let openPanel: () => void = () => {};
    function PanelHarness(): JSX.Element {
      const [open, setOpen] = useState(false);
      openPanel = () => setOpen(true);
      return (
        <>
          <SpeedDialMenu />
          {open && <StructureSettingsModal open entityId={1} title="Refinery" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<PanelHarness />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    expect(fabExpanded()).toBe('true');
    act(() => openPanel());
    expect(screen.getByTestId('structure-settings')).toBeTruthy();
    expect(fabExpanded()).toBe('false');
  });
});
