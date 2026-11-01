import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_KINDS,
  STRUCTURE_KINDS_LIST,
  STRUCTURE_KIND_CATALOGUE_VERSION,
  DEFAULT_STRUCTURE_KIND,
  StructureKindSchema,
  structureHalfExtents,
  normaliseStructureRotation,
  structureHullPoints,
  getStructureKind,
  isStructureKindId,
  structureKindFromIndex,
  structureKindToIndex,
} from '../../src/shared-types/structureKinds.js';
import { getWeapon } from '../../src/core/combat/WeaponCatalogue.js';

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
      'laser_bolt_turret', // WS-8 (R2.15) — appended at the tail
      'missile_turret',
      'cargo_bay', // Living World P1a-2 — appended at the tail
      'shield_gate', // gates — appended at the tail
      'shield_airlock',
      // Production chains (plan soft-leaping-truffle v3, P2a) — appended at the tail
      'gas_collector',
      'reclaimer',
      'smelter',
      'refinery',
      'silicon_works',
      'hydroponics',
      'fabricator',
      'munitions_works',
      'freight_dock',
      'deep_core_rig',
      'ore_processing_complex',
      'assembly_plant',
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

  it('hubs are the Capital + Connector + the shield emitters; leaves cap at 1 connection', () => {
    const hubs = STRUCTURE_KINDS_LIST.filter((k) => k.isHub).map((k) => k.id);
    // P2a — the huge production kinds are hubs (4 links) that anchor a district.
    expect(hubs.sort()).toEqual([
      'assembly_plant', 'capital', 'connector', 'deep_core_rig', 'ore_processing_complex',
      'shield_airlock', 'shield_gate', 'shield_pylon',
    ]);
    for (const huge of ['deep_core_rig', 'ore_processing_complex', 'assembly_plant'] as const) {
      expect(STRUCTURE_KINDS[huge].maxConnections).toBe(4);
    }
    expect(STRUCTURE_KINDS.capital.maxConnections).toBe(4);
    expect(STRUCTURE_KINDS.connector.maxConnections).toBe(6);
    // The pylon is a hub so two pylons can link directly (it pairs into a wall).
    expect(STRUCTURE_KINDS.shield_pylon.maxConnections).toBe(3);
    for (const leaf of ['solar', 'miner', 'turret', 'battery', 'laser_bolt_turret', 'missile_turret'] as const) {
      expect(STRUCTURE_KINDS[leaf].maxConnections).toBe(1);
      expect(STRUCTURE_KINDS[leaf].isHub).toBe(false);
    }
  });

  it('the battery carries a stored-power capacity; nothing else does', () => {
    expect(STRUCTURE_KINDS.battery.powerStorageCapacity).toBeGreaterThan(0);
    expect(STRUCTURE_KINDS.battery.powerOutput).toBe(0);
    expect(STRUCTURE_KINDS.battery.powerConsumption).toBe(0);
    for (const other of ['capital', 'connector', 'solar', 'miner', 'turret', 'laser_bolt_turret', 'missile_turret'] as const) {
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

  it('phase V: every kind has a large footprint and radius is its bounding circle', () => {
    // Plan soft-leaping-truffle v2 (user: "far larger and more like the other
    // ones"). Connectors + pylons stay the smallest nodes; everything else is
    // several times a ship's size. Version-pinned (8→9 rides these edits).
    expect(STRUCTURE_KIND_CATALOGUE_VERSION).toBeGreaterThanOrEqual(9);
    expect(STRUCTURE_KINDS.connector.footprint).toEqual({ w: 64, h: 64 });
    expect(STRUCTURE_KINDS.shield_pylon.footprint).toEqual({ w: 72, h: 72 });
    expect(STRUCTURE_KINDS.capital.footprint).toEqual({ w: 560, h: 560 });
    for (const k of STRUCTURE_KINDS_LIST) {
      expect(k.radius, k.id).toBe(Math.ceil(Math.hypot(k.footprint.w, k.footprint.h) / 2));
    }
  });

  it('WS-8 (R2.15) added the two defence turrets, each binding the right weapon', () => {
    // The bolt turret fires a PROJECTILE (the existing 'laser' Bolt); the missile
    // turret fires a MISSILE (the existing 'heat-seeker'). A typo binding
    // 'hitscan' (the beam turret's weapon) would make them instant-damage — lock
    // the mode so the SHOT model is wired to a travelling weapon.
    const bolt = STRUCTURE_KINDS.laser_bolt_turret;
    const missile = STRUCTURE_KINDS.missile_turret;
    expect(bolt.mounts?.length).toBe(1);
    expect(missile.mounts?.length).toBe(1);
    expect(getWeapon(bolt.mounts![0]!.weaponId!).mode).toBe('projectile');
    expect(getWeapon(missile.mounts![0]!.weaponId!).mode).toBe('missile');
    // Both carry a targeting range + a per-kind shot cadence (fireRateMs).
    expect(bolt.weaponRange).toBeGreaterThan(0);
    expect(missile.weaponRange).toBeGreaterThan(0);
    expect(bolt.fireRateMs).toBeGreaterThan(0);
    expect(missile.fireRateMs).toBeGreaterThan(0);
    expect(STRUCTURE_KIND_CATALOGUE_VERSION).toBeGreaterThanOrEqual(6); // the 5→6 bump
  });

  // ── Unified-hull plan — the single hull-points source (render + collider) ──
  it('structureHullPoints is the footprint rectangle (collider == drawn box)', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      const pts = structureHullPoints(k.id);
      expect(pts.length, k.id).toBe(4);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect(Math.max(...xs) - Math.min(...xs), k.id).toBe(k.footprint.w);
      expect(Math.max(...ys) - Math.min(...ys), k.id).toBe(k.footprint.h);
    }
    // Unknown id, no radius ⇒ the Capital's box (forgiving, like getStructureKind).
    expect(structureHullPoints('not-a-kind')).toEqual(structureHullPoints(DEFAULT_STRUCTURE_KIND));
    // A kindless fixture WITH a radius ⇒ a radius-sized square, never the Capital box.
    const sq = structureHullPoints(undefined, 60);
    expect(Math.max(...sq.map((p) => p.x)) - Math.min(...sq.map((p) => p.x))).toBe(120);
  });

  it('structureHalfExtents swaps width and height on a quarter turn', () => {
    expect(structureHalfExtents('solar', 0)).toEqual({ hw: 180, hh: 75 });
    expect(structureHalfExtents('solar', 90)).toEqual({ hw: 75, hh: 180 });
    expect(structureHalfExtents('solar', 180)).toEqual({ hw: 180, hh: 75 });
    expect(structureHalfExtents('solar', 270)).toEqual({ hw: 75, hh: 180 });
    expect(normaliseStructureRotation(-90)).toBe(270);
    expect(normaliseStructureRotation(44)).toBe(0);
    expect(normaliseStructureRotation(46)).toBe(90);
  });
});
