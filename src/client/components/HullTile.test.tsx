/**
 * Lock for the shared hull tile (Hangar + shipyard Build tab) and the cost
 * chips under it: one tile component, its optional slots, and a bill read
 * from RECIPES.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { HullTile } from './HullTile.js';
import { CostChips, recipeBill, shortQty } from './CostChips.js';
import { RECIPES } from '../../shared-types/recipes.js';

describe('HullTile', () => {
  it('draws the name and data attributes, and clicks through', () => {
    const onClick = vi.fn();
    render(<HullTile kind="interceptor" name="Interceptor" testId="t" data={{ selected: '1' }} onClick={onClick} />);
    const tile = screen.getByTestId('t');
    expect(tile).toHaveAttribute('data-selected', '1');
    expect(tile).toHaveTextContent('Interceptor');
    fireEvent.click(tile.querySelector('button')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('art="structure" shows the baked portrait, and the footprint silhouette when it fails to load', () => {
    render(<HullTile art="structure" kind="solar" name="Solar" testId="t" />);
    const tile = screen.getByTestId('t');
    const img = within(tile).getByTestId('hull-tile-portrait');
    expect(img).toHaveAttribute('src', '/structures/solar.webp');
    expect(within(tile).queryByTestId('hull-tile-silhouette')).toBeNull();
    fireEvent.error(img);
    expect(within(tile).queryByTestId('hull-tile-portrait')).toBeNull();
    expect(within(tile).getByTestId('hull-tile-silhouette').querySelector('polygon')).not.toBeNull();
  });

  it('a ship tile has no structure portrait', () => {
    render(<HullTile kind="interceptor" name="Interceptor" testId="t" />);
    expect(screen.queryByTestId('hull-tile-portrait')).toBeNull();
  });

  it('has no optional slots unless asked', () => {
    render(<HullTile kind="interceptor" name="Interceptor" testId="t" />);
    for (const id of ['hull-tile-badge', 'hull-tile-lock', 'hull-tile-progress']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('shows the badge, lock, progress fill, caption, tag and a child row', () => {
    render(
      <HullTile kind="gunship" name="Gunship" testId="t" badge="×3" locked progress={0.25} caption={{ text: 'Free', color: '#fff' }} tag="2 fits">
        <span data-testid="child-row">chips</span>
      </HullTile>,
    );
    const tile = screen.getByTestId('t');
    expect(within(tile).getByTestId('hull-tile-badge')).toHaveTextContent('×3');
    expect(within(tile).getByTestId('hull-tile-lock')).toBeInTheDocument();
    expect(within(tile).getByTestId('hull-tile-progress')).toHaveAttribute('data-frac', '0.25');
    expect(tile).toHaveTextContent('Free');
    expect(tile).toHaveTextContent('2 fits');
    expect(within(tile).getByTestId('child-row')).toBeInTheDocument();
  });

  it('a mouse hover shows the tooltip; a touch never opens it', async () => {
    render(<HullTile kind="interceptor" name="Interceptor" testId="t" tooltip="Interceptor: 400 Minerals" />);
    const btn = screen.getByTestId('t').querySelector('button')!;
    expect(btn).toHaveAttribute('aria-label', 'Interceptor'); // the name stays the button's label
    // Touch: a long press (past MUI's 700 ms touch delay), then the browser's
    // emulated mouseover, opens nothing.
    vi.useFakeTimers();
    try {
      fireEvent.touchStart(btn);
      act(() => { vi.advanceTimersByTime(1500); });
      fireEvent.mouseOver(btn);
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    render(<HullTile kind="interceptor" name="Interceptor" testId="t" tooltip="Interceptor: 400 Minerals" />);
    fireEvent.mouseOver(screen.getByTestId('t').querySelector('button')!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Interceptor: 400 Minerals');
  });
});

describe('CostChips', () => {
  it('one chip per input good with its count, from RECIPES', () => {
    render(<CostChips recipe="build_gunship" />);
    const bill = RECIPES.build_gunship.inputs;
    for (const [good, n] of Object.entries(bill)) {
      expect(screen.getByTestId(`cost-chip-${good}`)).toHaveAttribute('data-n', String(n));
      expect(screen.getByTestId(`cost-chip-${good}`).querySelector('svg')).not.toBeNull();
    }
    expect(screen.getByTestId('cost-chips-build_gunship').children).toHaveLength(Object.keys(bill).length);
  });

  it('short quantities fit a small tile', () => {
    expect(shortQty(400)).toBe('400');
    expect(shortQty(1200)).toBe('1.2k');
    expect(shortQty(12_000)).toBe('12k');
    expect(recipeBill('build_interceptor')).toEqual([{ good: 'minerals', n: 400 }]);
  });
});

