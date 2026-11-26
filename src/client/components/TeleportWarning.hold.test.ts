/**
 * Gate swap (take 19 review): after the jump fires the picture holds the old
 * room until landing, so the ship still sits on the old, sealed gate in the
 * mirror. The warning must not read "Sealed. Charging up…" after the jump.
 */
import { describe, expect, it, vi } from 'vitest';
import { TP_PHASE } from '../../shared-types/teleport';

let holding = false;
const mirror = {
  localPlayerId: 'me',
  ships: new Map([['me', { x: 0, y: 0 }]]),
  structures: new Map([[7, { teleport: { phase: TP_PHASE.SEALED } }]]),
  swarm: new Map([[7, { shipKind: 'alien_gate', x: 0, y: 0, angle: 0 }]]),
};
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => ({ mirror, holdingPicture: () => holding }) }));

import { localPadWarning } from './TeleportWarning';

describe('localPadWarning across a gate swap', () => {
  it('warns while sealed on the gate, and says nothing once the jump has fired (picture held)', () => {
    holding = false;
    expect(localPadWarning()?.text).toBe('Sealed. Charging up…');
    holding = true;
    expect(localPadWarning()).toBeUndefined();
  });
});
