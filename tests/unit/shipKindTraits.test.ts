/**
 * Ship-kind traits for owned utility hulls (salvage plan PR 13):
 * `cargoCapacity`, `collectsLoot`, `randomSpawn: false`. Every trait is
 * optional and existing kinds behave byte-identically.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cargoCapacityForMaxHealth } from '../../src/shared-types/goods.js';
import {
  GAMEPLAY_SHIP_KINDS_LIST,
  PLAYABLE_SHIP_KINDS_LIST,
  SHIP_KINDS_LIST,
  getShipKind,
  inRandomSpawnPool,
} from '../../src/shared-types/shipKinds.js';
import { ShipKindSchema } from '../../src/shared-types/shipKinds/types.js';
import { HARVESTER_CAPACITY } from '../../src/server/livingworld/RobotTerritory.js';

const ROOT = resolve(__dirname, '../..');

describe('cargoCapacity kind override (cargoCapacityForMaxHealth)', () => {
  it('a kind override wins over the toughness-derived capacity', () => {
    expect(cargoCapacityForMaxHealth({ maxHealth: 1000, cargoCapacity: 12345 })).toBe(12345);
  });

  it('without an override the old derivation holds: max(50, round(maxHealth x 2))', () => {
    expect(cargoCapacityForMaxHealth({ maxHealth: 10 })).toBe(50);
    expect(cargoCapacityForMaxHealth({ maxHealth: 300.4 })).toBe(601);
    for (const k of SHIP_KINDS_LIST) {
      if (k.cargoCapacity !== undefined) continue;
      expect(cargoCapacityForMaxHealth(k)).toBe(Math.max(50, Math.round(k.maxHealth * 2)));
    }
  });

  it('only the robot harvester sets an override, and it equals the harvester capacity (byte-identical)', () => {
    const overridden = SHIP_KINDS_LIST.filter((k) => k.cargoCapacity !== undefined).map((k) => k.id);
    expect(overridden).toEqual(['robot-harvester']);
    expect(cargoCapacityForMaxHealth(getShipKind('robot-harvester'))).toBe(400);
    expect(HARVESTER_CAPACITY).toBe(400);
  });

  // Invariant #15: the server clamp (SectorRoom.shipCargoCapacity, the NPC
  // loot collectors) and the client HUD (ColyseusClient cargo slice) must
  // agree. The function takes the KIND RECORD (src typecheck rejects a bare
  // maxHealth); this scan fails if either side stops calling it, or calls it
  // on something other than a kind record.
  it('server and client both derive capacity from the same kind-record call', () => {
    for (const [file, min] of [['src/server/rooms/SectorRoom.ts', 2], ['src/client/net/ColyseusClient.ts', 1]] as const) {
      const lines = readFileSync(resolve(ROOT, file), 'utf8')
        .split('\n')
        .filter((l) => l.includes('cargoCapacityForMaxHealth(') && !l.trimStart().startsWith('import'));
      expect(lines.length, file).toBeGreaterThanOrEqual(min);
      for (const line of lines) {
        expect(line, file).not.toContain('.maxHealth');
        expect(line, file).toMatch(/cargoCapacityForMaxHealth\((getShipKind\(|kindDef\))/);
      }
    }
  });
});

describe('collectsLoot kind trait', () => {
  it('exactly the robot harvester collects loot today', () => {
    expect(SHIP_KINDS_LIST.filter((k) => k.collectsLoot === true).map((k) => k.id)).toEqual(['robot-harvester']);
  });
});

describe('randomSpawn: false opt-out', () => {
  const base = getShipKind('fighter');

  it('opts a pilotable kind out of the random spawn pool', () => {
    expect(inRandomSpawnPool(base)).toBe(true);
    expect(inRandomSpawnPool({ ...base, randomSpawn: false })).toBe(false);
    // ...without making it NPC-only.
    expect({ ...base, randomSpawn: false }.npcOnly).toBeUndefined();
  });

  it('the schema accepts only `false` (absent = eligible)', () => {
    const { appliedScale: _a, ...raw } = base;
    expect(ShipKindSchema.safeParse({ ...raw, randomSpawn: false }).success).toBe(true);
    expect(ShipKindSchema.safeParse({ ...raw, randomSpawn: true }).success).toBe(false);
  });

  it('no existing kind opts out — the gameplay pool is unchanged', () => {
    expect(SHIP_KINDS_LIST.some((k) => k.randomSpawn === false)).toBe(false);
    expect(GAMEPLAY_SHIP_KINDS_LIST.map((k) => k.id)).toEqual(
      SHIP_KINDS_LIST.filter((k) => !k.engineeringOnly && !k.npcOnly).map((k) => k.id),
    );
    for (const k of GAMEPLAY_SHIP_KINDS_LIST) expect(PLAYABLE_SHIP_KINDS_LIST).toContain(k);
  });
});
