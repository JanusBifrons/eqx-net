import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { StructurePlacementBanner } from './StructurePlacementBanner.js';
import { useUIStore } from '../state/store.js';
import { getPlacementRotationDeg, setPlacementRotationDeg } from '../structures/structurePlacementClient.js';

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
// The rotation functions stay REAL so the Rotate test checks the actual
// module state the renderer reads (and the desktop R key cycles).
vi.mock('../structures/structurePlacementClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../structures/structurePlacementClient.js')>()),
  commitChosenPlacement: (...a: unknown[]) => commitChosenPlacement(...a),
}));

// The banner is a TOUCH-ONLY affordance (P3.6 / WS-C4b) — on a pointer
// (desktop) device the one-click place model means no Confirm/Cancel banner.
// jsdom reports `isTouchDevice()` false, so the wiring tests below force it
// true; the desktop test asserts the gate hides the banner.
const isTouchDeviceMock = vi.fn(() => true);
vi.mock('../input/TouchInput', () => ({
  isTouchDevice: () => isTouchDeviceMock(),
}));

describe('StructurePlacementBanner', () => {
  beforeEach(() => {
    cleanup();
    commitChosenPlacement.mockClear();
    isTouchDeviceMock.mockReturnValue(true);
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

  it('Rotate turns the placement 90 degrees', () => {
    setPlacementRotationDeg(0);
    const { getByTestId } = render(<StructurePlacementBanner />);
    fireEvent.click(getByTestId('placement-rotate'));
    expect(getPlacementRotationDeg()).toBe(90);
    fireEvent.click(getByTestId('placement-rotate'));
    expect(getPlacementRotationDeg()).toBe(180);
    // Rotating neither commits nor leaves placement mode.
    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBe('capital');
  });

  it('renders nothing when not in placement mode', () => {
    useUIStore.setState({ placementKind: null });
    const { container } = render(<StructurePlacementBanner />);
    expect(container.querySelector('[data-testid="placement-banner"]')).toBeNull();
  });

  it('renders nothing on a DESKTOP (non-touch) device even in placement mode (P3.6)', () => {
    // Desktop one-click place needs no Confirm/Cancel banner — the mobile
    // banner leaking onto desktop was the bug. With placementKind set but a
    // pointer (non-touch) device, the banner must stay unmounted.
    isTouchDeviceMock.mockReturnValue(false);
    useUIStore.setState({ placementKind: 'capital' });
    const { container } = render(<StructurePlacementBanner />);
    expect(container.querySelector('[data-testid="placement-banner"]')).toBeNull();
  });
});
