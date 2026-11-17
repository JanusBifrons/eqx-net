import { describe, expect, it } from 'vitest';
import { LockSalvageLookup, lockSalvageFlags, type LockSalvageView } from './lockSalvage.js';
import { LOCK_CONSUMABLE, LOCK_SALVAGE, lockTierBits, lockTierOf } from '../../core/combat/turretLockPick.js';
import { mountTier } from '../../core/combat/salvageTargeting.js';
import { SWARM_KIND_SCRAP, SWARM_KIND_WRECK } from '../../shared-types/swarmWireFormat.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

// Ore pods are the last step of the size ladder (owner 2026-11-16): every
// tractor pulls one (the bottom rung, AA), no laser cuts one, and a rock
// piece is never taken in whole.
describe('lock salvage bits: ore pods and rock pieces', () => {
  const barge = { kind: getShipKind('barge'), activated: [] };
  const swarm: Record<number, { kind: number; id: string; shipKind?: string | null }> = {
    1: { kind: SWARM_KIND_SCRAP, id: 'pod-a', shipKind: 'cargo-pod' },
    2: { kind: SWARM_KIND_SCRAP, id: 'scrap-b', shipKind: 'fighter' },
    3: { kind: SWARM_KIND_WRECK, id: 'wreck-rock' },
    4: { kind: SWARM_KIND_WRECK, id: 'wreck-hull' },
  };
  const lookup = new LockSalvageLookup<object>({
    swarm: (n) => swarm[n],
    piece: (id, out) => {
      out.mass = 1; out.radius = 5; out.qty = 3; out.holdWeight = 3;
      out.ore = id === 'wreck-rock' ? { rockId: 'r', resource: 'rock', perArea: 1 } : undefined;
      return true;
    },
    freeHold: () => 1000,
  });
  const flags = (key: string): number => lockSalvageFlags({ salvageOf: (_p, k, out: LockSalvageView) => lookup.fill({}, k, out) }, barge, 'p1', key);

  it('an ore pod is salvage on the bottom rung (AA), never consumable: every tractor pulls it, no laser cuts it', () => {
    const f = flags('s:1');
    expect(f & LOCK_SALVAGE).toBe(LOCK_SALVAGE);
    expect(lockTierOf(f)).toBe(mountTier('AA'));
    expect(f & LOCK_CONSUMABLE).toBe(0);
  });

  it('plain scrap is not salvage (unchanged)', () => {
    expect(flags('s:2')).toBe(0);
  });

  it('a rock piece at hold size is not consumable; a wreck piece is', () => {
    expect(flags('s:3')).toBe(LOCK_SALVAGE | lockTierBits(mountTier('AA')));
    expect(flags('s:4') & LOCK_CONSUMABLE).toBe(LOCK_CONSUMABLE);
  });
});
