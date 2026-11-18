/**
 * Locks the GalaxyPickerChrome contract (single-canvas refactor, Step 4).
 * This is the post-auth spawn chrome with its OWN Pixi surface removed —
 * it overlays the shared gameplay canvas. The regression risks it guards:
 *   - a load-bearing testid disappears (E2E specs probe galaxy-map-screen,
 *     limbo-resume-banner/data-limbo-sector-key, ship-picker-modal),
 *   - the imperative apiRef.openForSector → popover → "Join the fight" →
 *     ship-picker → onSpawnNewShip spawn flow breaks (Equinox Phase 7 / Item 4:
 *     a tap on the selector layer opens the interactive popover, not the picker
 *     directly),
 *   - a dev button (single-player / engineering rooms) creeps back onto the
 *     public homepage (owner: dev tools are reached by direct link only).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GalaxyPickerChrome, type GalaxyPickerApi } from './GalaxyPickerChrome';
import { useUIStore } from '../state/store';
import { useAuthStore } from '../auth/authStore';

describe('GalaxyPickerChrome', () => {
  it('renders the load-bearing testids (limbo stub)', () => {
    render(<GalaxyPickerChrome activeLimboSectorKey={null} />);
    expect(screen.getByTestId('galaxy-map-screen')).toBeInTheDocument();
    const banner = screen.getByTestId('limbo-resume-banner');
    expect(banner).toHaveAttribute('data-limbo-sector-key', '');
  });

  it('shows no dev buttons on the homepage (reached by ?room= / ?local=1 link)', () => {
    render(<GalaxyPickerChrome activeLimboSectorKey={null} />);
    expect(screen.queryByTestId('single-player-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('engineering-rooms-button')).not.toBeInTheDocument();
    expect(screen.queryByText(/single-player diagnostic/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/engineering rooms/i)).not.toBeInTheDocument();
  });

  it('apiRef.openForSector opens the sector popover → Join → kind-picker → spawn fires onSpawnNewShip', () => {
    useAuthStore.setState({ guest: true });
    const apiRef = { current: null as GalaxyPickerApi | null };
    const onSpawnNewShip = vi.fn();
    render(
      <GalaxyPickerChrome
        apiRef={apiRef}
        activeLimboSectorKey={null}
        onSpawnNewShip={onSpawnNewShip}
      />,
    );
    // Drawer + picker are both closed until a sector is tapped (the drawer's
    // Join CTA only renders when a sector is selected).
    expect(screen.queryByTestId('sector-drawer-join')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ship-picker-modal')).not.toBeInTheDocument();

    // Equinox Phase 9 (item 2) — a tap SELECTS the sector → the docked drawer,
    // NOT the ship picker directly.
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('sector-drawer-join')).toBeInTheDocument();

    // "Join the fight" opens the kind-picker for that sector.
    fireEvent.click(screen.getByTestId('sector-drawer-join'));
    expect(screen.getByTestId('ship-picker-modal')).toBeInTheDocument();
    // Title carries the tapped sector's name.
    expect(screen.getByText(/Spawn in/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ship-picker-spawn'));
    expect(onSpawnNewShip).toHaveBeenCalledTimes(1);
    expect(onSpawnNewShip.mock.calls[0][1]).toBe('sol-prime');
  });

  it('logged out: Join the fight stashes the sector and goes to login; resumeGatedJoin opens its ship picker', () => {
    useAuthStore.setState({ user: null, token: null, guest: false });
    useUIStore.setState({ phase: 'galaxy-map', pendingPickSector: null });
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    fireEvent.click(screen.getByTestId('sector-drawer-join'));
    expect(screen.queryByTestId('ship-picker-modal')).not.toBeInTheDocument();
    expect(useUIStore.getState().phase).toBe('auth');
    expect(useUIStore.getState().pendingPickSector).toBe('sol-prime');
    // Back from login: the stashed Join opens the picker for that sector.
    act(() => { apiRef.current?.resumeGatedJoin('sol-prime'); });
    expect(screen.getByTestId('ship-picker-modal')).toBeInTheDocument();
  });

  it('logged out: Spectate goes to login, and resumeGatedJoin then spectates (not the picker)', () => {
    useAuthStore.setState({ user: null, token: null, guest: false });
    useUIStore.setState({ phase: 'galaxy-map', pendingPickSector: null });
    const apiRef = { current: null as GalaxyPickerApi | null };
    const onSpawnSpectator = vi.fn();
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} onSpawnSpectator={onSpawnSpectator} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    fireEvent.click(screen.getByTestId('sector-drawer-spectate'));
    expect(onSpawnSpectator).not.toHaveBeenCalled();
    expect(useUIStore.getState().phase).toBe('auth');
    act(() => { apiRef.current?.resumeGatedJoin('sol-prime'); });
    expect(onSpawnSpectator).toHaveBeenCalledWith('sol-prime');
    expect(screen.queryByTestId('ship-picker-modal')).not.toBeInTheDocument();
  });

  it('apiRef.openForSector TOGGLES — re-selecting the same sector deselects (closes the drawer)', () => {
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('sector-drawer-join')).toBeInTheDocument();
    // Re-tapping the SAME sector deselects → drawer content collapses to the
    // placeholder (Join CTA gone).
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.queryByTestId('sector-drawer-join')).not.toBeInTheDocument();
  });

  it('apiRef.deselect closes the drawer (blur / empty-space tap)', () => {
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('sector-drawer-join')).toBeInTheDocument();
    act(() => { apiRef.current?.deselect(); });
    expect(screen.queryByTestId('sector-drawer-join')).not.toBeInTheDocument();
  });

  it('sector drawer shows LABELLED counts incl. drones (Equinox Phase 8 / Bug 5)', () => {
    // Inject a live snapshot slice so the drawer has non-zero counts to label.
    act(() => {
      useUIStore.getState().setGalaxyStats([
        { key: 'sol-prime', players: 1, enemies: 2, neutrals: 8, structures: 3, owner: null },
      ]);
    });
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('sector-drawer-breakdown')).toBeInTheDocument();
    // The breakdown uses the SHARED entity badges + plain-language labels (the
    // unified visual language), so each kind is legible at a glance. Players
    // render as the ▲ ship badge.
    const breakdown = screen.getByTestId('sector-drawer-breakdown');
    expect(breakdown).toHaveTextContent('ship');           // players 1 → ship (singular)
    expect(breakdown).toHaveTextContent('hostiles');       // 2 → plural
    expect(breakdown).toHaveTextContent('neutral drones'); // 8 → plural
    expect(breakdown).toHaveTextContent('structures');     // 3 → plural
  });
});

// Reset the shared Zustand galaxyStats so the injected slice above doesn't leak.
afterEach(() => {
  useUIStore.getState().setGalaxyStats([]);
  useAuthStore.setState({ guest: false });
});
