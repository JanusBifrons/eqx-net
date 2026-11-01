import { describe, expect, it } from 'vitest';
import { bountyUid, parseBountyUid } from './BountyBoard.js';
import { buildContracts } from '../livingworld/contractsProvider.js';
import { pvpBountyCost } from '../../shared-types/contracts.js';

describe('player bounties (P4c-2)', () => {
  it('escrow uids round-trip (target, placer)', () => {
    const uid = bountyUid('t-1', 'p-2');
    expect(parseBountyUid(uid)).toEqual({ target: 't-1', placer: 'p-2' });
    expect(parseBountyUid('hauler-1')).toBeNull();
    expect(parseBountyUid('bounty:onlyone')).toBeNull();
  });

  it('a bounty costs the amount plus a 25 % burned fee', () => {
    expect(pvpBountyCost(100)).toBe(125);
    expect(pvpBountyCost(401)).toBe(502);
  });

  it('open bounties show on the Contracts board by name, never by id', () => {
    const board = buildContracts({
      elites: () => [],
      activeEvent: () => null,
      bounties: () => [{ target: 'abc-uuid', targetName: 'Vex', credits: 900, lastSector: null }],
    });
    expect(board.contracts).toEqual([
      expect.objectContaining({ kind: 'player', title: 'Wanted: Vex', rewardCredits: 900, sectorKey: '' }),
    ]);
    expect(board.contracts[0]!.title).not.toContain('abc-uuid');
  });
});
