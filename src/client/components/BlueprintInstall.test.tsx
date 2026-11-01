import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { BlueprintInstall } from './BlueprintInstall';

describe('BlueprintInstall (P5)', () => {
  afterEach(() => send.mockReset());

  it('shows one Install chip per blueprint kind (by name) and sends install_blueprint', () => {
    render(<BlueprintInstall entityId={9} blueprints="bp-missile-rack,bp-missile-rack,bp-cargo-expander,junk" />);
    const chips = screen.getAllByTestId('blueprint-install-chip');
    expect(chips.map((c) => c.getAttribute('data-blueprint'))).toEqual(['bp-missile-rack', 'bp-cargo-expander']);
    expect(chips[0]!.textContent).toContain('Missile Rack');
    expect(document.body.textContent).not.toContain('bp-');
    fireEvent.click(chips[1]!);
    expect(send).toHaveBeenCalledWith('install_blueprint', { type: 'install_blueprint', networkEntityId: 9, blueprintId: 'bp-cargo-expander' });
  });

  it('renders nothing with no known blueprints', () => {
    const { container } = render(<BlueprintInstall entityId={9} blueprints="junk" />);
    expect(container.textContent).toBe('');
  });
});
