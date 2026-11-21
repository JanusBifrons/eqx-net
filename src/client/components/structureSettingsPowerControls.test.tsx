/**
 * Lock for the owner's power controls on the building settings window's
 * Power tab: On/Off and the Throttle slider send `set_structure_power`
 * (passing its server schema), a turret has On/Off only, a building with no
 * Off (a generator) has no controls, and the tab shows the state's throttle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { StructureSettingsModal } from './StructureSettingsModal.js';
import { SetStructurePowerSchema } from '../../shared-types/messages.js';

type Extra = { switchedOff?: boolean; throttle?: number; netPower?: number; powered?: boolean; prodState?: number; drawFull?: boolean };
function seed(kind: string, extra: Extra = {}): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  setGameClient({
    getRoom: () => ({ send }),
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[9, { powered: true, netPower: 35, connTo: [3], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', ...extra }]]),
      swarm: new Map([[9, { kind: 2, shipKind: kind, radius: 36, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  render(<StructureSettingsModal open entityId={9} title="Building" onClose={() => {}} />);
  return send;
}

function sentPower(send: ReturnType<typeof vi.fn>): unknown {
  expect(send).toHaveBeenCalledTimes(1);
  const [type, msg] = send.mock.calls[0]!;
  expect(type).toBe('set_structure_power');
  expect(SetStructurePowerSchema.safeParse(msg).success).toBe(true);
  return msg;
}

describe('structure settings power controls', () => {
  afterEach(() => { setGameClient(null); });

  it('the slider sends 40%', () => {
    const send = seed('miner');
    fireEvent.change(screen.getByTestId('settings-power-throttle-input'), { target: { value: 4 } });
    expect(sentPower(send)).toEqual({ type: 'set_structure_power', entityId: 9, on: true, throttle: 4 });
    expect(screen.getByTestId('settings-power-throttle-value')).toHaveTextContent('40%');
  });

  it('the toggle sends Off', () => {
    const send = seed('miner');
    expect(screen.getByTestId('settings-power-switch')).toHaveAttribute('data-on', '1');
    fireEvent.click(screen.getByTestId('settings-power-toggle'));
    expect(sentPower(send)).toEqual({ type: 'set_structure_power', entityId: 9, on: false });
  });

  it('a turret shows On/Off but no throttle', () => {
    const send = seed('turret', { switchedOff: true });
    expect(screen.getByTestId('settings-power-switch')).toHaveAttribute('data-on', '0');
    expect(screen.queryByTestId('settings-power-throttle')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-power-toggle'));
    expect(sentPower(send)).toEqual({ type: 'set_structure_power', entityId: 9, on: true });
  });

  it('a non-switchable building has no power controls', () => {
    seed('solar');
    // The Power tab keeps its read-only numbers (a generator's output); only the controls go.
    expect(screen.getByTestId('structure-settings-power')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-power-switch')).toBeNull();
    expect(screen.queryByTestId('settings-power-throttle')).toBeNull();
  });

  it('the tab shows the current throttle from state', () => {
    seed('miner', { throttle: 7 });
    expect(screen.getByTestId('settings-power-throttle')).toHaveAttribute('data-throttle', '7');
    expect(screen.getByTestId('settings-power-throttle-value')).toHaveTextContent('70%');
    expect(screen.getByTestId('settings-power-throttle-input')).toHaveValue('7');
  });
});
