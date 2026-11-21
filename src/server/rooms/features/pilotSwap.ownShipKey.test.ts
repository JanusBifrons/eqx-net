/**
 * `PilotSwap.ownShipKey` — the ship whose hold is "mine" for building: the hull
 * I fly, else the hull I parked by Command / Build (a lingering hull here).
 *
 * Bug (Quick Launch, live): a fresh pilot lands in Command view, so the starter
 * Capital crate sits in their PARKED hull's hold; Build mode always lets go of
 * the ship too. The packed stock / build gate looked only at the ACTIVE hull,
 * so Build said "Capital · needs packed" with the crate in the hold.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/PersistenceWorker.js', () => ({ getPlayerShipStore: () => null }));

import { PilotSwap, type PilotSwapHost } from './pilotSwap.js';

function swap(opts: { active?: string; parked?: string; lingering?: boolean; owner?: string }): PilotSwap {
  const ships = new Map<string, { playerId: string }>();
  if (opts.parked) ships.set(opts.parked, { playerId: opts.owner ?? 'p1' });
  const host = {
    state: () => ({ ships }),
    playerToActiveShipInstance: new Map(opts.active ? [['p1', opts.active]] : []),
    lingeringSlots: new Map(opts.parked && opts.lingering !== false ? [[opts.parked, 3]] : []),
    spectateParkedHull: new Map(opts.parked ? [['p1', opts.parked]] : []),
  } as unknown as PilotSwapHost;
  return new PilotSwap(host);
}

describe('PilotSwap.ownShipKey', () => {
  it('the flown hull when flying', () => {
    expect(swap({ active: 'hull-a' }).ownShipKey('p1')).toBe('hull-a');
  });

  it('the parked hull in Command / Build view (no active hull)', () => {
    expect(swap({ parked: 'hull-a' }).ownShipKey('p1')).toBe('hull-a');
  });

  it('nothing when the parked hull left this room or is not theirs', () => {
    expect(swap({ parked: 'hull-a', lingering: false }).ownShipKey('p1')).toBeUndefined();
    expect(swap({ parked: 'hull-a', owner: 'p2' }).ownShipKey('p1')).toBeUndefined();
    expect(swap({}).ownShipKey('p1')).toBeUndefined();
  });
});
