/**
 * Starter grant — one packed Capital crate per account, on launch, with the
 * flag and the hold in ONE atomic group.
 */
import { describe, expect, it } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { holdWeight, packedWeightOf, DEFAULT_PACKED_STRUCTURE_WEIGHT } from '../../core/cargo/hold.js';
import { cargoCapacityForMaxHealth } from '../../shared-types/goods.js';
import { PackedItemSchema } from '../../shared-types/items.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { LAUNCHABLE_HULL_KINDS } from '../../shared-types/launch.js';
import { blueprintProducts, packedStructureProducts, productName, rollPackedStructure } from '../../shared-types/blueprints.js';
import { HoldStore } from '../cargo/HoldStore.js';
import { EconomyStore } from './EconomyStore.js';
import { grantStarter, STARTER_CAPITAL_PRODUCT } from './starterGrant.js';

const P = '6a7e0000-0000-4000-8000-0000000000c3';

function setup() {
  const ops: PersistOp[] = [];
  const sink = { enqueueCritical: (op: PersistOp) => ops.push(op) } as unknown as IPersistenceSink;
  const econ = new EconomyStore({ persistence: () => sink, now: () => 1000 });
  const holds = new HoldStore({ persistence: () => sink, now: () => 1000 });
  return { ops, econ, holds };
}

const capitalCount = (holds: HoldStore, uid: string): number =>
  (holds.get(uid)?.hold.packed ?? []).filter((p) => p.product === STARTER_CAPITAL_PRODUCT).length;

describe('starter grant', () => {
  it('starter Capital crate: first launch adds one, second adds none', () => {
    const { ops, econ, holds } = setup();
    expect(grantStarter({ econ, holds }, P, 'ship-a', 'fighter')).toBe(true);
    expect(capitalCount(holds, 'ship-a')).toBe(1);
    // One atomic group: the hold upsert and the player-row flag together.
    expect(ops).toHaveLength(1);
    const group = ops[0] as Extract<PersistOp, { type: 'GROUP' }>;
    expect(group.type).toBe('GROUP');
    expect(group.ops.map((o) => o.type).sort()).toEqual(['ECON_PLAYER_PUT', 'HOLD_PUT']);

    // A second launch (same or another ship) adds nothing.
    expect(grantStarter({ econ, holds }, P, 'ship-a', 'fighter')).toBe(false);
    expect(grantStarter({ econ, holds }, P, 'ship-b', 'destroyer')).toBe(false);
    expect(capitalCount(holds, 'ship-a')).toBe(1);
    expect(holds.get('ship-b')).toBeUndefined();
    expect(ops).toHaveLength(1);
  });

  it('keeps what is already in the hold and never goes over capacity', () => {
    const { econ, holds } = setup();
    holds.put({ holderUid: 'ship-c', holderType: 'ship', ownerId: P, sectorKey: null, x: null, y: null, hold: { goods: { alloy: 3 }, blueprints: [] }, expiresAt: null });
    expect(grantStarter({ econ, holds }, P, 'ship-c', 'fighter')).toBe(true);
    expect(holds.get('ship-c')!.hold.goods.alloy).toBe(3);
    expect(capitalCount(holds, 'ship-c')).toBe(1);

    // A full hold: no crate, and the flag stays unset so the next launch tries again.
    const s2 = setup();
    const cap = cargoCapacityForMaxHealth(getShipKind('fighter'));
    s2.holds.put({ holderUid: 'ship-d', holderType: 'ship', ownerId: P, sectorKey: null, x: null, y: null, hold: { goods: { salvage: cap }, blueprints: [] }, expiresAt: null });
    expect(holdWeight(s2.holds.get('ship-d')!.hold)).toBeGreaterThan(cap - packedWeightOf(STARTER_CAPITAL_PRODUCT));
    expect(grantStarter({ econ: s2.econ, holds: s2.holds }, P, 'ship-d', 'fighter')).toBe(false);
    expect(s2.econ.starterGranted(P)).toBe(false);
  });

  it('the crate weighs 25 and fits every launchable hull', () => {
    expect(packedWeightOf(STARTER_CAPITAL_PRODUCT)).toBe(DEFAULT_PACKED_STRUCTURE_WEIGHT);
    expect(DEFAULT_PACKED_STRUCTURE_WEIGHT).toBe(25);
    for (const k of LAUNCHABLE_HULL_KINDS) {
      expect(cargoCapacityForMaxHealth(getShipKind(k as Parameters<typeof getShipKind>[0]))).toBeGreaterThanOrEqual(25);
    }
  });

  it('the starter crate flag survives a store round trip', () => {
    const { econ, holds } = setup();
    expect(econ.starterGranted(P)).toBe(false);
    grantStarter({ econ, holds }, P, 'ship-a', 'fighter');
    expect(econ.starterGranted(P)).toBe(true);
    const op = econ.playerOp(P) as Extract<PersistOp, { type: 'ECON_PLAYER_PUT' }>;
    const again = setup();
    again.econ.hydrate({ players: [{ player_id: P, payload_json: op.payloadJson }], deals: [], market: null });
    expect(again.econ.starterGranted(P)).toBe(true);
    expect(grantStarter({ econ: again.econ, holds: again.holds }, P, 'ship-z', 'fighter')).toBe(false);
    // An existing row saved before the flag existed reads as "not yet given".
    const old = setup();
    old.econ.hydrate({ players: [{ player_id: P, payload_json: JSON.stringify({ freeLaunches: 2 }) }], deals: [], market: null });
    expect(old.econ.starterGranted(P)).toBe(false);
  });

  it('structure:capital is a packed product and never rolls as loot', () => {
    expect(PackedItemSchema.safeParse({ product: STARTER_CAPITAL_PRODUCT, quality: 50 }).success).toBe(true);
    expect(productName(STARTER_CAPITAL_PRODUCT)).toBe(getStructureKind('capital').displayName);
    expect(packedStructureProducts()).not.toContain(STARTER_CAPITAL_PRODUCT);
    expect(blueprintProducts()).not.toContain(STARTER_CAPITAL_PRODUCT);
    let seed = 1;
    const rng = (): number => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let i = 0; i < 2000; i++) expect(rollPackedStructure(rng, 1)?.product).not.toBe(STARTER_CAPITAL_PRODUCT);
  });
});

