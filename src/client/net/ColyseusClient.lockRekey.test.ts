/**
 * RTS Part A — a lock on a ship follows it when its key moves, the client side
 * (#15 with the server's `LockSubsystem.shipKeyMoved`).
 *
 * Another pilot takes their AI-flown hull's controls: the ship's mirror key
 * moves shipInstanceId → playerId (`rekeyShip`), and its lock key with it
 * (`p:<sid>` → `p:<playerId>`). Until the next snapshot's `groups` slice (which
 * the server already re-keyed, #16) the own groups, the lock-line candidate
 * and the last `lock_track` sent must name the new key, or the lock marks,
 * turret aim and fire gate lose the ship for a frame and the lock line resends
 * (or lets go of) the same ship.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

type Internals = {
  mirror: RenderMirror;
  /** FireControlClient internals (the lock line holds the last track). */
  fc: {
    line: { _trackKey: string | null };
    applyFcGroups(groups: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number }> }>): void;
  };
  rekeyShip(from: string, to: string): void;
};

describe('lock state follows a re-keyed ship (RTS Part A)', () => {
  it('another pilot takes their hull: own lock targets, lock-line candidate and held track move to the new key', () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    c.mirror.localPlayerId = 'p-me';
    c.mirror.ships.set('ship-b', { x: 0, y: 300, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive: false, ownerPlayerId: 'p-b' });
    c.fc.applyFcGroups([{ id: 'primary', m: 1, l: [{ t: 'p:ship-b', s: 2, p: 100 }, { t: 's:7', s: 2, p: 100 }] }]);
    c.mirror.localLockCandidate = 'p:ship-b';
    c.fc.line._trackKey = 'p:ship-b';

    c.rekeyShip('ship-b', 'p-b');

    expect(c.mirror.localGroups![0]!.l.map((l) => l.t)).toEqual(['p:p-b', 's:7']);
    expect(c.mirror.localLockCandidate).toBe('p:p-b');
    expect(c.fc.line._trackKey, 'no resend and no let-go for the same ship').toBe('p:p-b');

    // ...and back when they let go.
    c.rekeyShip('p-b', 'ship-b');
    expect(c.mirror.localGroups![0]!.l[0]!.t).toBe('p:ship-b');
    expect(c.fc.line._trackKey).toBe('p:ship-b');
  });
});
