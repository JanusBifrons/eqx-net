/**
 * The Build sidebar (build-menu redesign M1): a category rail on the left,
 * kind tiles for the active category, its own ✕, Esc owned once by SidePanel,
 * and the sideways-phone size (0.4 of 915 px, from PANEL_TOUCH_TOP).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BuildSidebar } from './BuildSidebar.js';
import { BUILD_CATEGORIES, categoryById } from './buildCategories.js';
import { BUILD_PANEL_SIZE, rightPaperSx } from './SidePanel.js';
import { PANEL_TOUCH_TOP } from '../render/galaxy/galaxyFocus.js';
import { getStructureKind } from '@shared-types/structureKinds';
import { buildKindPower } from './BuildKindTile.js';

/** The tile's button (the test id sits on the HullTile's outer box). */
function tileButton(testId: string): HTMLElement {
  return screen.getByTestId(testId).querySelector('button')!;
}

const sendPackedStockQuery = vi.fn();
vi.mock('../net/tradeClient', () => ({ sendPackedStockQuery: () => sendPackedStockQuery() }));

function renderSidebar(open = true): { onClose: ReturnType<typeof vi.fn>; onPick: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const onPick = vi.fn();
  render(<BuildSidebar open={open} onClose={onClose} onPick={onPick} />);
  return { onClose, onPick };
}

