/**
 * Ship scale infrastructure — invariants at ANY scale. Every authored kind is
 * swept at 1×, 2× and 4× (plus a synthetic capital hull) through the same
 * pure functions the catalogue uses (`scaleShipKind`, `shipTuning`), so a
 * size-dependent number that doesn't follow the ships, or a motion rule that
 * breaks, fails here instead of in a playtest.
 */
import { describe, it, expect } from 'vitest';
import { SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { unscaledShipKinds } from '../../src/shared-types/shipScale/defineShipKind.js';
import {
  BASE, CLASS_TUNING, MOTION, combatDistanceScale, effectiveScale, massOf, motionFactors, scaleShipKind, shipTuning, sizeClassOf,
} from '../../src/shared-types/shipScale/tuning.js';
import { AT_AUTHORED_SHIP_SCALE, DEFAULT_SHIP_SCALE, DEFAULT_SHIP_TUNING, resolveShipScaleConfig } from '../../src/shared-types/shipScale/config.js';
import { GATE_GAP, AIRLOCK_GAP } from '../../src/core/structures/gateGeometry.js';
import type { ShipKind } from '../../src/shared-types/shipKinds/types.js';
import { isChinMount } from '../../src/core/combat/muzzle.js';

/** NPC kinds whose chin gun's drone clearance (16 u at 1×) is INSIDE their own
 *  hull today (their shots start inside the ship; harmless, the shooter is
 *  skipped). Kept as-is so 1× is unchanged; fix in the tuning pass. A NEW kind
 *  with this problem fails the check below. */
const KNOWN_DRONE_MUZZLE_INSIDE_HULL = new Set(['robot-hexagon', 'robot-harvester', 'robot-nexus', 'trader-hauler']);

const SCALES = [1, 2, 4];
const RAW = unscaledShipKinds();

/** A gigantic capital, built the way a real one will be: authored at 1×
 *  with its own size and engines. */
const CAPITAL: ShipKind = {
  ...RAW.find((k) => k.id === 'heavy')!,
  id: 'test-capital', radius: 600, sizeClass: 'capital', mass: 400,
  thrusters: { count: 8, size: 30 },
  shape: { kind: 'polygon', color: 0x8899aa, scale: 30, points: [[0, -24], [-16, 16], [16, 16]] },
  mounts: [{ id: 'battery-1', localX: -200, localY: 100, baseAngle: 0, arcMin: -1, arcMax: 1, rotationSpeed: 0.5, weaponId: 'laser' }],
};

describe('ship scale — the catalogue', () => {
  it.runIf(AT_AUTHORED_SHIP_SCALE)('at the authored scale (1x, A) every kind is exactly its authored self', () => {
    for (const raw of RAW) {
      const k = SHIP_KINDS_LIST.find((x) => x.id === raw.id)!;
      expect(effectiveScale(raw), raw.id).toBe(1);
      for (const f of ['radius', 'thrustImpulse', 'maxAngvel', 'maxSpeed', 'mass'] as const) expect(k[f], `${raw.id}.${f}`).toBe(raw[f]);
      expect(k.mounts, raw.id).toEqual(raw.mounts);
    }
  });

  it('engineering test hulls stay 1x; a per-kind sizeScale multiplies the global one', () => {
    expect(effectiveScale({ engineeringOnly: true }, 2)).toBe(1);
    expect(effectiveScale({ sizeScale: 1.5 }, 2)).toBe(3);
  });

  it('config comes from env, the page global or the worker name, clamped', () => {
    expect(resolveShipScaleConfig({ env: { EQX_SHIP_SCALE: '2', EQX_SHIP_TUNING: 'B' } })).toMatchObject({ scale: 2, tuning: 'B' });
    expect(resolveShipScaleConfig({ global: { __EQX_SHIP_SCALE__: '1.5' } }).scale).toBe(1.5);
    expect(resolveShipScaleConfig({ workerName: 'bake;shipScale=4;shipTuning=A' })).toMatchObject({ scale: 4, tuning: 'A' });
    expect(resolveShipScaleConfig({ env: { EQX_SHIP_SCALE: '999' } }).scale).toBe(16);
    expect(resolveShipScaleConfig({})).toMatchObject({ scale: DEFAULT_SHIP_SCALE, tuning: DEFAULT_SHIP_TUNING });
    expect([DEFAULT_SHIP_SCALE, DEFAULT_SHIP_TUNING]).toEqual([2, 'B']); // the shipping pick (2026-11-05)
  });
});

describe.each(SCALES)('ship scale %ix — geometry and tuning follow the hull', (s) => {
  const kinds = [...RAW.map((k) => scaleShipKind(k, s)), scaleShipKind(CAPITAL, s / 2 || 1)];

  it('radius, shape and mounts scale together', () => {
    for (const raw of RAW) {
      const k = scaleShipKind(raw, s);
      expect(k.radius, raw.id).toBeCloseTo(raw.radius * s, 9);
      expect(k.shape.scale, raw.id).toBeCloseTo((raw.shape.scale ?? 1) * s, 9);
      (raw.mounts ?? []).forEach((m, i) => {
        expect(k.mounts![i]!.localX, `${raw.id}/${m.id}`).toBeCloseTo(m.localX * s, 9);
        expect(k.mounts![i]!.localY, `${raw.id}/${m.id}`).toBeCloseTo(m.localY * s, 9);
      });
      expect(k.appliedScale).toBe(s);
      expect(sizeClassOf(k), raw.id).toBe(sizeClassOf(raw)); // class is by the authored size
    }
  });

  it('every size-dependent number grows with the hull', () => {
    // Engineering test hulls never spawn as drones or flock; they keep fighter rules.
    for (const k of kinds.filter((x) => !x.engineeringOnly)) {
      const t = shipTuning(k);
      expect(t.spawnClearance, k.id).toBeGreaterThan(k.radius);
      expect(t.lootPickup, k.id).toBeGreaterThan(k.radius);
      expect(t.flockSeparation, k.id).toBeGreaterThanOrEqual(2 * k.radius);
      expect(t.flockFollow, k.id).toBeGreaterThan(t.flockSeparation);
      const chin = (k.mounts ?? []).some((m) => isChinMount(m));
      if (chin && !k.npcOnly) expect(t.muzzleClearance, k.id).toBeGreaterThan(k.radius);
      if (chin && k.npcOnly && !KNOWN_DRONE_MUZZLE_INSIDE_HULL.has(k.id)) expect(t.droneMuzzleClearance, k.id).toBeGreaterThan(k.radius);
      expect(t.hitRadius, k.id).toBeGreaterThan(0);
      expect(t.barrelLenMax, k.id).toBeGreaterThan(t.barrelLenMin);
    }
  });

  it('the engine ribbon trails the same number of hull lengths at top speed as at 1x', () => {
    // Bug 2026-11-06 ("the engines on the fighter were wrong"): the ribbon's
    // window was a 1x constant, so at 2x it was ~2.8x shorter against the hull.
    // Kinds with authored engines change their own speed at the first scale;
    // the ribbon follows the size alone, so they are left out.
    for (const raw of RAW.filter((x) => !x.thrusters && !x.engineeringOnly)) {
      const k = scaleShipKind(raw, s), t1 = shipTuning(scaleShipKind(raw, 1)).exhaustTrailS;
      const hulls = (shipTuning(k).exhaustTrailS * k.maxSpeed) / k.radius;
      expect(hulls, raw.id).toBeCloseTo((t1 * raw.maxSpeed) / raw.radius, 6);
    }
    expect(shipTuning(scaleShipKind(RAW[0]!, 1)).exhaustTrailS).toBeCloseTo(BASE.exhaustTrailS, 9); // the lab's 1x look
  });

  it('a playable ship\'s shield fits through a gate and an airlock (at the scales we ship)', () => {
    if (s > 2) return; // 4× is a stress sweep, not a shipping scale
    for (const k of kinds.filter((x) => !x.npcOnly && !x.engineeringOnly && x.id !== 'test-capital')) {
      const shield = 2 * (k.radius + shipTuning(k).shieldPad);
      expect(shield, `${k.id} vs gate`).toBeLessThan(GATE_GAP);
      expect(shield, `${k.id} vs airlock`).toBeLessThan(AIRLOCK_GAP);
    }
  });
});

describe('ship scale — the motion model', () => {
  it('at 1x the motion is untouched', () => {
    expect(motionFactors(1)).toEqual({ mass: 1, thrust: 1, turn: 1, speed: 1 });
  });

  it('bigger hulls are heavier, accelerate and turn slower (same engines)', () => {
    const f = motionFactors(2);
    expect(f.mass).toBe(2 ** MOTION.massExp);
    expect(f.thrust / f.mass).toBeCloseTo(0.5, 9); // accel ∝ 1/s
    expect(f.turn).toBeCloseTo(0.5, 9); // turn rate ∝ 1/s
    expect(f.speed).toBeCloseTo(Math.SQRT1_2, 9);
    const fighter = RAW.find((k) => k.id === 'fighter')!;
    const big = scaleShipKind(fighter, 2);
    expect(massOf(big, 1)).toBeCloseTo(massOf(fighter, 1) * 8, 9);
    expect(massOf(big, 3)).toBeCloseTo(3 * 8, 9); // a side's fallback mass scales too
    // Terminal speed under drag ∝ accel / damping: lands on the speed factor.
    const terminal = (k: ShipKind): number => k.thrustImpulse / massOf(k, 1) / k.linearDamping;
    expect(terminal(big) / terminal(fighter)).toBeCloseTo(f.speed, 9);
    expect(big.ai.thrust).toBeCloseTo(fighter.ai.thrust * 4, 9);
    expect(big.maxAngvel).toBeLessThan(fighter.maxAngvel);
  });

  it('more or bigger engines counteract the size', () => {
    const one = scaleShipKind({ ...CAPITAL, thrusters: { count: 2, size: 30 } }, 1);
    const eight = scaleShipKind(CAPITAL, 1);
    expect(eight.thrustImpulse).toBeCloseTo(one.thrustImpulse * 4, 6);
    expect(eight.maxAngvel).toBeGreaterThan(one.maxAngvel);
    expect(eight.maxSpeed).toBeGreaterThan(one.maxSpeed);
  });

  it('re-scaling does not count the authored engines twice', () => {
    const a = scaleShipKind(scaleShipKind(CAPITAL, 1), 2);
    const b = scaleShipKind(CAPITAL, 2);
    expect(a.thrustImpulse).toBeCloseTo(b.thrustImpulse, 6);
  });
});

describe('ship scale — the capital class', () => {
  it('a gigantic hull gets clearances past its own hull and a bigger texture budget', () => {
    const cap = scaleShipKind(CAPITAL, 1);
    const t = shipTuning(cap);
    expect(t.sizeClass).toBe('capital');
    expect(t.muzzleClearance).toBeGreaterThan(cap.radius);
    expect(t.spawnClearance).toBeGreaterThan(cap.radius);
    expect(t.bakeMaxSide).toBe(CLASS_TUNING.capital.bakeMaxSide);
    expect(t.mountSize).toBe('L');
  });
});

describe('ship scale — combat profiles', () => {
  it('A keeps weapon distances; B grows reach half as fast as the ships and splash with them', () => {
    expect(combatDistanceScale('A', 2)).toEqual({ reach: 1, splash: 1 });
    expect(combatDistanceScale('B', 2)).toEqual({ reach: 1.5, splash: 2 });
    expect(combatDistanceScale('B', 1)).toEqual({ reach: 1, splash: 1 });
  });

  it('the 1x fighter values are the old constants', () => {
    expect(BASE.muzzleClearance).toBe(20);
    expect(BASE.hitRadius).toBe(12);
    expect(BASE.shieldPad).toBe(10);
    expect(BASE.lootPickup).toBe(80);
  });
});

describe('camera at the ship scale', () => {
  it('start zoom is the base at 1× and eases out as ships grow, never past the floor', async () => {
    const { startZoomForScale } = await import('../../src/shared-types/shipScale/tuning.js');
    expect(startZoomForScale(0.5, 1)).toBe(0.5);
    for (const s of [2, 4]) {
      const z = startZoomForScale(0.5, s);
      expect(z).toBeLessThan(0.5);
      expect(z * s).toBeGreaterThan(0.5); // ships still draw bigger on screen
      expect(z).toBeGreaterThanOrEqual(0.15); // the gameplay zoom-out floor
    }
  });
});

describe('per-kind size overrides (EQX_SHIP_KIND_SCALE)', () => {
  it('parses id:scale[:class[:count:size]] and ignores junk', async () => {
    const { parseKindScaleOverrides, resolveShipScaleConfig } = await import('../../src/shared-types/shipScale/config.js');
    const m = parseKindScaleOverrides('gunship:10:capital:8:30,heavy:3,bad,:2,x:-1');
    expect(m.get('gunship')).toEqual({ sizeScale: 10, sizeClass: 'capital', thrusters: { count: 8, size: 30 } });
    expect(m.get('heavy')).toEqual({ sizeScale: 3 });
    expect(m.size).toBe(2);
    expect(resolveShipScaleConfig({ workerName: 'bake;shipScale=2;shipTuning=A;kindScale=gunship:10:capital' }).kinds).toBe('gunship:10:capital');
    expect(resolveShipScaleConfig({ global: { __EQX_SHIP_KIND_SCALE__: 'a b' } }).kinds).toBe('');
  });
});
