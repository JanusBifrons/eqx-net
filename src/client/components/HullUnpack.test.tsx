import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));
vi.mock('../render/art/shipPortraits', () => ({
  shipPortraitUrl: (kind: string) => (kind === 'gunship' ? '/art/gunship.png' : null),
}));

import { HullUnpack, packedHullsOf } from './HullUnpack';

describe('HullUnpack (economy v2 W5a)', () => {
  afterEach(() => send.mockReset());

  it('groups packed hulls by kind (structures and junk ignored)', () => {
    expect(packedHullsOf('hull:gunship,structure:smelter,hull:gunship,hull:interceptor,junk')).toEqual([
      { kind: 'gunship', n: 2 },
      { kind: 'interceptor', n: 1 },
    ]);
  });

  it('one hull tile per kind: portrait, NAME and ×n count', () => {
    render(<HullUnpack entityId={4} packed="hull:gunship,hull:gunship,structure:smelter" />);
    const tiles = screen.getAllByTestId('hull-unpack-chip');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.getAttribute('data-kind')).toBe('gunship');
    const btn = within(tiles[0]!).getByRole('button', { name: 'Gunship' });
    expect(btn.querySelector('svg')).toBeNull(); // portrait, not the silhouette fallback
    expect(within(tiles[0]!).getByTestId('hull-tile-badge').textContent).toBe('×2');
    expect(tiles[0]!.textContent).toContain('Unpack');
    expect(document.body.textContent).not.toContain('hull:');
  });

  it('tapping the tile sends the same unpack_hull message', () => {
    render(<HullUnpack entityId={4} packed="hull:gunship,hull:interceptor" />);
    const tile = screen.getAllByTestId('hull-unpack-chip').find((t) => t.getAttribute('data-kind') === 'interceptor')!;
    expect(within(tile).getByTestId('hull-tile-badge').textContent).toBe('×1');
    expect(within(tile).getByRole('button').querySelector('svg')).not.toBeNull(); // no portrait: silhouette
    fireEvent.click(within(tile).getByRole('button'));
    expect(send).toHaveBeenCalledWith('unpack_hull', { type: 'unpack_hull', networkEntityId: 4, kind: 'interceptor' });
  });

  it('renders nothing without packed hulls', () => {
    const { container } = render(<HullUnpack entityId={4} packed="structure:smelter" />);
    expect(container.textContent).toBe('');
  });
});
