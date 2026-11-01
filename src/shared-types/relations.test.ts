import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  cargoOpensFor,
  createRelationContext,
  isNpcOwner,
  npcOwner,
  parseOwner,
  relationOf,
  type Relation,
} from './relations.js';

/** A minimal ledger for these tests (the real one lives in src/core and has its
 *  own tests; shared-types must not import core). */
class HostileActLedger {
  private readonly m = new Map<string, number>();
  record(actor: string, owner: string, nowMs: number, cooldownMs = 600_000): void {
    this.m.set(`${actor}|${owner}`, nowMs + cooldownMs);
  }
  isHostile(actor: string, owner: string, nowMs: number): boolean {
    const until = this.m.get(`${actor}|${owner}`);
    return until !== undefined && until > nowMs;
  }
}

const A = '6a7e0000-0000-4000-8000-0000000000a1';
const B = '6a7e0000-0000-4000-8000-0000000000b2';

describe('parseOwner', () => {
  it('reads players, NPC sides and NPC bases', () => {
    expect(parseOwner(A)).toMatchObject({ kind: 'player', id: A });
    expect(parseOwner('scenario')).toMatchObject({ kind: 'player' });
    expect(parseOwner('npc:robots')).toMatchObject({ kind: 'npc', allegiance: 'robots', baseId: '' });
    expect(parseOwner('npc:traders:sol-3')).toMatchObject({ kind: 'npc', allegiance: 'traders', baseId: 'sol-3' });
  });
  it('treats an unknown allegiance as a plain id, never an NPC side', () => {
    expect(parseOwner('npc:pirates:x').kind).toBe('player');
    expect(parseOwner('npc:').kind).toBe('player');
  });
  it('round-trips npcOwner and caches parses', () => {
    expect(parseOwner(npcOwner('drones', 'b7'))).toMatchObject({ allegiance: 'drones', baseId: 'b7' });
    expect(parseOwner(npcOwner('drones'))).toMatchObject({ allegiance: 'drones', baseId: '' });
    expect(parseOwner('npc:robots:r1')).toBe(parseOwner('npc:robots:r1'));
    expect(isNpcOwner('npc:robots:r1')).toBe(true);
    expect(isNpcOwner(A)).toBe(false);
  });
});

describe('relationOf — truth table', () => {
  const ctx = createRelationContext();
  const cases: Array<[string, string, Relation]> = [
    [A, A, 'self'],
    [A, B, 'neutral'],
    [A, 'scenario', 'neutral'],
    [A, '', 'neutral'],
    // NPC sides among themselves (allegiances.ts stance table).
    ['npc:robots', 'npc:robots:r1', 'friendly'],
    ['npc:traders:t1', 'npc:traders:t2', 'friendly'],
    ['npc:robots', 'npc:drones:d1', 'hostile'],
    ['npc:robots', 'npc:traders:t1', 'hostile'],
    ['npc:traders', 'npc:robots:r1', 'hostile'], // mutual: robots attack traders
    ['npc:drones', 'npc:traders:t1', 'neutral'],
    // Players and NPC parties (the worse direction).
    [A, 'npc:robots:r1', 'hostile'],
    ['npc:robots', A, 'hostile'],
    [A, 'npc:traders:t1', 'neutral'],
    ['npc:traders', A, 'neutral'],
    [A, 'npc:drones:d1', 'neutral'],
  ];
  for (const [actor, owner, want] of cases) {
    it(`${actor || '""'} → ${owner || '""'} is ${want}`, () => {
      expect(relationOf(actor, owner, ctx)).toBe(want);
    });
  }
});

describe('relationOf — providers', () => {
  it('alliances make two players allied', () => {
    const ctx = createRelationContext({ alliances: { areAllied: (a, b) => (a === A && b === B) || (a === B && b === A) } });
    expect(relationOf(A, B, ctx)).toBe('allied');
    expect(relationOf(B, A, ctx)).toBe('allied');
    expect(relationOf(A, 'scenario', ctx)).toBe('neutral');
  });

  it('a hostile act beats an alliance and cools down', () => {
    const acts = new HostileActLedger();
    const ctx = createRelationContext({ alliances: { areAllied: () => true }, hostileActs: acts, nowMs: 1000 });
    acts.record(A, B, 1000, 5000);
    expect(relationOf(A, B, ctx)).toBe('hostile');
    expect(relationOf(B, A, ctx)).toBe('allied'); // directional: B did nothing to A
    ctx.nowMs = 6000;
    expect(relationOf(A, B, ctx)).toBe('allied');
  });

  it('a hostile act against an NPC base makes a neutral side hostile', () => {
    const acts = new HostileActLedger();
    const ctx = createRelationContext({ hostileActs: acts });
    expect(relationOf(A, 'npc:traders:t1', ctx)).toBe('neutral');
    acts.record(A, 'npc:traders:t1', 0);
    expect(relationOf(A, 'npc:traders:t1', ctx)).toBe('hostile');
    expect(relationOf(A, 'npc:traders:t2', ctx)).toBe('neutral'); // only that base
  });

  it('an NPC stance override (a robot truce) replaces the table', () => {
    const ctx = createRelationContext({
      npcStanceToPlayer: (allegiance, player) => (allegiance === 'robots' && player === A ? 'neutral' : undefined),
    });
    expect(relationOf(A, 'npc:robots:r1', ctx)).toBe('neutral');
    expect(relationOf(B, 'npc:robots:r1', ctx)).toBe('hostile');
  });
});

describe('relationOf — parity with the pre-B1 gate rule', () => {
  // Before B1 a gate saw a ship as 'self' (same player) or 'neutral'. With no
  // alliances, no hostile acts and only player owners, nothing may change.
  it('player pairs keep self / neutral', () => {
    const ctx = createRelationContext();
    const id = fc.oneof(fc.uuid(), fc.constantFrom('scenario', A, B));
    fc.assert(
      fc.property(id, id, (actor, owner) => {
        expect(relationOf(actor, owner, ctx)).toBe(actor === owner ? 'self' : 'neutral');
      }),
    );
  });
});

describe('cargoOpensFor', () => {
  it('opens for friendly, for allies only when allowed, never for others', () => {
    expect(cargoOpensFor('self', false)).toBe(true);
    expect(cargoOpensFor('friendly', false)).toBe(true);
    expect(cargoOpensFor('allied', false)).toBe(false);
    expect(cargoOpensFor('allied', true)).toBe(true);
    expect(cargoOpensFor('neutral', true)).toBe(false);
    expect(cargoOpensFor('hostile', true)).toBe(false);
  });
});
