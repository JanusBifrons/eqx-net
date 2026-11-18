import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HangarWindow } from './HangarWindow';
import { useUIStore } from '../../state/store';
import type { RosterEntry } from '../../state/storeTypes';

vi.mock('../../net/tradeApi', () => ({ fetchEconomy: vi.fn(async () => null) }));

const noop = (): void => {};
function open(over: Partial<Parameters<typeof HangarWindow>[0]> = {}) {
  const props = { sectorKey: 's1', sectorName: 'Alpha', playerId: '', selectedKind: 'fighter' as const, onClose: noop, onLaunchNew: vi.fn(), onResume: vi.fn(), ...over };
  render(<HangarWindow {...props} />);
  return props;
}
const parked = (shipId: string, kind: string, sectorKey = 's1'): RosterEntry =>
  ({ shipId, kind, kindVersion: 1, health: 1, sectorKey, x: 0, y: 0, isActive: false });

describe('HangarWindow (join flow stage 5)', () => {
  beforeEach(() => { useUIStore.setState({ shipRoster: [], wallet: 0, freeLaunches: 0 }); });

  it('renders at once on open (no Grow transition)', () => {
    open();
    expect(screen.getByTestId('hangar-window')).toBeTruthy();
  });

  it('renders nothing while closed', () => {
    open({ sectorKey: null });
    expect(screen.queryByTestId('hangar-window')).toBeNull();
  });

  it('a Shipyard hull cannot launch; a remembered Shipyard pick falls back to the Fighter', () => {
    const p = open({ selectedKind: 'gunship' });
    expect(screen.getByTestId('ship-card-gunship').getAttribute('data-verdict')).toBe('refuse');
    expect(screen.getByTestId('ship-card-fighter').getAttribute('data-selected')).toBe('1');
    fireEvent.click(screen.getByTestId('ship-card-gunship').querySelector('button')!);
    expect(screen.getByTestId('hangar-launch').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('ship-card-fighter').querySelector('button')!);
    fireEvent.click(screen.getByTestId('hangar-launch'));
    expect(p.onLaunchNew).toHaveBeenCalledWith('fighter', 's1');
  });

  it('capitals tab: fits fold into one tile; a fit launches its own kind, into debt when broke', () => {
    const p = open();
    fireEvent.click(screen.getByTestId('hangar-tab-capital'));
    expect(screen.queryByTestId('ship-card-battleship-rail')).toBeNull();
    fireEvent.click(screen.getByTestId('hangar-fit-battleship-rail'));
    expect(screen.getByTestId('hangar-cost').textContent).toBe('60,000 cr');
    expect(screen.getByTestId('hangar-after').textContent).toContain('-60,000');
    fireEvent.click(screen.getByTestId('hangar-launch'));
    expect(p.onLaunchNew).toHaveBeenCalledWith('battleship-rail', 's1');
  });

  it('shows the free-launch pips and spends one before debt', () => {
    useUIStore.setState({ freeLaunches: 3 });
    open({ selectedKind: 'destroyer' });
    expect(screen.getByTestId('hangar-free-launches').getAttribute('data-count')).toBe('3');
    expect(screen.getByTestId('hangar-cost').textContent).toBe('Free launch');
  });

  it('a hull parked here is gold, resumes by shipId and offers Abandon; one elsewhere does not', () => {
    useUIStore.setState({ shipRoster: [parked('ship-7', 'heavy'), parked('ship-9', 'scout', 's2')] });
    const p = open({ selectedKind: 'heavy' });
    expect(screen.getByTestId('ship-card-heavy').getAttribute('data-owned')).toBe('1');
    expect(screen.getByTestId('ship-card-scout').getAttribute('data-owned')).toBe('0');
    expect(screen.getByTestId('hangar-abandon')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hangar-launch'));
    expect(p.onResume).toHaveBeenCalledWith('ship-7', 's1');
    expect(p.onLaunchNew).not.toHaveBeenCalled();
  });
});
