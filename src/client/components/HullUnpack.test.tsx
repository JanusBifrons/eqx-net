import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
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

  it('one chip per hull kind, by NAME, sends unpack_hull', () => {
    render(<HullUnpack entityId={4} packed="hull:gunship,hull:gunship,structure:smelter" />);
    const chips = screen.getAllByTestId('hull-unpack-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('Unpack Gunship (2)');
    expect(document.body.textContent).not.toContain('hull:');
    fireEvent.click(chips[0]!);
    expect(send).toHaveBeenCalledWith('unpack_hull', { type: 'unpack_hull', networkEntityId: 4, kind: 'gunship' });
  });

  it('renders nothing without packed hulls', () => {
    const { container } = render(<HullUnpack entityId={4} packed="structure:smelter" />);
    expect(container.textContent).toBe('');
  });
});
