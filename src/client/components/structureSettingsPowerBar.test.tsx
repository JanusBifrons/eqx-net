/**
 * Lock for the Power tab's grid bar (green "+N spare" / red "−N short", this
 * building's share marked), the throttle presets (sent on
 * `set_structure_power`, passing its server schema, with the working draw at
 * the picked throttle) and the explainer shown when the server holds a
 * processor unpowered on a powered grid.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { StructureSettings } from './StructureSettings.js';
import { SetStructurePowerSchema } from '../../shared-types/messages.js';
import { PROD_STATE } from '../../shared-types/production.js';

function seed(kind: string, st: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  setGameClient({
    getRoom: () => ({ send }),
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[9, { powered: true, netPower: 0, connTo: [3], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', ...st }]]),
      swarm: new Map([[9, { kind: 2, shipKind: kind, radius: 36, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  render(<StructureSettings entityId={9} />);
  return send;
}

describe('structure settings power bar', () => {
  afterEach(() => { setGameClient(null); });

  it('a grid with a surplus reads green "+14 spare" with this building marked', () => {
    seed('miner', { netPower: 14, drawFull: true });
    const bar = screen.getByTestId('settings-power-bar');
    expect(bar).toHaveAttribute('data-state', 'surplus');
    expect(bar).toHaveAttribute('data-share', '60');
    expect(screen.getByTestId('settings-power-bar-label')).toHaveTextContent('+14 spare');
    expect(screen.getByTestId('settings-power-bar-marker')).toBeInTheDocument();
  });

  it('a short grid reads red "−130 short"', () => {
    seed('miner', { netPower: -130, powered: false, drawFull: true });
    expect(screen.getByTestId('settings-power-bar')).toHaveAttribute('data-state', 'short');
    expect(screen.getByTestId('settings-power-bar-label')).toHaveTextContent('−130 short');
  });

  it('a generator shows the bar too, with no controls', () => {
    seed('solar', { netPower: 25 });
    expect(screen.getByTestId('settings-power-bar')).toHaveAttribute('data-state', 'surplus');
    expect(screen.queryByTestId('settings-power-presets')).toBeNull();
  });

  it('the 50% preset sends throttle 5 and shows the working draw', () => {
    const send = seed('miner', { netPower: 14, drawFull: true });
    expect(screen.getByTestId('power-preset-100')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('power-preset-50'));
    expect(send).toHaveBeenCalledTimes(1);
    const [type, msg] = send.mock.calls[0]!;
    expect(type).toBe('set_structure_power');
    expect(SetStructurePowerSchema.safeParse(msg).success).toBe(true);
    expect(msg).toEqual({ type: 'set_structure_power', entityId: 9, on: true, throttle: 5 });
    expect(screen.getByTestId('power-preset-50')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('settings-power-throttle-value')).toHaveTextContent('50%');
    expect(screen.getByTestId('settings-power-throttle-draw')).toHaveTextContent('-30');
  });

  it('the 0% preset sends throttle 0; the current preset sends nothing', () => {
    const send = seed('miner', { throttle: 0 });
    fireEvent.click(screen.getByTestId('power-preset-0'));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('power-preset-100'));
    expect(send.mock.calls[0]![1]).toEqual({ type: 'set_structure_power', entityId: 9, on: true, throttle: 10 });
  });

  it('a processor held unpowered on a powered grid explains why', () => {
    seed('smelter', { netPower: 14, prodState: PROD_STATE.unpowered });
    expect(screen.getByTestId('settings-power-held'))
      .toHaveTextContent('Not enough power to run at 100% — lower the throttle or build Solar Panels.');
  });

  it('no explainer while running', () => {
    seed('smelter', { netPower: 14, prodState: PROD_STATE.running });
    expect(screen.queryByTestId('settings-power-held')).toBeNull();
  });

  it('no explainer when the grid itself is unpowered (the bar says short)', () => {
    seed('smelter', { netPower: -20, powered: false, prodState: PROD_STATE.unpowered });
    expect(screen.queryByTestId('settings-power-held')).toBeNull();
  });
});
