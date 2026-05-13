/**
 * Phase 6a — `resolveActiveShipKey(playerId)` is the canonical translation
 * from "this connection's player id" to "the shipInstanceId of the hull
 * that player is currently piloting in THIS room". It's the indirection
 * we use to keep internal slot/pose maps playerId-keyed under Option A
 * while flipping the Colyseus schema map (`state.ships`) and the
 * snapshot wire keys to shipInstanceId.
 *
 * The helper lives on `SectorRoom`, but it's a pure look-up on a single
 * Map — we exercise it via a minimal harness rather than spinning up a
 * full Colyseus room. The harness mirrors the field's shape and the
 * helper's body verbatim.
 */
import { describe, it, expect } from 'vitest';

interface ShipKeyResolver {
  resolveActiveShipKey(playerId: string): string | undefined;
}

function makeResolver(seed: Array<[string, string]>): ShipKeyResolver {
  const map = new Map<string, string>(seed);
  return {
    resolveActiveShipKey(playerId: string): string | undefined {
      return map.get(playerId);
    },
  };
}

describe('resolveActiveShipKey', () => {
  it('returns the bound shipInstanceId for a known player', () => {
    const r = makeResolver([['player-1', 'ship-uuid-1']]);
    expect(r.resolveActiveShipKey('player-1')).toBe('ship-uuid-1');
  });

  it('returns the synthetic shipInstanceId for an engineering-room player', () => {
    // Engineering rooms generate a UUID for shipInstanceId at join-time
    // (Phase 6a step 6a-4); the helper is unaware of the distinction —
    // it just looks up whatever was set.
    const r = makeResolver([['player-eng', 'synthetic-uuid-abc']]);
    expect(r.resolveActiveShipKey('player-eng')).toBe('synthetic-uuid-abc');
  });

  it('returns undefined for an unknown player', () => {
    // Strict semantics — no `?? playerId` fallback. Callers must handle
    // undefined explicitly (typically by no-op'ing the lookup).
    const r = makeResolver([]);
    expect(r.resolveActiveShipKey('unknown')).toBeUndefined();
  });
});
