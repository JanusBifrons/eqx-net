import { describe, it, expect } from 'vitest';
import { FactionLedger } from './FactionLedger.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';

/** Minimal StructureRecord factory — only the fields the ledger reads. */
function struct(id: string, owner: string, kind: StructureRecord['kind'] = 'turret'): StructureRecord {
  return {
    id,
    owner,
    kind,
    subtypeIndex: 0,
    x: 0,
    y: 0,
    radius: 10,
    isConstructed: true,
    constructionProgress: 0,
    constructionCost: 0,
    isDeconstructing: false,
    minerals: 0,
    storedPower: 0,
  };
}

function makeLedger(structures: StructureRecord[]) {
  // Mutable backing array so tests can add/remove structures between calls and
  // confirm the ledger derives membership live (never a stale copy).
  const store = structures;
  const ledger = new FactionLedger({ structures: () => store });
  return { ledger, store };
}

// WS-11 (R2.24 Part B) — base-ready one-shot latch: the "your base is
// operational" toast fires EXACTLY ONCE per ready transition.
describe('FactionLedger — base-ready one-shot (R2.24 Part B)', () => {
  it('markReadyNotified returns true exactly ONCE, then false', () => {
    const { ledger } = makeLedger([]);
    expect(ledger.markReadyNotified('alice')).toBe(true); // first ready → toast
    expect(ledger.markReadyNotified('alice')).toBe(false); // stays latched
    expect(ledger.markReadyNotified('alice')).toBe(false);
  });

  it('clearReadyNotified re-arms the latch (razed-then-rebuilt base re-toasts)', () => {
    const { ledger } = makeLedger([]);
    expect(ledger.markReadyNotified('alice')).toBe(true);
    ledger.clearReadyNotified('alice'); // base dropped below ready
    expect(ledger.markReadyNotified('alice')).toBe(true); // toasts again on re-qualify
  });

  it('clearReadyNotified on an unobserved faction is a safe no-op', () => {
    const { ledger } = makeLedger([]);
    expect(() => ledger.clearReadyNotified('nobody')).not.toThrow();
    // First observation still toasts.
    expect(ledger.markReadyNotified('nobody')).toBe(true);
  });

  it('the latch is per-faction', () => {
    const { ledger } = makeLedger([]);
    expect(ledger.markReadyNotified('alice')).toBe(true);
    expect(ledger.markReadyNotified('bob')).toBe(true); // independent
    expect(ledger.markReadyNotified('alice')).toBe(false);
  });
});

describe('FactionLedger — membership derivation', () => {
  it('membersOf returns the player + their owned structures, derived live', () => {
    const { ledger, store } = makeLedger([
      struct('swarm-1', 'alice', 'capital'),
      struct('swarm-2', 'alice', 'miner'),
      struct('swarm-3', 'bob', 'turret'),
    ]);
    expect(ledger.membersOf('alice')).toEqual({
      playerId: 'alice',
      structureIds: ['swarm-1', 'swarm-2'],
    });
    // Add another of alice's structures → membership reflects it with no
    // re-construction (derived on demand, not copied).
    store.push(struct('swarm-4', 'alice', 'solar'));
    expect(ledger.membersOf('alice').structureIds).toEqual(['swarm-1', 'swarm-2', 'swarm-4']);
  });

  it('membersOf is empty for a player owning nothing', () => {
    const { ledger } = makeLedger([struct('swarm-1', 'alice')]);
    expect(ledger.membersOf('carol')).toEqual({ playerId: 'carol', structureIds: [] });
  });
});

describe('FactionLedger — factionOf reverse lookup', () => {
  it('a structure id maps to its owner', () => {
    const { ledger } = makeLedger([struct('swarm-9', 'alice', 'capital')]);
    expect(ledger.factionOf('swarm-9')).toBe('alice');
  });

  it('a player id that owns ≥1 structure maps to itself', () => {
    const { ledger } = makeLedger([struct('swarm-9', 'alice', 'capital')]);
    expect(ledger.factionOf('alice')).toBe('alice');
  });

  it('a player id owning nothing → null (no faction)', () => {
    const { ledger } = makeLedger([struct('swarm-9', 'alice')]);
    expect(ledger.factionOf('bob')).toBeNull();
  });

  it('a drone / unknown id → null', () => {
    const { ledger } = makeLedger([struct('swarm-9', 'alice')]);
    expect(ledger.factionOf('swarm-404')).toBeNull();
    expect(ledger.factionOf('drone-xyz')).toBeNull();
  });
});

describe('FactionLedger — hostility + wave state', () => {
  it('markFactionHostileToDrones flips the flag (idempotent, creates state)', () => {
    const { ledger } = makeLedger([struct('swarm-1', 'alice')]);
    expect(ledger.isHostileToDrones('alice')).toBe(false);
    ledger.markFactionHostileToDrones('alice');
    ledger.markFactionHostileToDrones('alice');
    expect(ledger.isHostileToDrones('alice')).toBe(true);
  });

  it('recordFactionDealtDamage anchors the tick AND marks hostile', () => {
    const { ledger } = makeLedger([]);
    ledger.recordFactionDealtDamage('alice', 4242);
    const s = ledger.get('alice')!;
    expect(s.lastDealtDamageTick).toBe(4242);
    expect(s.hostileToDrones).toBe(true);
  });

  it('setUnderWave(true) gates targeting AND implies hostile; (false) clears wave only', () => {
    const { ledger } = makeLedger([]);
    ledger.setUnderWave('alice', true);
    expect(ledger.get('alice')!.underWave).toBe(true);
    expect(ledger.isHostileToDrones('alice')).toBe(true);
    ledger.setUnderWave('alice', false);
    expect(ledger.get('alice')!.underWave).toBe(false);
    // Standing down a wave does NOT auto-clear hostility — de-escalation +
    // purge is the WaveDirector's explicit job (Phase 6).
    expect(ledger.isHostileToDrones('alice')).toBe(true);
  });

  it('forget drops the state (keeps the map bounded)', () => {
    const { ledger } = makeLedger([]);
    ledger.markFactionHostileToDrones('alice');
    expect(ledger.get('alice')).toBeDefined();
    ledger.forget('alice');
    expect(ledger.get('alice')).toBeUndefined();
    expect(ledger.isHostileToDrones('alice')).toBe(false);
  });

  it('isHostileToDrones is false for an unobserved faction', () => {
    const { ledger } = makeLedger([]);
    expect(ledger.isHostileToDrones('nobody')).toBe(false);
  });
});
