/**
 * Locks the GalaxyPickerChrome contract (single-canvas refactor, Step 4).
 * This is the post-auth spawn chrome with its OWN Pixi surface removed —
 * it overlays the shared gameplay canvas. The regression risks it guards:
 *   - a load-bearing testid disappears (E2E specs probe galaxy-map-screen,
 *     limbo-resume-banner/data-limbo-sector-key, engineering-rooms-button,
 *     single-player-button, ship-picker-modal),
 *   - the imperative apiRef.openForSector → ship-picker → onSpawnNewShip
 *     spawn flow breaks (this is how a tap on the shared canvas's selector
 *     layer turns into a spawn),
 *   - the engineering-room path stops routing to onSelectRoom.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GalaxyPickerChrome, type GalaxyPickerApi } from './GalaxyPickerChrome';

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

  it('apiRef.openForSector opens the kind-picker → spawn fires onSpawnNewShip with the sector', () => {
    const apiRef = { current: null as GalaxyPickerApi | null };
    const onSpawnNewShip = vi.fn();
    render(
      <GalaxyPickerChrome
        apiRef={apiRef}
        activeLimboSectorKey={null}
        onSpawnNewShip={onSpawnNewShip}
      />,
    );
    // Picker is closed until a sector is tapped.
    expect(screen.queryByTestId('ship-picker-modal')).not.toBeInTheDocument();

    act(() => { apiRef.current?.openForSector('sol-prime'); });
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
});
