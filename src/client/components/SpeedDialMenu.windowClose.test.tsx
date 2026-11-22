/**
 * Opening a game window closes the speed dial (phone stills, 2026-11-20).
 *
 * Symptom: a building settings window opened while the dial's build menu
 * stayed open underneath, poking out under the window's edge.
 *
 * Fix: GameWindow announces each open (onGameWindowOpen) and the dial and the
 * Build sidebar close on it. The sidebar and the settings panel never show
 * together (one right panel at a time).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { GameWindow } from './GameWindow.js';
import { StructureSettingsModal } from './StructureSettingsModal.js';
import { requestBuildSidebar } from './BuildSidebar.js';

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

const sidebarOpen = (): boolean => screen.queryByTestId('build-rail') !== null;

describe('SpeedDialMenu closes when a game window opens', () => {
  beforeEach(() => {
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, isGalaxyMapOpen: false, buildMode: false, placementKind: null });
  });

  it('closes the open dial when a GameWindow opens', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(fabExpanded()).toBe('true');
    act(() => openWindow());
    expect(screen.getByTestId('test-window')).toBeTruthy();
    expect(fabExpanded()).toBe('false');
  });

  it('closes the Build sidebar when a GameWindow opens', () => {
    render(<Harness />);
    act(() => useUIStore.getState().setBuildMode(true));
    expect(sidebarOpen()).toBe(true);
    act(() => openWindow());
    expect(sidebarOpen()).toBe(false);
  });

  it('closes the placing strip when a GameWindow opens', () => {
    render(<Harness />);
    act(() => useUIStore.getState().setBuildMode(true));
    fireEvent.click(screen.getByTestId('build-cat-economy'));
    fireEvent.click(screen.getByTestId('build-solar').querySelector('button')!);
    expect(screen.getByTestId('build-strip')).toBeTruthy();
    act(() => openWindow());
    expect(screen.queryByTestId('build-strip')).toBeNull();
    expect(useUIStore.getState().placementKind).toBe('solar');
    act(() => useUIStore.setState({ placementKind: null }));
  });

  it('leaves a closed dial closed when a window opens', () => {
    render(<Harness />);
    act(() => openWindow());
    expect(fabExpanded()).toBe('false');
  });

  it('one right panel at a time: settings closes Build, and Build closes settings', () => {
    let openPanel: () => void = () => {};
    let panelOpen = false;
    function PanelHarness(): JSX.Element {
      const [open, setOpen] = useState(false);
      openPanel = () => setOpen(true);
      panelOpen = open;
      return (
        <>
          <SpeedDialMenu />
          {open && <StructureSettingsModal open entityId={1} title="Refinery" onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<PanelHarness />);
    act(() => useUIStore.getState().setBuildMode(true));
    expect(sidebarOpen()).toBe(true);
    act(() => openPanel());
    expect(screen.getByTestId('structure-settings')).toBeTruthy();
    expect(sidebarOpen()).toBe(false);
    expect(panelOpen).toBe(true);

    // Build opening (here: a Build tap while in Build) closes the settings panel.
    act(() => requestBuildSidebar());
    expect(sidebarOpen()).toBe(true);
    expect(panelOpen).toBe(false);
    expect(useUIStore.getState().structureSettingsOpen).toBe(false);
  });
});
