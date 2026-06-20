/**
 * Phase 4 WS-A2 — client-side `pilot_ship` send (the in-world Pilot action).
 *
 * `sendPilotShip(shipId)` routes a same-sector instant pilot swap to the server
 * over the live room socket. It also kicks off the client-side transition
 * (clear spectator + arm the camera glide + re-anchor self-prediction) via the
 * game client. The send is a no-op (returns false) when there's no live room.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendPilotShip } from './shipActionsClient.js';

const send = vi.fn();
const pilotInSectorShip = vi.fn();
let hasRoom = true;
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () =>
    ({
      getRoom: () => (hasRoom ? { send } : null),
      pilotInSectorShip,
    }) as unknown,
}));

describe('sendPilotShip (Phase 4 WS-A2)', () => {
  beforeEach(() => {
    send.mockClear();
    pilotInSectorShip.mockClear();
    hasRoom = true;
  });

  it('drives the game client’s pilotInSectorShip (which owns the send + transition)', () => {
    pilotInSectorShip.mockReturnValue(true);
    const ok = sendPilotShip('ship-abc');
    expect(ok).toBe(true);
    expect(pilotInSectorShip).toHaveBeenCalledWith('ship-abc');
  });

  it('returns false (no-op) when there is no live room', () => {
    hasRoom = false;
    pilotInSectorShip.mockReturnValue(false);
    const ok = sendPilotShip('ship-abc');
    expect(ok).toBe(false);
  });
});
