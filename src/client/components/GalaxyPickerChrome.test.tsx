/**
 * Locks the GalaxyPickerChrome contract (single-canvas refactor, Step 4).
 * This is the post-auth spawn chrome with its OWN Pixi surface removed —
 * it overlays the shared gameplay canvas. The regression risks it guards:
 *   - a load-bearing testid disappears (E2E specs probe galaxy-map-screen,
 *     limbo-resume-banner/data-limbo-sector-key, hangar-window),
 *   - the imperative apiRef.openForSector → popover → "Join the fight" →
 *     Hangar → onSpawnNewShip spawn flow breaks (Equinox Phase 7 / Item 4:
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
    expect(screen.queryByTestId('hangar-window')).not.toBeInTheDocument();

    // Equinox Phase 9 (item 2) — a tap SELECTS the sector → the docked drawer,
    // NOT the ship picker directly.
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('sector-drawer-join')).toBeInTheDocument();

    // "Join the fight" opens the kind-picker for that sector.
    fireEvent.click(screen.getByTestId('sector-drawer-join'));
    expect(screen.getByTestId('hangar-window')).toBeInTheDocument();
    // Title carries the tapped sector's name.
    expect(screen.getByTestId('hangar-window')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('hangar-launch'));
    expect(onSpawnNewShip).toHaveBeenCalledTimes(1);
    expect(onSpawnNewShip.mock.calls[0][1]).toBe('sol-prime');
  });

  it('logged out: Join opens the Hangar; Sign in stashes sector + hull, and resumeGatedJoin reopens it with that hull', () => {
    useAuthStore.setState({ user: null, token: null, guest: false });
    useUIStore.setState({ phase: 'galaxy-map', pendingPickSector: null, selectedShipKind: 'fighter' });
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    fireEvent.click(screen.getByTestId('sector-drawer-join'));
    // No detour at Join: the Hangar opens, and its footer asks for sign-in.
    expect(screen.getByTestId('hangar-window')).toBeInTheDocument();
    expect(useUIStore.getState().phase).toBe('galaxy-map');
    expect(screen.queryByTestId('hangar-launch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ship-card-scout').querySelector('button')!);
    fireEvent.click(screen.getByTestId('hangar-signin'));
    expect(useUIStore.getState().phase).toBe('auth');
    expect(useUIStore.getState().pendingPickSector).toBe('sol-prime');
    // Login re-loads the account's saved kind; the stash wins on return.
    useUIStore.setState({ selectedShipKind: 'fighter' });
    act(() => { apiRef.current?.resumeGatedJoin('sol-prime'); });
    expect(screen.getByTestId('hangar-window')).toBeInTheDocument();
    expect(useUIStore.getState().selectedShipKind).toBe('scout');
    expect(screen.getByTestId('ship-card-scout')).toHaveAttribute('data-selected', '1');
  });

  it('logged out: Play as guest remembers the choice and launches the picked hull', () => {
    useAuthStore.setState({ user: null, token: null, guest: false });
    useUIStore.setState({ phase: 'galaxy-map', pendingPickSector: null });
    const apiRef = { current: null as GalaxyPickerApi | null };
    const onSpawnNewShip = vi.fn();
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} onSpawnNewShip={onSpawnNewShip} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    fireEvent.click(screen.getByTestId('sector-drawer-join'));
    fireEvent.click(screen.getByTestId('ship-card-scout').querySelector('button')!);
    fireEvent.click(screen.getByTestId('hangar-guest'));
    expect(useAuthStore.getState().guest).toBe(true);
    expect(onSpawnNewShip).toHaveBeenCalledWith('scout', 'sol-prime');
    expect(useUIStore.getState().phase).toBe('galaxy-map');
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
    expect(screen.queryByTestId('hangar-window')).not.toBeInTheDocument();
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

  it('Quick launch (stage 7): one tap glides to the safest sector (hot front among hostile-free ones), then a guest Fighter launches there', () => {
    vi.useFakeTimers();
    try {
      useAuthStore.setState({ user: null, token: null, guest: false });
      useUIStore.setState({ galaxyStatsLoaded: true, selectedShipKind: 'scout' });
      act(() => {
        useUIStore.getState().setGalaxyStats([
          { key: 'sol-prime', players: 6, enemies: 2, neutrals: 0, structures: 0, owner: null },
          { key: 'orion-belt', players: 1, enemies: 0, neutrals: 0, structures: 0, owner: null,
            control: { holder: 'a', holderShare: 0.55, challenger: 'b', challengerShare: 0.45, trend: -1, threat: 3, flippedAtMs: null, locked: false } } as never,
        ]);
      });
      const onSpawnNewShip = vi.fn();
      const onFocusChange = vi.fn();
      render(<GalaxyPickerChrome activeLimboSectorKey={null} onSpawnNewShip={onSpawnNewShip} onFocusChange={onFocusChange} />);
      const btn = screen.getByTestId('galaxy-quick-launch');
      expect(btn).toHaveAttribute('data-target', 'orion-belt');
      fireEvent.click(btn);
      // Signed out: the guest choice is remembered; the map glides in first.
      expect(useAuthStore.getState().guest).toBe(true);
      expect(onFocusChange).toHaveBeenLastCalledWith('orion-belt');
      expect(onSpawnNewShip).not.toHaveBeenCalled();
      expect(screen.getByTestId('galaxy-quick-launch')).toHaveTextContent(/Warping into/);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(onSpawnNewShip).toHaveBeenCalledWith('fighter', 'orion-belt');
      expect(useUIStore.getState().selectedShipKind).toBe('fighter');
    } finally {
      vi.useRealTimers();
      useUIStore.setState({ galaxyStatsLoaded: false });
    }
  });

  it('Quick launch is hidden on the in-game warp map and while a sector is selected', () => {
    useUIStore.setState({ galaxyStatsLoaded: true });
    act(() => { useUIStore.getState().setGalaxyStats([{ key: 'sol-prime', players: 1, enemies: 0, neutrals: 0, structures: 0, owner: null }]); });
    const { unmount } = render(<GalaxyPickerChrome activeLimboSectorKey={null} context="warp" />);
    expect(screen.queryByTestId('galaxy-quick-launch')).not.toBeInTheDocument();
    unmount();
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    expect(screen.getByTestId('galaxy-quick-launch')).toBeInTheDocument();
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.queryByTestId('galaxy-quick-launch')).not.toBeInTheDocument();
    useUIStore.setState({ galaxyStatsLoaded: false });
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
    expect(breakdown).toHaveTextContent('pilots');         // players → the PILOTS stat
    expect(breakdown).toHaveTextContent('hostiles');
    expect(breakdown).toHaveTextContent('neutral drones');
    expect(breakdown).toHaveTextContent('structures');
  });
});

// Reset the shared Zustand galaxyStats so the injected slice above doesn't leak.
afterEach(() => {
  useUIStore.getState().setGalaxyStats([]);
  useAuthStore.setState({ guest: false });
});
