/**
 * The Build sidebar's desktop keys (they moved here from the old bottom build
 * hotbar): while open, 1–9 pick the Nth tile of the open category (a tile
 * click), Q / E step the category, and the fire-control keys stand down so 1–9
 * do not also switch weapon groups. Closed, the sidebar leaves every key alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BuildSidebar } from './BuildSidebar.js';
import { BUILD_CATEGORIES } from './buildCategories.js';
import { installFcKeys } from '../input/MouseLock.js';
import { buildMenuKeysOpen } from '../input/buildMenuKeys.js';

vi.mock('../net/tradeClient', () => ({ sendPackedStockQuery: () => {} }));
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => null }));

const CODE: Record<string, string> = { q: 'KeyQ', e: 'KeyE' };
function press(key: string): void {
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : CODE[key] ?? key;
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, code, cancelable: true })); });
}

/** The host passes `open` from the one flag (`rightPanel === 'build'`); mirror it here. */
function renderSidebar(open = true): { onPick: ReturnType<typeof vi.fn>; rerender: (o: boolean) => void } {
  const onPick = vi.fn();
  useUIStore.setState({ buildMode: true, rightPanel: open ? 'build' : null });
  const r = render(<BuildSidebar open={open} onClose={() => {}} onPick={onPick} />);
  return { onPick, rerender: (o) => {
    useUIStore.setState({ rightPanel: o ? 'build' : null });
    r.rerender(<BuildSidebar open={o} onClose={() => {}} onPick={onPick} />);
  } };
}

let disposeFc: (() => void) | null = null;

describe('BuildSidebar keys', () => {
  beforeEach(() => {
    useUIStore.setState({
      placementKind: null, packedStock: null, currentSectorKey: '0,0',
      fcGroups: [
        { id: 'g1', name: 'One', mode: 'manual', colour: 0, capacity: 1, locks: [] },
        { id: 'g2', name: 'Two', mode: 'manual', colour: 1, capacity: 1, locks: [] },
      ],
      activeGroupId: 'g1',
    });
    disposeFc = installFcKeys();
  });
  afterEach(() => {
    disposeFc?.();
    cleanup();
    useUIStore.setState({ currentSectorKey: null, fcGroups: [], activeGroupId: null, rightPanel: null, buildMode: false });
  });

  it('1–9 pick the Nth tile of the open category, the same as a click', () => {
    const { onPick } = renderSidebar();
    const core = BUILD_CATEGORIES[0]!;
    press('2');
    expect(onPick).toHaveBeenCalledWith(core.kinds[1]);
    expect(screen.getByTestId('build-details')).toHaveAttribute('data-kind', core.kinds[1]);
    press('9'); // past the last tile: nothing
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('a locked tile is shown, not picked (like a click)', () => {
    useUIStore.setState({ packedStock: {} }); // no packed Capital: it locks
    const { onPick } = renderSidebar();
    press('1');
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId('build-details')).toHaveAttribute('data-kind', 'capital');
  });

  it('E / Q step to the next / previous category, wrapping', () => {
    const { onPick } = renderSidebar();
    const kinds = (): string | null => screen.getByTestId('build-kinds').getAttribute('data-category');
    press('e');
    expect(kinds()).toBe(BUILD_CATEGORIES[1]!.id);
    press('1');
    expect(onPick).toHaveBeenCalledWith(BUILD_CATEGORIES[1]!.kinds[0]);
    press('q');
    press('q');
    expect(kinds()).toBe(BUILD_CATEGORIES[BUILD_CATEGORIES.length - 1]!.id);
  });

  it('the fire-control keys stand down while open: 1–9 do not switch weapon groups', () => {
    const { rerender } = renderSidebar();
    expect(buildMenuKeysOpen()).toBe(true);
    press('2');
    expect(useUIStore.getState().activeGroupId).toBe('g1');
    rerender(false);
    expect(buildMenuKeysOpen()).toBe(false);
    press('2');
    expect(useUIStore.getState().activeGroupId).toBe('g2');
  });

  it('closed, the sidebar picks nothing and leaves the category alone', () => {
    const { onPick } = renderSidebar(false);
    press('1');
    press('e');
    expect(onPick).not.toHaveBeenCalled();
  });
});
