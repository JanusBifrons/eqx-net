/**
 * Locks the GalaxyPickerChrome contract (single-canvas refactor, Step 4).
 * This is the post-auth spawn chrome with its OWN Pixi surface removed —
 * it overlays the shared gameplay canvas. The regression risks it guards:
 *   - a load-bearing testid disappears (E2E specs probe galaxy-map-screen,
 *     limbo-resume-banner/data-limbo-sector-key, engineering-rooms-button,
 *     single-player-button, ship-picker-modal),
 *   - the imperative apiRef.openForSector → popover → "Join the fight" →
 *     ship-picker → onSpawnNewShip spawn flow breaks (Equinox Phase 7 / Item 4:
 *     a tap on the selector layer opens the interactive popover, not the picker
 *     directly),
 *   - the engineering-room path stops routing to onSelectRoom.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GalaxyPickerChrome, type GalaxyPickerApi } from './GalaxyPickerChrome';
import { useUIStore } from '../state/store';

describe('GalaxyPickerChrome', () => {
  it('renders the load-bearing testids (limbo stub, engineering, single-player)', () => {
    render(
      <GalaxyPickerChrome
        activeLimboSectorKey={null}
        onSelectLocal={() => {}}
      />,
    );
    expect(screen.getByTestId('galaxy-map-screen')).toBeInTheDocument();
    const banner = screen.getByTestId('limbo-resume-banner');
    expect(banner).toHaveAttribute('data-limbo-sector-key', '');
    expect(screen.getByTestId('engineering-rooms-button')).toBeInTheDocument();
    expect(screen.getByTestId('single-player-button')).toBeInTheDocument();
  });

  it('omits the single-player button when onSelectLocal is not provided', () => {
    render(<GalaxyPickerChrome activeLimboSectorKey={null} />);
    expect(screen.queryByTestId('single-player-button')).not.toBeInTheDocument();
  });

  it('apiRef.openForSector opens the sector popover → Join → kind-picker → spawn fires onSpawnNewShip', () => {
    const apiRef = { current: null as GalaxyPickerApi | null };
    const onSpawnNewShip = vi.fn();
    render(
      <GalaxyPickerChrome
        apiRef={apiRef}
        activeLimboSectorKey={null}
        onSpawnNewShip={onSpawnNewShip}
      />,
    );
    // Popover + picker are both closed until a sector is tapped.
    expect(screen.queryByTestId('galaxy-sector-popover')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ship-picker-modal')).not.toBeInTheDocument();

    // Equinox Phase 7 (Item 4) — a tap opens the INTERACTIVE popover, NOT the
    // ship picker directly.
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('galaxy-sector-popover')).toBeInTheDocument();

    // "Join the fight" opens the kind-picker for that sector.
    fireEvent.click(screen.getByTestId('galaxy-popover-join'));
    expect(screen.getByTestId('ship-picker-modal')).toBeInTheDocument();
    // Title carries the tapped sector's name.
    expect(screen.getByText(/Spawn in/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ship-picker-spawn'));
    expect(onSpawnNewShip).toHaveBeenCalledTimes(1);
    expect(onSpawnNewShip.mock.calls[0][1]).toBe('sol-prime');
  });

  it('engineering room selection routes to onSelectRoom', () => {
    const onSelectRoom = vi.fn();
    render(<GalaxyPickerChrome activeLimboSectorKey={null} onSelectRoom={onSelectRoom} />);
    fireEvent.click(screen.getByTestId('engineering-rooms-button'));
    fireEvent.click(screen.getByTestId('engineering-room-test-sector'));
    expect(onSelectRoom).toHaveBeenCalledWith('test-sector');
  });

  it('sector popover shows LABELLED counts incl. drones (Equinox Phase 8 / Bug 5)', () => {
    // Inject a live snapshot slice so the popover has non-zero counts to label.
    act(() => {
      useUIStore.getState().setGalaxyStats([
        { key: 'sol-prime', players: 1, enemies: 2, neutrals: 8, structures: 3, owner: null },
      ]);
    });
    const apiRef = { current: null as GalaxyPickerApi | null };
    render(<GalaxyPickerChrome apiRef={apiRef} activeLimboSectorKey={null} />);
    act(() => { apiRef.current?.openForSector('sol-prime'); });
    expect(screen.getByTestId('galaxy-sector-popover')).toBeInTheDocument();
    // The breakdown is LABELLED rows (not bare icons — the Bug-5 fix), so the
    // roaming drones (neutrals) are legible at a glance.
    const breakdown = screen.getByTestId('galaxy-popover-breakdown');
    expect(breakdown).toHaveTextContent('Players: 1');
    expect(breakdown).toHaveTextContent('Hostiles: 2');
    expect(breakdown).toHaveTextContent('Neutral drones: 8');
    expect(breakdown).toHaveTextContent('Structures: 3');
  });
});

// Reset the shared Zustand galaxyStats so the injected slice above doesn't leak.
afterEach(() => {
  useUIStore.getState().setGalaxyStats([]);
});
