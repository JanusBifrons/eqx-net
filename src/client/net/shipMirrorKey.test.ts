/**
 * The one ship-key rule (RTS Part A S0). Before S0 the snapshot router and
 * `syncMirror` each carried a copy and disagreed when the welcome carried no
 * ship id; this table locks the single answer both now use, including that
 * decision (see `shipMirrorKey.ts`).
 */
import { describe, it, expect } from 'vitest';
import { shipMirrorKey, type ShipMirrorKeyLocal } from './shipMirrorKey.js';

const ME = 'P';
const local = (o: Partial<ShipMirrorKeyLocal> = {}): ShipMirrorKeyLocal => ({
  localPlayerId: ME, localShipInstanceId: 'S-welcome', localSpectating: false, ...o,
});

interface Row {
  name: string;
  sid: string;
  playerId: string;
  isActive: boolean;
  local: ShipMirrorKeyLocal;
  expected: string | null;
}

const ROWS: Row[] = [
  { name: 'own active ship (flying)', sid: 'S-welcome', playerId: ME, isActive: true, local: local(), expected: ME },
  { name: 'welcome ship pending join (inactive) stays the ship I fly', sid: 'S-welcome', playerId: ME, isActive: false, local: local(), expected: ME },
  { name: 'displaced own hull is a parked hull', sid: 'S-old', playerId: ME, isActive: false, local: local(), expected: 'S-old' },
  { name: 'spectating: the own hull I parked is a parked hull', sid: 'S-welcome', playerId: ME, isActive: false, local: local({ localSpectating: true }), expected: 'S-welcome' },
  { name: 'spectate race: own ACTIVE entry while spectating is not drawn', sid: 'S-welcome', playerId: ME, isActive: true, local: local({ localSpectating: true }), expected: null },
  { name: 'remote active ship', sid: 'S-q', playerId: 'Q', isActive: true, local: local(), expected: 'Q' },
  { name: 'remote active ship while I spectate', sid: 'S-q', playerId: 'Q', isActive: true, local: local({ localSpectating: true }), expected: 'Q' },
  { name: 'remote parked hull', sid: 'S-q', playerId: 'Q', isActive: false, local: local(), expected: 'S-q' },
  { name: 'remote parked hull sharing my welcome id is still theirs', sid: 'S-welcome', playerId: 'Q', isActive: false, local: local(), expected: 'S-welcome' },
  { name: 'localPlayerId null (pre-welcome): an active ship keys by playerId', sid: 'S-x', playerId: ME, isActive: true, local: local({ localPlayerId: null, localShipInstanceId: null }), expected: ME },
  { name: 'localPlayerId null (pre-welcome): an inactive ship is a parked hull', sid: 'S-x', playerId: ME, isActive: false, local: local({ localPlayerId: null, localShipInstanceId: null }), expected: 'S-x' },
  // The decided null-id case: no welcome ship ⇒ nothing is pending, so no
  // own hull is claimed by playerId (several could fight over that key).
  { name: 'null welcome id: own inactive hull is a parked hull', sid: 'S-a', playerId: ME, isActive: false, local: local({ localShipInstanceId: null }), expected: 'S-a' },
  { name: 'null welcome id: own active ship still keys by playerId', sid: 'S-a', playerId: ME, isActive: true, local: local({ localShipInstanceId: null }), expected: ME },
];

describe('shipMirrorKey', () => {
  for (const r of ROWS) {
    it(r.name, () => {
      expect(shipMirrorKey(r.sid, r.playerId, r.isActive, r.local)).toBe(r.expected);
    });
  }

  it('null welcome id: two own inactive hulls never collide on one key', () => {
    const l = local({ localShipInstanceId: null });
    const a = shipMirrorKey('S-a', ME, false, l);
    const b = shipMirrorKey('S-b', ME, false, l);
    expect(a).not.toBe(b);
  });
});
