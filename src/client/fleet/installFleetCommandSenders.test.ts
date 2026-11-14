import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../ships/shipActionsClient.js', () => ({
  sendPilotShip: vi.fn(),
  sendSetMode: vi.fn(),
  sendSetStance: vi.fn(),
  sendFleetOrder: vi.fn(),
  sendFormSquad: vi.fn(),
  sendDisbandSquad: vi.fn(),
}));

import * as senders from '../ships/shipActionsClient.js';
import { fleetCommands, resetFleetCommands } from './fleetCommands.js';
import { installFleetCommandSenders } from './installFleetCommandSenders.js';

describe('installFleetCommandSenders', () => {
  afterEach(() => {
    resetFleetCommands();
    vi.clearAllMocks();
  });

  it('before install the panel commands send nothing', () => {
    fleetCommands().setMode(['a'], 'defend');
    fleetCommands().stop(['a']);
    expect(senders.sendSetMode).not.toHaveBeenCalled();
    expect(senders.sendFleetOrder).not.toHaveBeenCalled();
  });

  it('plugs every panel command into its network sender', () => {
    installFleetCommandSenders();
    const ids = Object.freeze(['me', 'hull-1']) as readonly string[];
    const c = fleetCommands();

    c.setMode(ids, 'defend');
    expect(senders.sendSetMode).toHaveBeenCalledWith(['me', 'hull-1'], 'defend');

    c.setMode(ids, 'patrol', { route: [[0, 0], [10, 5]] });
    expect(senders.sendSetMode).toHaveBeenLastCalledWith(['me', 'hull-1'], 'patrol', { route: [[0, 0], [10, 5]] });
    c.setMode(ids, 'retreat', { x: 4, y: -2 });
    expect(senders.sendSetMode).toHaveBeenLastCalledWith(['me', 'hull-1'], 'retreat', { x: 4, y: -2 });

    c.setStance(ids, 'holdFire');
    expect(senders.sendSetStance).toHaveBeenCalledWith(['me', 'hull-1'], 'holdFire');

    c.stop(ids);
    expect(senders.sendFleetOrder).toHaveBeenCalledWith(['me', 'hull-1'], { kind: 'stop' });

    c.formSquad(ids);
    expect(senders.sendFormSquad).toHaveBeenCalledWith(['me', 'hull-1']);

    c.disbandSquad('sq-1');
    expect(senders.sendDisbandSquad).toHaveBeenCalledWith('sq-1');

    // the ids array handed to a sender is a copy (senders take mutable arrays)
    const passed = vi.mocked(senders.sendSetMode).mock.calls[0]![0];
    expect(passed).not.toBe(ids);
  });

  it('keeps the default takeControls (sendPilotShip)', () => {
    installFleetCommandSenders();
    fleetCommands().takeControls('hull-1');
    expect(senders.sendPilotShip).toHaveBeenCalledWith('hull-1');
  });
});
