/**
 * Coverage lock for [LevelBadge.tsx](./LevelBadge.tsx) — the reusable PUBLIC
 * ship-level badge (Phase 4 WS-B1, plan: effervescent-umbrella, D13). One
 * component drives the badge in BOTH ShipRosterCard variants (and any future
 * surface), so the contract lives here.
 *
 * Contract:
 *   - Renders `data-testid="level-badge"` carrying `data-level` with the level.
 *   - Shows `Lv N` text.
 *   - Renders NOTHING for level ≤ 1 (un-levelled ships pay no visual noise —
 *     mirrors the wire's "absent ⇒ level 1, zero bytes" discipline).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LevelBadge } from './LevelBadge.js';

describe('LevelBadge (Phase 4 WS-B1)', () => {
  it('renders a badge with the level for level > 1', () => {
    render(<LevelBadge level={4} />);
    const badge = screen.getByTestId('level-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-level', '4');
    expect(badge).toHaveTextContent('Lv 4');
  });

  it('renders nothing for level 1 (un-levelled)', () => {
    const { container } = render(<LevelBadge level={1} />);
    expect(screen.queryByTestId('level-badge')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a level below 1 / undefined (defensive)', () => {
    const { rerender } = render(<LevelBadge level={0} />);
    expect(screen.queryByTestId('level-badge')).toBeNull();
    rerender(<LevelBadge level={undefined} />);
    expect(screen.queryByTestId('level-badge')).toBeNull();
  });

  it('shows the highest cap level (10)', () => {
    render(<LevelBadge level={10} />);
    expect(screen.getByTestId('level-badge')).toHaveTextContent('Lv 10');
  });
});
