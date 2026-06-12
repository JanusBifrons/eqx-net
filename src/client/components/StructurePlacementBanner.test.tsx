import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { StructurePlacementBanner } from './StructurePlacementBanner.js';
import { useUIStore } from '../state/store.js';

/**
 * The banner's Confirm delegates to the shared `commitChosenPlacement` (the
 * single commit path also used by the WS-10 desktop one-click place), then
 * clears `placementKind`. The "Confirm reads the PRODUCTION `placementChosen`
 * channel, not the webdriver-gated dataset" regression (smoke 2026-06-07
 * capture kuytvy) now lives where that logic lives — the `commitChosenPlacement`
 * unit test in `structurePlacementClient.test.ts`. Here we lock the wiring: a
 * Confirm click commits the active kind + exits placement mode.
 */
const commitChosenPlacement = vi.fn();
vi.mock('../structures/structurePlacementClient', () => ({
  commitChosenPlacement: (...a: unknown[]) => commitChosenPlacement(...a),
}));

describe('StructurePlacementBanner', () => {
  beforeEach(() => {
    cleanup();
    commitChosenPlacement.mockClear();
    useUIStore.setState({ placementKind: 'capital' });
  });

  it('Confirm commits the active kind via the shared path and exits placement', () => {
    const { getByTestId } = render(<StructurePlacementBanner />);
    fireEvent.click(getByTestId('placement-confirm'));

    expect(commitChosenPlacement).toHaveBeenCalledTimes(1);
    expect(commitChosenPlacement).toHaveBeenCalledWith('capital');
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('Cancel exits placement without committing', () => {
    const { getByTestId } = render(<StructurePlacementBanner />);
    fireEvent.click(getByTestId('placement-cancel'));

    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('renders nothing when not in placement mode', () => {
    useUIStore.setState({ placementKind: null });
    const { container } = render(<StructurePlacementBanner />);
    expect(container.querySelector('[data-testid="placement-banner"]')).toBeNull();
  });
});