describe('BuildSidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ placementKind: null, fleetPick: null, packedStock: null, currentSectorKey: '0,0', structureSettingsOpen: false });
  });
  afterEach(() => { cleanup(); useUIStore.setState({ currentSectorKey: null }); });

  it('the rail lists every category; the first is active and shows its kinds', () => {
    renderSidebar();
    for (const c of BUILD_CATEGORIES) expect(screen.getByTestId(`build-cat-${c.id}`)).toBeTruthy();
    const first = BUILD_CATEGORIES[0]!;
    expect(screen.getByTestId(`build-cat-${first.id}`)).toHaveAttribute('aria-selected', 'true');
    for (const k of first.kinds) expect(screen.getByTestId(`build-${k}`)).toBeTruthy();
  });

  it('a rail tap switches the grid to that category', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('build-cat-defence'));
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'defence');
    for (const k of categoryById('defence').kinds) expect(screen.getByTestId(`build-${k}`)).toBeTruthy();
    expect(screen.queryByTestId('build-capital')).toBeNull();
  });

  it('a tile tap picks its kind; a locked tile does nothing', () => {
    // In a sector with a stock reply and no packed Capital, the Capital locks.
    useUIStore.setState({ packedStock: {} });
    const { onPick } = renderSidebar();
    expect(screen.getByTestId('build-capital')).toHaveAttribute('data-locked', '1');
    fireEvent.click(tileButton('build-capital'));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(tileButton('build-connector'));
    expect(onPick).toHaveBeenCalledWith('connector');
  });

  it('tiles show the packed count', () => {
    useUIStore.setState({ packedStock: { 'structure:capital': 2 } });
    renderSidebar();
    expect(screen.getByTestId('build-capital')).toHaveAttribute('data-locked', '0');
    expect(screen.getByTestId('build-capital').textContent).toContain('×2');
  });

  it('tiles are portrait HullTiles with a ◆ cost chip and a signed ⚡ power chip (none when 0)', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('build-cat-economy'));
    const solar = screen.getByTestId('build-solar');
    expect(solar.querySelector('[data-testid="hull-tile-portrait"]')).toHaveAttribute('src', '/structures/solar.webp');
    const cost = solar.querySelector('[data-testid="build-cost-chip"]')!;
    expect(cost).toHaveAttribute('data-n', String(getStructureKind('solar').constructionCost));
    expect(cost.textContent).toContain('◆');
    expect(buildKindPower('solar')).toBeGreaterThan(0);
    expect(solar.querySelector('[data-testid="build-power-chip"]')!.textContent).toBe(`⚡ +${buildKindPower('solar')}`);
    expect(buildKindPower('miner')).toBeLessThan(0);
    expect(screen.getByTestId('build-miner').querySelector('[data-testid="build-power-chip"]')!.textContent)
      .toBe(`⚡ −${-buildKindPower('miner')}`);
    fireEvent.click(screen.getByTestId('build-cat-core'));
    expect(buildKindPower('connector')).toBe(0);
    expect(screen.getByTestId('build-connector').querySelector('[data-testid="build-power-chip"]')).toBeNull();
  });

  it('the details strip shows the hovered (mouse) or tapped kind: name, description, cost, power', () => {
    const { onPick } = renderSidebar();
    expect(screen.getByTestId('build-details').textContent).toContain('Hover or tap');
    fireEvent.pointerEnter(tileButton('build-territory_lock'), { pointerType: 'touch' });
    expect(screen.getByTestId('build-details')).not.toHaveAttribute('data-kind');
    fireEvent.pointerEnter(tileButton('build-territory_lock'), { pointerType: 'mouse' });
    const k = getStructureKind('territory_lock');
    const details = screen.getByTestId('build-details');
    expect(details).toHaveAttribute('data-kind', 'territory_lock');
    expect(details.textContent).toContain(k.displayName);
    expect(screen.getByTestId('build-details-desc').textContent).toBe(k.description);
    expect(screen.getByTestId('build-details-cost').textContent).toBe(`◆ ${k.constructionCost.toLocaleString('en-GB')}`);
    fireEvent.click(tileButton('build-connector')); // a tap still picks, and shows it
    expect(onPick).toHaveBeenCalledWith('connector');
    expect(screen.getByTestId('build-details')).toHaveAttribute('data-kind', 'connector');
    fireEvent.click(screen.getByTestId('build-cat-economy'));
    fireEvent.click(tileButton('build-solar'));
    expect(screen.getByTestId('build-details-power').textContent).toBe(`⚡ +${buildKindPower('solar')}`);
  });

  it('a locked tile says why (needs a packed crate), on the tile and in the details strip', () => {
    useUIStore.setState({ packedStock: {} });
    const { onPick } = renderSidebar();
    const cap = screen.getByTestId('build-capital');
    expect(cap.querySelector('[data-testid="hull-tile-lock"]')).not.toBeNull();
    expect(cap.textContent).toContain('Needs crate');
    fireEvent.click(tileButton('build-capital'));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId('build-details-lock').textContent).toContain('Needs a packed Capital crate');
    // Unlocked kinds say nothing of the sort.
    fireEvent.click(tileButton('build-connector'));
    expect(screen.queryByTestId('build-details-lock')).toBeNull();
  });

  it('asks for packed stock while open or placing (the keep-placing rule reads it), not when idle', () => {
    sendPackedStockQuery.mockClear();
    renderSidebar(false);
    expect(sendPackedStockQuery).not.toHaveBeenCalled();
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    expect(sendPackedStockQuery).toHaveBeenCalledTimes(1);
  });

  it('the ✕ closes it', () => {
    const { onClose } = renderSidebar();
    fireEvent.click(screen.getByTestId('build-sidebar-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc closes it once; not while placing, picking a fleet point or after App handled the key', () => {
    const { onClose } = renderSidebar();
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => { useUIStore.setState({ placementKind: null, fleetPick: { kind: 'patrol', points: 0, doneSeq: 0 } }); });
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => { useUIStore.setState({ fleetPick: null }); });
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    act(() => { window.dispatchEvent(handled); });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a closed sidebar renders no tiles and never listens for Esc', () => {
    const { onClose } = renderSidebar(false);
    expect(screen.queryByTestId('build-rail')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opening it clears the building settings flag (one right panel at a time)', () => {
    useUIStore.setState({ structureSettingsOpen: true });
    renderSidebar();
    expect(useUIStore.getState().structureSettingsOpen).toBe(false);
  });

  it('a sideways phone gets 0.4 of the width, from below the top-right toolbar', () => {
    const sx = rightPaperSx(BUILD_PANEL_SIZE, true);
    expect(BUILD_PANEL_SIZE.touchFrac).toBe(0.4);
    expect(sx['width']).toBe(`clamp(${BUILD_PANEL_SIZE.touchMinW}px, 40vw, ${BUILD_PANEL_SIZE.width}px)`);
    expect(sx['top']).toBe(`${PANEL_TOUCH_TOP}px`);
    // 0.4 × 915 = 366 px fits inside the clamp, so the phone gets the full 0.4.
    expect(915 * 0.4).toBeGreaterThanOrEqual(BUILD_PANEL_SIZE.touchMinW);
    expect(915 * 0.4).toBeLessThanOrEqual(BUILD_PANEL_SIZE.width);
  });
});
