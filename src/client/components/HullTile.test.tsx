/**
 * Lock for the shared hull tile (Hangar + shipyard Build tab) and the cost
 * chips under it: one tile component, its optional slots, and a bill read
 * from RECIPES.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { HullTile } from './HullTile.js';
import { CostChips, recipeBill, shortQty } from './CostChips.js';
import { addIntent, foreverIntent, removeOneIntent } from './buildQueueIntent.js';
import { RECIPES } from '../../shared-types/recipes.js';
import { MAX_BUILD_COUNT } from '../../shared-types/production.js';

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

describe('build queue intents (one recipe + a count today)', () => {
  const q = { recipe: 'build_interceptor' as const, left: 2 };
  it('the current hull adds, capped; a forever queue ignores adds', () => {
    expect(addIntent(q, 'build_interceptor', 1)).toEqual({ kind: 'send', recipe: 'build_interceptor', count: 3 });
    expect(addIntent({ ...q, left: MAX_BUILD_COUNT - 1 }, 'build_interceptor', 5)).toEqual({ kind: 'send', recipe: 'build_interceptor', count: MAX_BUILD_COUNT });
    expect(addIntent({ ...q, left: MAX_BUILD_COUNT }, 'build_interceptor', 1)).toBeNull();
    expect(addIntent({ ...q, left: undefined }, 'build_interceptor', 1)).toBeNull();
    expect(addIntent({ ...q, left: 0 }, 'build_interceptor', 1)).toEqual({ kind: 'send', recipe: 'build_interceptor', count: 1 });
  });
  it('a different hull asks to switch', () => {
    expect(addIntent(q, 'build_heavy', 5)).toEqual({ kind: 'confirm', recipe: 'build_heavy', count: 5 });
  });
  it('remove stops at 1 (no count 0 on the wire); forever toggles', () => {
    expect(removeOneIntent(q)).toEqual({ kind: 'send', recipe: 'build_interceptor', count: 1 });
    expect(removeOneIntent({ ...q, left: 1 })).toBeNull();
    expect(removeOneIntent({ ...q, left: undefined })).toBeNull();
    expect(foreverIntent(q)).toEqual({ kind: 'send', recipe: 'build_interceptor', count: undefined });
    expect(foreverIntent({ ...q, left: undefined })).toEqual({ kind: 'send', recipe: 'build_interceptor', count: 1 });
  });
});
