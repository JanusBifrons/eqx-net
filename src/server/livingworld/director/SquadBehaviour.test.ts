import { describe, it, expect } from 'vitest';
import { WaveSquadBehaviour, type SquadDecisionContext } from './SquadBehaviour.js';
import type { SquadRecord, SquadState } from './SquadPool.js';

const squad = (over: Partial<SquadRecord> = {}): SquadRecord => ({
  squadId: 'squad-0',
  kind: 'fighter',
  botIds: ['lwbot-0', 'lwbot-1'],
  state: 'idle',
  sectorKey: 'sol-prime',
  targetFactionId: null,
  ...over,
});

const ctx = (over: Partial<SquadDecisionContext> = {}): SquadDecisionContext => ({
  membersInSector: 0,
  membersActive: 8,
  factionStillHostile: true,
  ...over,
});

describe('WaveSquadBehaviour.decide', () => {
  const b = new WaveSquadBehaviour();

  it('forming → hold', () => {
    expect(b.decide(squad({ state: 'forming' }), ctx())).toEqual({ kind: 'hold' });
  });

  it('idle + unassigned → hold', () => {
    expect(b.decide(squad({ state: 'idle', targetFactionId: null }), ctx())).toEqual({
      kind: 'hold',
    });
  });

  it('idle + assigned → warp to the target sector', () => {
    const sq = squad({ state: 'idle', sectorKey: 'vega', targetFactionId: 'alice' });
    expect(b.decide(sq, ctx())).toEqual({ kind: 'warp', to: 'vega' });
  });

  it('warping + no members arrived yet → KEEP WARPING (re-advance toward the goal)', () => {
    // Issue 3 fix: a not-yet-arrived warping squad re-emits `warp` every tick so
    // `advanceMembersTowardGoal` keeps hopping members toward a MULTI-HOP goal.
    // Returning `hold` here (the old behaviour) froze a wave after one hop.
    const sq = squad({ state: 'warping', sectorKey: 'vega', targetFactionId: 'alice' });
    expect(b.decide(sq, ctx({ membersInSector: 0 }))).toEqual({ kind: 'warp', to: 'vega' });
  });

  it('warping + no assignment (defensive) → hold', () => {
    const sq = squad({ state: 'warping', sectorKey: 'vega', targetFactionId: null });
    expect(b.decide(sq, ctx({ membersInSector: 0 }))).toEqual({ kind: 'hold' });
  });

  it('warping + members arrived → attack', () => {
    const sq = squad({ state: 'warping', sectorKey: 'vega', targetFactionId: 'alice' });
    expect(b.decide(sq, ctx({ membersInSector: 5 }))).toEqual({
      kind: 'attack',
      factionId: 'alice',
    });
  });

  it('attacking → keep attacking (re-pulse) while the faction is hostile', () => {
    const sq = squad({ state: 'attacking', sectorKey: 'vega', targetFactionId: 'alice' });
    expect(b.decide(sq, ctx({ membersInSector: 4 }))).toEqual({
      kind: 'attack',
      factionId: 'alice',
    });
  });

  it.each<SquadState>(['warping', 'attacking'])(
    'de-escalation overrides %s → retreat',
    (state) => {
      const sq = squad({ state, sectorKey: 'vega', targetFactionId: 'alice' });
      expect(b.decide(sq, ctx({ membersInSector: 4, factionStillHostile: false }))).toEqual({
        kind: 'retreat',
      });
    },
  );

  it('attacking with a cleared assignment → retreat (safety net)', () => {
    const sq = squad({ state: 'attacking', sectorKey: 'vega', targetFactionId: null });
    expect(b.decide(sq, ctx({ membersInSector: 4 }))).toEqual({ kind: 'retreat' });
  });

  it('retreating → hold (director returns it to idle once clear)', () => {
    const sq = squad({ state: 'retreating', sectorKey: 'vega', targetFactionId: null });
    expect(b.decide(sq, ctx())).toEqual({ kind: 'hold' });
  });
});
