/**
 * The Build sidebar folded to the placing strip (BuildPlacingStrip.tsx): the
 * same SidePanel (`build-sidebar`, data-mode strip), the picked kind's portrait
 * and a ✕; no rail, no kind tiles, no 1–9 / Q / E keys. The strip size is
 * auto height, vertically centred, slim; no notch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BuildSidebar } from './BuildSidebar.js';
import { BUILD_STRIP_SIZE, BUILD_PANEL_SIZE, rightPaperSx } from './SidePanel.js';
import { buildMenuKeysOpen } from '../input/buildMenuKeys.js';

const isTouch = vi.fn(() => false);
vi.mock('../input/TouchInput', async (orig) => ({
  ...(await orig<typeof import('../input/TouchInput')>()), isTouchDevice: () => isTouch(),
}));
vi.mock('../net/tradeClient', () => ({ sendPackedStockQuery: () => {} }));

function renderStrip(): { onPick: ReturnType<typeof vi.fn>; onExpand: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onPick = vi.fn();
  const onExpand = vi.fn();
  const onCancel = vi.fn();
  render(<BuildSidebar open={false} strip onClose={() => {}} onPick={onPick} onExpand={onExpand} onCancel={onCancel} />);
  return { onPick, onExpand, onCancel };
}

describe('BuildSidebar strip mode', () => {
  beforeEach(() => {
    useUIStore.setState({ placementKind: 'solar', fleetPick: null, packedStock: null, currentSectorKey: '0,0', structureSettingsOpen: false });
  });
  afterEach(() => { cleanup(); isTouch.mockReturnValue(false); useUIStore.setState({ placementKind: null, currentSectorKey: null }); });

  it('shows the picked kind on the same panel, no rail and no kind tiles', () => {
    renderStrip();
    const paper = document.querySelector('[data-testid="build-sidebar"] .MuiDrawer-paper')!;
    expect(paper.getAttribute('data-mode')).toBe('strip');
    expect(paper.getAttribute('data-open')).toBe('0');
    expect(screen.getByTestId('build-strip')).toHaveAttribute('data-kind', 'solar');
    expect(screen.getByTestId('build-strip-portrait')).toBeTruthy();
    expect(screen.getByTestId('build-strip-portrait').textContent).toContain('Solar');
    expect(screen.queryByTestId('build-rail')).toBeNull();
    expect(screen.queryByTestId('build-solar')).toBeNull();
    expect(screen.queryByTestId('build-sidebar-close')).toBeNull();
    expect(screen.queryByTestId('side-panel-notch')).toBeNull();
  });

  it('the portrait expands; the ✕ cancels', () => {
    const { onExpand, onCancel } = renderStrip();
    fireEvent.click(screen.getByTestId('build-strip-portrait').querySelector('button')!);
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('build-strip-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the 1–9 / Q / E keys are off in strip mode', () => {
    const { onPick } = renderStrip();
    expect(buildMenuKeysOpen()).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', cancelable: true })); });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('no strip without a picked kind; open (the full list) wins over strip', () => {
    useUIStore.setState({ placementKind: null });
    renderStrip();
    expect(screen.queryByTestId('build-strip')).toBeNull();
    cleanup();
    useUIStore.setState({ placementKind: 'solar' });
    render(<BuildSidebar open strip onClose={() => {}} onPick={() => {}} />);
    expect(screen.queryByTestId('build-strip')).toBeNull();
    expect(screen.getByTestId('build-rail')).toBeTruthy();
    expect(buildMenuKeysOpen()).toBe(true);
  });

  it('the strip size: auto height, vertically centred, slim, no notch (phone and desktop)', () => {
    for (const touch of [false, true]) {
      const sx = rightPaperSx(BUILD_STRIP_SIZE, touch);
      expect(sx['height']).toBe('fit-content');
      expect(sx['top']).toBe(0);
      expect(sx['bottom']).toBe(0);
      expect(sx['my']).toBe('auto');
      expect(sx['transform']).toBeUndefined();
    }
    expect(rightPaperSx(BUILD_STRIP_SIZE, true)['width']).toBe(100);
    // The full sidebar keeps its full-height dock.
    expect(rightPaperSx(BUILD_PANEL_SIZE, false)['height']).toBe('calc(100dvh - var(--app-bar-h, 0px))');
  });

  it('on a phone the strip renders without the panel header', () => {
    isTouch.mockReturnValue(true);
    renderStrip();
    expect(screen.getByTestId('build-strip')).toBeTruthy();
    expect(screen.queryByTestId('build-sidebar-head')).toBeNull();
    expect(screen.queryByTestId('side-panel-notch')).toBeNull();
  });
});
