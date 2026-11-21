/**
 * Lock for the Manage tab layout: Upgrade card on top (next level, minerals,
 * goods chips), Reconnect / Clear row, and Deconstruct as a ~1 s
 * hold-to-confirm (early release cancels, a plain click does nothing); a
 * running deconstruction cancels with a tap. Same messages as before.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { DECONSTRUCT_HOLD_MS, StructureManageTab } from './StructureManageActions.js';
import { StructureActionSchema, UpgradeStructureSchema } from '../../shared-types/messages.js';

function seed(kind: string, extra: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  setGameClient({
    getRoom: () => ({ send }),
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', ...extra }]]),
      swarm: new Map([[9, { kind: 2, shipKind: kind, radius: 60, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  render(<StructureManageTab entityId={9} pollMs={250} />);
  return send;
}

const deconMsg = { type: 'structure_action', id: 9, action: 'toggle_deconstruct' };

describe('Manage tab', () => {
  afterEach(() => { vi.useRealTimers(); setGameClient(null); });

  it('holding Deconstruct for the full time sends the toggle once', () => {
    vi.useFakeTimers();
    const send = seed('solar');
    const btn = screen.getByTestId('structure-action-deconstruct');
    expect(btn).toHaveAttribute('data-active', '0');
    fireEvent.pointerDown(btn);
    expect(btn).toHaveAttribute('data-holding', '1');
    act(() => { vi.advanceTimersByTime(DECONSTRUCT_HOLD_MS); });
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('structure_action', deconMsg);
    expect(StructureActionSchema.safeParse(deconMsg).success).toBe(true);
  });

  it('letting go early cancels, and a plain click does nothing', () => {
    vi.useFakeTimers();
    const send = seed('solar');
    const btn = screen.getByTestId('structure-action-deconstruct');
    fireEvent.pointerDown(btn);
    act(() => { vi.advanceTimersByTime(DECONSTRUCT_HOLD_MS - 100); });
    fireEvent.pointerUp(btn);
    expect(btn).toHaveAttribute('data-holding', '0');
    act(() => { vi.advanceTimersByTime(DECONSTRUCT_HOLD_MS); });
    fireEvent.click(btn);
    fireEvent.pointerDown(btn);
    fireEvent.pointerLeave(btn);
    act(() => { vi.advanceTimersByTime(DECONSTRUCT_HOLD_MS); });
    expect(send).not.toHaveBeenCalled();
  });

  it('a running deconstruction cancels with one tap', () => {
    const send = seed('solar', { built: false, isDeconstructing: true });
    const btn = screen.getByTestId('structure-action-deconstruct');
    expect(btn).toHaveAttribute('data-active', '1');
    fireEvent.click(btn);
    expect(send).toHaveBeenCalledWith('structure_action', deconMsg);
  });

  it('Deconstruct is the last control in the tab', () => {
    seed('connector');
    const buttons = [...screen.getByTestId('structure-settings-manage').querySelectorAll('button[data-testid]')];
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([
      'structure-action-upgrade', 'structure-action-reconnect', 'structure-action-clear', 'structure-action-deconstruct',
    ]);
  });

  it('Reconnect and Clear send their actions', () => {
    const send = seed('connector');
    fireEvent.click(screen.getByTestId('structure-action-reconnect'));
    fireEvent.click(screen.getByTestId('structure-action-clear'));
    expect(send).toHaveBeenCalledWith('structure_action', { type: 'structure_action', id: 9, action: 'reconnect' });
    expect(send).toHaveBeenCalledWith('structure_action', { type: 'structure_action', id: 9, action: 'clear_connections' });
  });

  it('the Upgrade card shows the next level, minerals and goods chips, and sends the upgrade', () => {
    const send = seed('turret', { level: 2 });
    const card = screen.getByTestId('structure-upgrade-card');
    expect(card).toHaveTextContent('Lv 2 → 3');
    expect(within(card).getByTestId('structure-upgrade-minerals')).toHaveTextContent(/\d+ minerals/);
    expect(within(card).getByTestId('cost-chip-alloy')).toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('structure-action-upgrade'));
    const msg = { type: 'upgrade_structure', entityId: 9 };
    expect(send).toHaveBeenCalledWith('upgrade_structure', msg);
    expect(UpgradeStructureSchema.safeParse(msg).success).toBe(true);
  });

  it('a level-1 upgrade costs minerals only (no goods chips)', () => {
    seed('turret');
    expect(screen.getByTestId('structure-upgrade-card')).toHaveTextContent('Lv 1 → 2');
    expect(screen.queryByTestId('structure-upgrade-goods')).toBeNull();
  });
});
