/**
 * The mining barge as a real ship kind (plan partitioned-chasing-lark PR 15;
 * owner 2026-11-15: "just use A"). Locks:
 *  - it is the last catalogue kind, pilotable, never in a random spawn pool
 *    (`GAMEPLAY_SHIP_KINDS_LIST` → `HunterBotPool` / `SwarmSpawner`);
 *  - it has no allegiance (its side comes from its owner), the civilian AI
 *    role, and a large hold honoured by `cargoCapacityForMaxHealth`;
 *  - its mounts parse, carry only the mining laser and the tractor, span the
 *    sizes AA to XL down both sides, and each sits on one of look A's drawn
 *    dishes (a `housing` plate centred on the mount).
 */
import { describe, expect, it } from 'vitest';
import { cargoCapacityForMaxHealth } from '../../src/shared-types/goods.js';
import {
  GAMEPLAY_SHIP_KINDS_LIST, PLAYABLE_SHIP_KINDS_LIST, SHIP_KINDS, SHIP_KINDS_LIST, getShipKind, inRandomSpawnPool,
  isPlayableShipKindId, shipKindToIndex,
} from '../../src/shared-types/shipKinds.js';
import { ShipKindSchema } from '../../src/shared-types/shipKinds/types.js';
import { BARGE_KIND_ID, BARGE_PICK, bargeDesign } from '../../src/shared-types/shipKinds/capitals/bargeDesign.js';
import { CAPITAL_MAP } from '../../src/shared-types/shipKinds/capitals/capitalConfig.js';
import { pickRandomShipKind } from '../../src/server/spawn/SwarmSpawner.js';

const barge = getShipKind(BARGE_KIND_ID);

describe('the mining barge kind', () => {
  it('is look A, appended after the last kind', () => {
    expect(BARGE_PICK).toBe('A');
    const ids = SHIP_KINDS_LIST.map((k) => k.id);
    expect(ids.indexOf('barge')).toBe(ids.indexOf('battlecruiser-lance') + 1);
    expect(shipKindToIndex(BARGE_KIND_ID)).toBe(ids.indexOf('barge'));
    expect(SHIP_KINDS_LIST.filter((k) => k.id !== 'barge-look').map((k) => k.id)).toEqual(Object.keys(SHIP_KINDS).filter((k) => k !== 'barge-look'));
  });

  it('is pilotable but never in a random spawn pool', () => {
    expect(barge.npcOnly).toBe(false);
    expect(isPlayableShipKindId(BARGE_KIND_ID)).toBe(true);
    expect(PLAYABLE_SHIP_KINDS_LIST).toContain(barge);
    expect(barge.randomSpawn).toBe(false);
    expect(inRandomSpawnPool(barge)).toBe(false);
    expect(GAMEPLAY_SHIP_KINDS_LIST.some((k) => k.id === BARGE_KIND_ID)).toBe(false);
    // The ambient drone picker draws from that pool.
    for (let i = 0; i < 2000; i++) expect(pickRandomShipKind()).not.toBe(BARGE_KIND_ID);
  });

  it('has no side of its own and flies as a civilian', () => {
    expect('allegiance' in barge).toBe(false);
    expect(barge.aiRole).toBe('civilian');
    expect(barge.sizeClass).toBe('capital');
  });

  it('has a large hold, honoured by cargoCapacityForMaxHealth', () => {
    expect(barge.cargoCapacity).toBeDefined();
    expect(cargoCapacityForMaxHealth(barge)).toBe(barge.cargoCapacity);
    // Several times any other kind's hold, the battleship's and the trade hauler's included.
    for (const k of SHIP_KINDS_LIST) {
      if (k.id === BARGE_KIND_ID || k.id === 'barge-look') continue;
      expect(cargoCapacityForMaxHealth(barge), k.id).toBeGreaterThan(4 * cargoCapacityForMaxHealth(k));
    }
  });

  it('mounts parse, and carry only mining lasers and tractors, AA to XL, down both sides', () => {
    const { appliedScale: _a, ...raw } = barge;
    expect(ShipKindSchema.safeParse(raw).success).toBe(true);
    const m = barge.mounts ?? [];
    for (const x of m) {
      expect(x.weaponId).toBe(x.id.startsWith('tractor-') ? 'tractor' : 'mining_laser');
      expect(x.id.startsWith('tractor-') || x.id.startsWith('laser-')).toBe(true);
    }
    const sizes = (w: string): Set<string | undefined> => new Set(m.filter((x) => x.weaponId === w).map((x) => x.size));
    expect([...sizes('mining_laser')].sort()).toEqual(['AA', 'L', 'M', 'XL']);
    expect([...sizes('tractor')].sort()).toEqual(['AA', 'M', 'S']);
    expect(m.filter((x) => x.localX > 0).length).toBe(m.filter((x) => x.localX < 0).length);
    // Two weapon groups: lasers and tractors.
    expect((barge.slots ?? []).map((s) => s.id)).toEqual(['laser', 'tractor']);
  });

  it("puts every mount on one of look A's drawn dishes", () => {
    const d = bargeDesign(BARGE_PICK, CAPITAL_MAP, BARGE_KIND_ID);
    const parts = (d.record['shape'] as { parts: Array<{ points: Array<[number, number]>; role: string }> }).parts;
    const plates = parts.filter((p) => p.role === 'housing' && p.points.length === 16).map((p) => {
      const cx = p.points.reduce((a, [x]) => a + x, 0) / p.points.length;
      const cy = p.points.reduce((a, [, y]) => a + y, 0) / p.points.length;
      return [cx, cy] as const;
    });
    const mounts = d.record['mounts'] as Array<{ localX: number; localY: number }>;
    expect(plates.length).toBe(mounts.length);
    for (const mt of mounts) {
      expect(plates.some(([x, y]) => Math.abs(x - mt.localX) < 1e-6 && Math.abs(y + mt.localY) < 1e-6)).toBe(true);
    }
  });
});
