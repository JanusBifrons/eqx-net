/**
 * Capture plan 4E — an ownerless base has no faction, so it holds no standing:
 * breaking into it or shooting it moves nobody's view of anybody.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { adjustStanding, RoomHitStanding, type RoomHitStandingHost } from './hitStanding.js';
import { setTradeSink, type TradeSink } from '../../economy/tradeSink.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';
import { unownedOwner } from '../../../shared-types/relations.js';

const NONE = unownedOwner('pstruct-cap');

function sink(): { calls: Array<[string, string, number]> } {
  const calls: Array<[string, string, number]> = [];
  setTradeSink({ adjustStanding: (f: string, t: string, d: number) => { calls.push([f, t, d]); } } as unknown as TradeSink);
  return { calls };
}

afterEach(() => setTradeSink(null));

describe('standing and an ownerless base (capture 4E)', () => {
  it('a break-in standing change against it is dropped; a player one still lands', () => {
    const { calls } = sink();
    adjustStanding(NONE, 'alice', -5);
    adjustStanding('alice', NONE, -5);
    adjustStanding('bob', 'alice', -5);
    expect(calls).toEqual([['bob', 'alice', -5]]);
  });

  it('a hit on its structure moves no standing', () => {
    const { calls } = sink();
    const structs = new Map<string, StructureRecord>([
      ['s1', { id: 's1', owner: NONE } as StructureRecord],
      ['s2', { id: 's2', owner: 'bob' } as StructureRecord],
    ]);
    const host = {
      swarmRegistry: { get: () => undefined },
      gameClock: { now: () => 0 },
      playerToSlot: () => new Map([['alice', 0]]),
      structureRegistry: () => ({ get: (id: string) => structs.get(id) }),
    } as unknown as RoomHitStandingHost;
    const hs = new RoomHitStanding(host);
    hs.noteStandingHit('s1', 'alice');
    expect(calls).toEqual([]);
    hs.noteStandingHit('s2', 'alice'); // control: an owned base minds
    expect(calls.length).toBe(1);
  });
});
