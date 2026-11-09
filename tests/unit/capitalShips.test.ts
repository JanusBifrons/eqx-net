/**
 * Capital class (R&D, plan eager-sauteeing-curry). Every style × size mapping
 * builds a valid catalogue record whose deck plan follows the research
 * (docs/research/ww2-surface-combatants.md). The catalogue's capitals,
 * driven by the REAL physics world, accelerate and turn on their WW2-grounded
 * targets: thrust + linear damping for speed; torque against inertia +
 * angular damping for turning (no scripted ramp).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ShipKindSchema } from '../../src/shared-types/shipKinds/types.js';
import { warshipDesign } from '../../src/shared-types/shipKinds/capitals/warshipDesign.js';
import { CAPITAL_MAP } from '../../src/shared-types/shipKinds/capitals/capitalConfig.js';
import {
  CAPITAL_CLASS_IDS, CAPITAL_MAPPINGS, capitalTargets, type CapitalClassId,
} from '../../src/shared-types/shipScale/capitalReference.js';
import { getShipKind, isPlayableShipKindId, SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { PhysicsWorld } from '../../src/core/physics/World.js';

type Pt = [number, number];
const inside = (poly: Pt[], x: number, y: number): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

describe.each(['A', 'B', 'C'] as const)('style %s', (style) => {
  for (const map of ['A', 'B', 'C'] as const) {
    for (const id of CAPITAL_CLASS_IDS) {
      it(`${id} (mapping ${map}) is a valid record with a WW2 deck plan`, () => {
        const d = warshipDesign(id, style, map);
        const k = ShipKindSchema.parse(d.record);
        expect(k.npcOnly).toBe(true);
        expect(k.sizeClass).toBe('capital');
        expect(k.shape.kind).toBe('composite');
        // Long and thin: 8–10.5 : 1 (styles widen or narrow the beam a little).
        expect(d.length / d.beam).toBeGreaterThan(7.5);
        expect(d.length / d.beam).toBeLessThan(10.5);
        const hull = (k.shape as { hull: Pt[] }).hull;
        for (const m of k.mounts ?? []) {
          // Mounts sit on the hull (mount localY is forward-positive; hull is Pixi-up).
          expect(inside(hull, m.localX, -m.localY), `${id} ${m.id} on the hull`).toBe(true);
          if (m.id.startsWith('main')) expect(m.localX).toBe(0); // main battery on the centreline
        }
        // Forward turrets face forward, aft turrets face aft.
        const mains = (k.mounts ?? []).filter((m) => m.id.startsWith('main'));
        expect(mains.some((m) => m.localY > 0 && m.baseAngle === 0)).toBe(true);
        expect(mains.some((m) => m.localY < 0 && m.baseAngle === Math.PI)).toBe(true);
        expect(mains.every((m) => m.size === d.mainMountSize)).toBe(true);
      });
    }
  }
});

describe('the catalogue capitals', () => {
  it('are appended after every existing kind, NPC-only, not pilotable', () => {
    const ids = SHIP_KINDS_LIST.map((k) => k.id);
    // The five classes, then (W2b) each class's style B and C hulls.
    const variants = CAPITAL_CLASS_IDS.flatMap((id) => [`${id}-b`, `${id}-c`]);
    expect(ids.slice(-15)).toEqual([...CAPITAL_CLASS_IDS, ...variants]);
    for (const id of [...CAPITAL_CLASS_IDS, ...variants]) expect(isPlayableShipKindId(id)).toBe(false);
  });

  it('W2b: a style variant is its class in another hull style (same class, size within a few percent)', () => {
    for (const id of CAPITAL_CLASS_IDS) {
      const base = getShipKind(id);
      for (const v of [getShipKind(`${id}-b`), getShipKind(`${id}-c`)]) {
        expect(v.id).not.toBe('fighter'); // a real kind, not the unknown-id fallback
        expect(v.displayName).toBe(base.displayName);
        expect(v.sizeClass).toBe('capital');
        expect(Math.abs(v.radius - base.radius) / base.radius).toBeLessThan(0.05);
        expect(v.mounts.length).toBeGreaterThan(0);
      }
      expect(getShipKind(`${id}-b`).description).toContain('style B');
      // A different hull, not a renamed copy: the collider outline differs.
      const hull = (k: string): string => JSON.stringify((getShipKind(k).shape as { hull: unknown }).hull);
      expect(hull(`${id}-b`)).not.toBe(hull(`${id}-c`));
    }
  });

  it('keep their authored game-unit size (the global ship scale does not apply)', () => {
    for (const id of CAPITAL_CLASS_IDS) {
      expect(getShipKind(id).radius).toBeCloseTo(capitalTargets(id, CAPITAL_MAPPINGS[CAPITAL_MAP]).length / 2, 6);
      expect(getShipKind(id).appliedScale).toBe(1);
    }
  });
});

describe('capitals in the real physics world', () => {
  let world: PhysicsWorld;
  beforeAll(async () => { world = await PhysicsWorld.create(); });
  const ahead = { thrust: true, reverse: false, turnLeft: false, turnRight: false, boost: false };
  const turn = { thrust: false, reverse: false, turnLeft: true, turnRight: false, boost: false };

  const measure = (id: CapitalClassId, input: typeof ahead, read: (s: { vx: number; vy: number; angvel?: number }) => number, target: number): number => {
    const sid = `${id}-${read.name}-${Math.random()}`;
    world.spawnShip(sid, 0, 0, id);
    let ticks = 0;
    while (ticks < 60 * 120) {
      world.applyInput(sid, input);
      world.tick(1 / 60);
      ticks++;
      if (read(world.getShipState(sid)!) >= 0.9 * target) break;
    }
    world.despawnShip(sid);
    return ticks / 60;
  };
  const speed = (s: { vx: number; vy: number }): number => Math.hypot(s.vx, s.vy);
  const rate = (s: { angvel?: number }): number => Math.abs(s.angvel ?? 0);

  for (const id of CAPITAL_CLASS_IDS) {
    it(`${id} reaches 90% of top speed and of its turn rate on its targets`, () => {
      const t = capitalTargets(id, CAPITAL_MAPPINGS[CAPITAL_MAP]);
      const k = getShipKind(id);
      expect(measure(id, ahead, speed, t.topSpeed)).toBeCloseTo(t.accelSeconds, 0);
      expect(measure(id, turn, rate, k.maxAngvel / 1.02)).toBeCloseTo(t.turnResponseSeconds, 0);
    });
  }

  it('a battleship is several times slower than a destroyer to get going and to start turning', () => {
    const m = CAPITAL_MAPPINGS[CAPITAL_MAP];
    const dd = capitalTargets('destroyer', m), bb = capitalTargets('battleship', m);
    const ddA = measure('destroyer', ahead, speed, dd.topSpeed), bbA = measure('battleship', ahead, speed, bb.topSpeed);
    const ddT = measure('destroyer', turn, rate, getShipKind('destroyer').maxAngvel / 1.02);
    const bbT = measure('battleship', turn, rate, getShipKind('battleship').maxAngvel / 1.02);
    expect(bbA / ddA).toBeGreaterThan(4);
    expect(bbT / ddT).toBeGreaterThan(3);
  });
});

describe('capital turrets are sized by calibre (shared muzzle geometry, #15)', () => {
  it('a battleship main gun (XL) is longer and wider than its secondaries (S), and both sit within the beam', async () => {
    const { shipBarrelLength, shipBarrelWidth, shipShotMuzzle, navalTurret } = await import('../../src/core/combat/muzzle.js');
    const k = getShipKind('battleship');
    const main = k.mounts!.find((m) => m.id === 'main-1')!, sec = k.mounts!.find((m) => m.id.startsWith('sec'))!;
    expect(shipBarrelLength(k, main)).toBeGreaterThan(shipBarrelLength(k, sec) * 2);
    expect(shipBarrelWidth(k, main)).toBeGreaterThan(shipBarrelWidth(k, sec));
    const hull = (k.shape as { hull: Array<[number, number]> }).hull;
    const beam = 2 * Math.max(...hull.map(([x]) => Math.abs(x)));
    // Iowa: 20.3 m barrels on a 33 m beam (0.62).
    expect(shipBarrelLength(k, main) / beam).toBeCloseTo(0.62, 1);
    // Triple main gunhouse, twin secondaries.
    expect(navalTurret(k, main)!.barrels).toBe(3);
    expect(navalTurret(k, sec)!.barrels).toBe(2);
    // The fire point is the drawn barrel tip: the gunhouse front + the barrel
    // (the same function both sides use).
    const nt = navalTurret(k, main)!;
    expect(shipShotMuzzle(k, main)).toBeCloseTo(nt.houseL / 2 + nt.len, 9);
  });
});
