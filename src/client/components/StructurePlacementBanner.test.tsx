import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { StructurePlacementBanner } from './StructurePlacementBanner.js';
import { LayoutContext } from '../layout/useLayout.js';
import { useUIStore } from '../state/store.js';
import { getPlacementMirror, getPlacementRotationDeg, setPlacementMirror, setPlacementRotationDeg } from '../structures/structurePlacementClient.js';
import { act } from 'react';
import { resetPlacementChosen, setPlacementRejection } from '../structures/placementChosen.js';

/**
 * The banner's Confirm delegates to the shared `commitChosenPlacement` (the
 * single commit path also used by the WS-10 desktop one-click place) through
 * `commitPlacement`, and KEEPS placing (build-menu M3) unless the kind places
 * once. The "Confirm reads the PRODUCTION `placementChosen`
 * channel, not the webdriver-gated dataset" regression (smoke 2026-06-07
 * capture kuytvy) now lives where that logic lives — the `commitChosenPlacement`
 * unit test in `structurePlacementClient.test.ts`. Here we lock the wiring: a
 * Confirm click commits the active kind and keeps or ends placement.
 */
const commitChosenPlacement = vi.fn((..._a: unknown[]) => true);
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

// The banner docks in the `top-center` anchor (build mode, owner design
// 2026-11-20), so tests supply a real host for its Slot.
let topCenter: HTMLDivElement;
const renderBanner = () => render(
  <LayoutContext.Provider value={{ 'top-center': topCenter }}>
    <StructurePlacementBanner />
  </LayoutContext.Provider>,
);

describe('StructurePlacementBanner', () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = '';
    topCenter = document.createElement('div');
    document.body.appendChild(topCenter);
    commitChosenPlacement.mockClear();
    isTouchDeviceMock.mockReturnValue(true);
    useUIStore.setState({ placementKind: 'capital' });
    resetPlacementChosen();
  });

  it('Confirm commits the active kind via the shared path and keeps placing it', () => {
    useUIStore.setState({ placementKind: 'solar' });
    const { getByTestId } = renderBanner();
    fireEvent.click(getByTestId('placement-confirm'));
    fireEvent.click(getByTestId('placement-confirm'));

    expect(commitChosenPlacement).toHaveBeenCalledTimes(2);
    expect(commitChosenPlacement).toHaveBeenCalledWith('solar');
    expect(useUIStore.getState().placementKind).toBe('solar'); // still placing
    expect(getByTestId('placement-banner').textContent).toContain('Solar');
  });

  it.each(['capital', 'territory_lock'] as const)('Confirm places a %s once: placement ends', (kind) => {
    useUIStore.setState({ placementKind: kind });
    const { getByTestId } = renderBanner();
    fireEvent.click(getByTestId('placement-confirm'));
    expect(commitChosenPlacement).toHaveBeenCalledWith(kind);
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('Confirm is disabled while the ghost is blocked, and enabled again once clear', () => {
    const { getByTestId } = renderBanner();
    const confirm = getByTestId('placement-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    act(() => setPlacementRejection('overlap-structure'));
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBe('capital'); // still placing
    act(() => setPlacementRejection(null));
    expect(confirm.disabled).toBe(false);
  });

  it('a refused commit keeps placement mode open', () => {
    commitChosenPlacement.mockReturnValueOnce(false);
    const { getByTestId } = renderBanner();
    fireEvent.click(getByTestId('placement-confirm'));
    expect(useUIStore.getState().placementKind).toBe('capital');
  });

  it('Cancel exits placement without committing', () => {
    const { getByTestId } = renderBanner();
    fireEvent.click(getByTestId('placement-cancel'));

    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('Rotate turns the placement 90 degrees', () => {
    setPlacementRotationDeg(0);
    const { getByTestId } = renderBanner();
    fireEvent.click(getByTestId('placement-rotate'));
    expect(getPlacementRotationDeg()).toBe(90);
    fireEvent.click(getByTestId('placement-rotate'));
    expect(getPlacementRotationDeg()).toBe(180);
    // Rotating neither commits nor leaves placement mode.
    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBe('capital');
  });

  it('Mirror flips the placement left-right and shows it pressed', () => {
    setPlacementMirror(false);
    const { getByTestId } = renderBanner();
    const b = getByTestId('placement-mirror');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(b);
    expect(getPlacementMirror()).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(b);
    expect(getPlacementMirror()).toBe(false);
    // Mirroring neither commits nor leaves placement mode.
    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBe('capital');
  });

  it('uses icon-only buttons (rotate, mirror, tick, cross) with labels and 40 px targets', () => {
    const { getByTestId } = renderBanner();
    for (const [id, label] of [['placement-rotate', 'Rotate'], ['placement-mirror', 'Mirror'], ['placement-confirm', 'Confirm'], ['placement-cancel', 'Cancel']] as const) {
      const b = getByTestId(id);
      expect(b.getAttribute('aria-label')).toBe(label);
      expect(b.getAttribute('title')).toBe(label);
      expect(b.textContent).toBe(''); // icon only, no text
      expect(b.querySelector('svg')).not.toBeNull();
      const cs = getComputedStyle(b);
      expect(parseFloat(cs.width)).toBeGreaterThanOrEqual(40);
      expect(parseFloat(cs.height)).toBeGreaterThanOrEqual(40);
    }
    // The prompt line stays.
    expect(getByTestId('placement-banner').textContent).toContain('here?');
  });

  it('renders nothing when not in placement mode', () => {
    useUIStore.setState({ placementKind: null });
    const { container } = renderBanner();
    expect(container.querySelector('[data-testid="placement-banner"]')).toBeNull();
  });

  it('renders nothing on a DESKTOP (non-touch) device even in placement mode (P3.6)', () => {
    // Desktop one-click place needs no Confirm/Cancel banner — the mobile
    // banner leaking onto desktop was the bug. With placementKind set but a
    // pointer (non-touch) device, the banner must stay unmounted.
    isTouchDeviceMock.mockReturnValue(false);
    useUIStore.setState({ placementKind: 'capital' });
    const { container } = renderBanner();
    expect(container.querySelector('[data-testid="placement-banner"]')).toBeNull();
  });

  it('docks at top centre with the reason line under it, not at the ghost', () => {
    const { getByTestId } = renderBanner();
    const dock = getByTestId('placement-dock');
    const banner = getByTestId('placement-banner');
    expect(topCenter.contains(dock)).toBe(true);
    expect(dock.contains(banner)).toBe(true);
    // No per-frame world anchoring: the banner carries no inline position.
    expect(banner.style.left).toBe('');
    expect(banner.style.top).toBe('');
    const hint = getByTestId('placement-link-hint');
    expect(dock.contains(hint)).toBe(true);
    expect(hint.dataset.docked).toBe('1');
    // The hint follows the banner in the dock column.
    expect(banner.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
