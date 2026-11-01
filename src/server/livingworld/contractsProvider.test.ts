import { describe, expect, it } from 'vitest';
import { buildContracts } from './contractsProvider.js';
import { ContractsResponseSchema, ELITE_BOUNTY_CREDITS, MOTHERSHIP_BOUNTY_CREDITS } from '../../shared-types/contracts.js';

describe('buildContracts (P4c)', () => {
  it('is an empty board with no provider (Living World off)', () => {
    expect(buildContracts(null)).toEqual({ contracts: [] });
  });

  it('lists each elite with its bounty, then the running event', () => {
    const board = buildContracts({
      elites: () => [{ id: 'elite-0', name: 'Dread Vexis', kind: 'gunship', sectorKey: 'greenfall' }],
      activeEvent: () => ({ kind: 'mothership', title: 'Drone Mothership', endsAtMs: 5000, sectorKey: 'emerald-span' }),
    });
    expect(ContractsResponseSchema.safeParse(board).success).toBe(true);
    expect(board.contracts).toHaveLength(2);
    const [elite, event] = board.contracts;
    expect(elite).toMatchObject({ kind: 'elite', title: 'Dread Vexis', sectorKey: 'greenfall', rewardCredits: ELITE_BOUNTY_CREDITS, endsAtMs: null });
    expect(elite!.detail).toContain('elite');
    expect(event).toMatchObject({ kind: 'event', title: 'Drone Mothership', rewardCredits: MOTHERSHIP_BOUNTY_CREDITS, endsAtMs: 5000 });
  });

  it('a loot event (incursion / salvage) has no credit bounty', () => {
    const board = buildContracts({
      elites: () => [],
      activeEvent: () => ({ kind: 'salvage', title: 'Salvage Field', endsAtMs: 1, sectorKey: 'greenfall' }),
    });
    expect(board.contracts[0]!.rewardCredits).toBeNull();
  });
});
