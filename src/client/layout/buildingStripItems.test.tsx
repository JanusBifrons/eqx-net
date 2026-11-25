/**
 * UI plan U3-6: the left strip's building section. Your own switchable
 * building in Build mode shows a Power fly-out (On / Off); a pick sends the
 * Power page's `set_structure_power` through the one sender, picking the
 * current value sends nothing, and it is hidden outside Build, for a building
 * that has no switch, and for one you do not own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import type { PanelData } from '../components/selectionPanelData';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: { localPlayerId: 'me' }, getRoom: () => ({ send }) }),
}));

import { useBuildingStripItems } from './buildingStripItems';
import { SetStructurePowerSchema } from '../../shared-types/messages';

function Harness({ data }: { data: PanelData | null }): JSX.Element {
  return <div data-testid="strip">{useBuildingStripItems(data)}</div>;
}

const turret = (over: Partial<PanelData> = {}): PanelData => ({
  name: 'Turret', hpPct: 100, shieldPct: null, entityId: 9, isStructure: true, isOwn: true, powerSwitch: true, ...over,
});

function pick(option: 'on' | 'off'): void {
  fireEvent.click(screen.getByTestId('left-strip-power'));
  fireEvent.click(screen.getByTestId(`left-strip-power-option-${option}`));
}

beforeEach(() => { useUIStore.setState({ buildMode: true, pilotMode: 'spectator' }); });
afterEach(() => { cleanup(); send.mockReset(); });

describe('left strip building section (U3-6)', () => {
  it('Power off sends the Power page message once; picking the current value sends nothing', () => {
    render(<Harness data={turret()} />);
    const btn = screen.getByTestId('left-strip-power');
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    pick('on');
    expect(send).not.toHaveBeenCalled();
    pick('off');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('set_structure_power', { type: 'set_structure_power', entityId: 9, on: false });
    expect(SetStructurePowerSchema.safeParse(send.mock.calls[0]![1]).success).toBe(true);
  });

  it('a switched-off building reads Off and On turns it back on', () => {
    render(<Harness data={turret({ switchedOff: true })} />);
    pick('on');
    expect(send).toHaveBeenCalledWith('set_structure_power', { type: 'set_structure_power', entityId: 9, on: true });
  });

  it('hidden outside Build, without a switch, and for no selection', () => {
    const { rerender } = render(<Harness data={turret({ powerSwitch: undefined })} />);
    expect(screen.queryByTestId('left-strip-power')).toBeNull();
    rerender(<Harness data={null} />);
    expect(screen.queryByTestId('left-strip-power')).toBeNull();
    useUIStore.setState({ buildMode: false });
    rerender(<Harness data={turret()} />);
    expect(screen.queryByTestId('left-strip-power')).toBeNull();
  });
});
