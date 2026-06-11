import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_KINDS,
  STRUCTURE_KINDS_LIST,
  STRUCTURE_KIND_CATALOGUE_VERSION,
  DEFAULT_STRUCTURE_KIND,
  StructureKindSchema,
  getStructureKind,
  isStructureKindId,
  structureKindFromIndex,
  structureKindToIndex,
} from '../../src/shared-types/structureKinds.js';

describe('structureKinds catalogue', () => {
  it('ships the planned kinds with stable, append-only ids', () => {
    expect(STRUCTURE_KINDS_LIST.map((k) => k.id)).toEqual([
      'capital',
      'connector',
      'solar',
      'miner',
      'turret',
      'battery',
      'shield_pylon',
    ]);
  });

  it('the Capital is the pre-built anchor at index 0 (== default)', () => {
    expect(STRUCTURE_KINDS_LIST[0]!.id).toBe(DEFAULT_STRUCTURE_KIND);
    expect(STRUCTURE_KINDS.capital.constructionCost).toBe(0);
  });

  it('every record passes its own zod schema', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      expect(() => StructureKindSchema.parse(kind)).not.toThrow();
    }
  });

  it('the keyed lookup agrees with the list by construction', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      expect(STRUCTURE_KINDS[kind.id]).toBe(kind);
    }
    expect(Object.keys(STRUCTURE_KINDS).sort()).toEqual(
      STRUCTURE_KINDS_LIST.map((k) => k.id).sort(),
    );
  });

  it('hubs are the Capital + Connector + Shield Pylon; leaves cap at 1 connection', () => {
    const hubs = STRUCTURE_KINDS_LIST.filter((k) => k.isHub).map((k) => k.id);
    expect(hubs.sort()).toEqual(['capital', 'connector', 'shield_pylon']);
    expect(STRUCTURE_KINDS.capital.maxConnections).toBe(4);
    expect(STRUCTURE_KINDS.connector.maxConnections).toBe(6);
    // The pylon is a hub so two pylons can link directly (it pairs into a wall).
    expect(STRUCTURE_KINDS.shield_pylon.maxConnections).toBe(3);
    for (const leaf of ['solar', 'miner', 'turret', 'battery'] as const) {
      expect(STRUCTURE_KINDS[leaf].maxConnections).toBe(1);
      expect(STRUCTURE_KINDS[leaf].isHub).toBe(false);
    }
  });

  it('the battery carries a stored-power capacity; nothing else does', () => {
    expect(STRUCTURE_KINDS.battery.powerStorageCapacity).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.battery.powerOutput).toBe(0);
    expect(STRUCTURE_KINDS.battery.powerConsumption).toBe(0);
    for (const other of ['capital', 'connector', 'solar', 'miner', 'turret'] as const) {
      expect(STRUCTURE_KINDS[other].powerStorageCapacity).toBeUndefined();
    }
  });

  it('only the Solar and Capital generate power; only leaves consume it', () => {
    expect(STRUCTURE_KINDS.capital.powerOutput).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.solar.powerOutput).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.connector.powerOutput).toBe(0);
    expect(STRUCTURE_KINDS.miner.powerConsumption).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.turret.powerConsumption).toBeGreaterThan(0);
  });

  it('the miner carries mining stats + a mount; the turret carries weapon stats + a mount', () => {
    expect(STRUCTURE_KINDS.miner.miningRate).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.miner.miningRange).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.miner.mounts?.length).toBe(1);
    expect(STRUCTURE_KINDS.turret.weaponRange).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.turret.fireRateMs).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.turret.mounts?.length).toBe(1);
  });

  it('the wire subtype index round-trips, and is append-only stable', () => {
    for (let i = 0; i < STRUCTURE_KINDS_LIST.length; i++) {
      const id = STRUCTURE_KINDS_LIST[i]!.id;
      expect(structureKindToIndex(id)).toBe(i);
      expect(structureKindFromIndex(i)).toBe(id);
    }
    // Out-of-range / unknown fall back to the Capital (forgiving decode).
    expect(structureKindFromIndex(999)).toBe('capital');
    expect(getStructureKind('nope').id).toBe('capital');
    expect(getStructureKind(null).id).toBe('capital');
  });

  it('isStructureKindId narrows known ids only', () => {
    expect(isStructureKindId('turret')).toBe(true);
    expect(isStructureKindId('capital')).toBe(true);
    expect(isStructureKindId('fighter')).toBe(false);
    expect(isStructureKindId('')).toBe(false);
  });

  it('exposes a catalogue version (bump on any edit — invariant #11)', () => {
    expect(STRUCTURE_KIND_CATALOGUE_VERSION).toBeGreaterThanOrEqual(1);
  });
});
