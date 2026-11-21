/**
 * Tractor force field (salvage PR 10): the `tractor` kind in the one
 * force-field list. Pure formula tests on `tractorImpulse`, then Rapier
 * world tests (spawn, `tick`, read the pose). Guide: physics-worker.md
 * "Force fields".
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import {
  FORCE_FIELD_MASS_SCALED, TRACTOR_LINE_CAP, storeForceField, tractorImpulse, type TractorForceField,
} from './forceFields.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { setTractorHold, setTractorMountConstants, setTractorMuzzle } from '../combat/tractorField.js';

const DT = 1 / 60;

function tractor(over: Partial<TractorForceField> = {}): TractorForceField {
  return {
    kind: 'tractor', active: true, mx: 0, my: 0, mvx: 0, mvy: 0,
    target: 'target', emitter: 'emitter',
    force: 200, dRef: 80, reach: 2000, hold: 100, lineHalfWidth: 20, lineFrac: 0.25,
    lineCount: 0, lineIds: [],
    ...over,
  };
}

const out = { x: 0, y: 0 };

describe('tractorImpulse (pure formula)', () => {
  it('inverse-square pull toward the muzzle, capped at dRef', () => {
    const f = tractor();
    tractorImpulse(f, 160, 0, 0, 0, 1, DT, false, out);
    expect(out.x).toBeCloseTo(-200 * 0.25 * DT, 10); // (80/160)² = 1/4
    expect(out.y).toBe(0);
    tractorImpulse(tractor({ hold: 50 }), 0, -60, 0, 0, 1, DT, false, out); // inside dRef, outside hold: full force
    expect(out.y).toBeCloseTo(200 * DT, 10);
  });

  it('nothing at or beyond reach', () => {
    expect(tractorImpulse(tractor({ reach: 500 }), 500, 0, 0, 0, 1, DT, false, out)).toBe(false);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('same impulse whatever the mass outside hold (a force, not mass-scaled)', () => {
    const a = { x: 0, y: 0 };
    tractorImpulse(tractor(), 300, 0, 0, 0, 1, DT, false, a);
    tractorImpulse(tractor(), 300, 0, 0, 0, 100, DT, false, out);
    expect(out.x).toBe(a.x);
    expect(FORCE_FIELD_MASS_SCALED.tractor).toBe(false);
  });

  it('inside hold: spring pushes out by k(hold − d), damps relative velocity, clamps to F_mount', () => {
    const f = tractor(); // k = 200 / 100 = 2
    tractorImpulse(f, 60, 0, 0, 0, 1, DT, false, out); // at rest, 40 inside
    expect(out.x).toBeCloseTo(2 * 40 * DT, 10);
    // Moving with the muzzle: no damping term.
    tractorImpulse(tractor({ mvx: 0, mvy: 30 }), 60, 0, 0, 30, 1, DT, false, out);
    expect(out.y).toBeCloseTo(0, 10);
    // Fast inward: clamped to F_mount.
    tractorImpulse(f, 60, 0, -1000, 0, 1, DT, false, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(200 * DT, 10);
  });

  it('a line body gets lineFrac × F(d) beyond hold, nothing inside it (no spring, no pull onto the hull)', () => {
    tractorImpulse(tractor(), 160, 0, 0, 0, 1, DT, true, out);
    expect(out.x).toBeCloseTo(-0.25 * 200 * 0.25 * DT, 10);
    tractorImpulse(tractor({ hold: 50 }), 60, 0, 0, 0, 1, DT, true, out); // inside dRef, beyond hold: full lineFrac
    expect(out.x).toBeCloseTo(-0.25 * 200 * DT, 10);
    expect(tractorImpulse(tractor({ hold: 100 }), 50, 0, 0, 0, 1, DT, true, out)).toBe(false); // inside hold
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('storeForceField copies into a fixed-capacity record and reuses it', () => {
    const src = tractor({ lineCount: 20, lineIds: Array.from({ length: 20 }, (_, i) => 'b' + i) });
    const rec = storeForceField(undefined, src) as TractorForceField;
    expect(rec).not.toBe(src);
    expect(rec.lineIds.length).toBe(TRACTOR_LINE_CAP);
    expect(rec.lineCount).toBe(TRACTOR_LINE_CAP);
    const again = storeForceField(rec, tractor({ mx: 5, lineCount: 1, lineIds: ['z'] }));
    expect(again).toBe(rec);
    expect(rec.mx).toBe(5);
    expect(rec.lineCount).toBe(1);
    expect(rec.lineIds[0]).toBe('z');
  });

  it('MOUNT_SIZE_TUNING.power rises with mount size, AA below S', () => {
    const p = (['AA', 'S', 'M', 'L', 'XL'] as const).map((s) => MOUNT_SIZE_TUNING[s].power);
    for (let i = 1; i < p.length; i++) expect(p[i]!).toBeGreaterThan(p[i - 1]!);
    expect(MOUNT_SIZE_TUNING.S).toEqual({ reach: 1, radius: 1, splash: 1, power: 1 });
  });
});

async function world(targetX: number, targetMass = 1): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnObstacle('emitter', 0, 0, 10, 50);
  w.spawnObstacle('target', targetX, 0, 10, targetMass);
  w.tick(DT);
  return w;
}

function run(w: PhysicsWorld, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) { each?.(); w.tick(DT); }
}

function pos(w: PhysicsWorld, id: string): { x: number; y: number; vx: number; vy: number } {
  return w.getShipState(id)!;
}

describe('PhysicsWorld — tractor force field', () => {
  it('pulls a light body toward the muzzle', async () => {
    const w = await world(600);
    w.setForceField('t', tractor());
    run(w, 60);
    expect(pos(w, 'target').x).toBeLessThan(600 - 1.5); // a = F(600)/m ≈ 3.6 u/s² ⇒ ~1.8 u in 1 s
    expect(pos(w, 'target').vx).toBeLessThan(0);
  });

  it('a 100× heavier body moves ~100× less under the same field', async () => {
    const light = await world(600, 1);
    const heavy = await world(600, 100);
    light.setForceField('t', tractor());
    heavy.setForceField('t', tractor());
    run(light, 30);
    run(heavy, 30);
    const ratio = (600 - pos(light, 'target').x) / (600 - pos(heavy, 'target').x);
    expect(ratio).toBeGreaterThan(90);
    expect(ratio).toBeLessThan(110);
  });

  it('settles near hold without slamming into the emitter (critically damped cushion)', async () => {
    const w = await world(600);
    w.setForceField('t', tractor());
    let minD = Infinity;
    run(w, 1800, () => { minD = Math.min(minD, Math.hypot(pos(w, 'target').x, pos(w, 'target').y)); });
    const s = pos(w, 'target');
    expect(minD).toBeGreaterThan(30); // never touched the emitter (radii 10 + 10)
    expect(Math.hypot(s.x, s.y)).toBeGreaterThan(95);
    expect(Math.hypot(s.x, s.y)).toBeLessThan(101);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(1);
  });

  it('a body thrusting away harder than F(d) escapes; a weaker one is reeled in', async () => {
    const fAt300 = 200 * (80 / 300) ** 2; // ~14.2
    const strong = await world(300);
    const weak = await world(300);
    strong.setForceField('t', tractor());
    weak.setForceField('t', tractor());
    run(strong, 180, () => strong.applyImpulse('target', 1.5 * fAt300 * DT, 0, 0));
    run(weak, 180, () => weak.applyImpulse('target', 0.5 * fAt300 * DT, 0, 0));
    expect(pos(strong, 'target').x).toBeGreaterThan(300 + 5);
    expect(pos(weak, 'target').x).toBeLessThan(300 - 5);
  });

  it('a beam-line body is pulled weaker (lineFrac) than the target at the same distance', async () => {
    const w = await world(600);
    w.spawnObstacle('crosser', 0, 600, 10, 1);
    w.tick(DT);
    w.setForceField('t', tractor({ lineCount: 1, lineIds: ['crosser'] }));
    run(w, 30);
    const dTarget = 600 - pos(w, 'target').x;
    const dLine = 600 - pos(w, 'crosser').y;
    expect(dLine / dTarget).toBeCloseTo(0.25, 2);
  });

  it('beyond reach: nothing moves', async () => {
    const w = await world(600);
    w.setForceField('t', tractor({ reach: 500 }));
    run(w, 60);
    expect(pos(w, 'target').x).toBeCloseTo(600, 6);
  });

  it('the emitter feels nothing, even if listed on the beam line', async () => {
    const w = await world(600);
    w.setForceField('t', tractor({ mx: 30, lineCount: 1, lineIds: ['emitter'] }));
    run(w, 120);
    const e = pos(w, 'emitter');
    expect([e.x, e.y, e.vx, e.vy]).toEqual([0, 0, 0, 0]);
    expect(pos(w, 'target').x).toBeLessThan(600);
  });

  it('inactive or removed: nothing moves', async () => {
    const w = await world(600);
    w.setForceField('t', tractor({ active: false }));
    run(w, 30);
    w.setForceField('t', tractor());
    w.removeForceField('t');
    run(w, 30);
    expect(pos(w, 'target').x).toBeCloseTo(600, 6);
  });
});

/**
 * Bug (base-build-test, 2026-11-20): a mining skiff holding its tractor on a
 * rock piece ~250 u off ran away from the piece at a steady ~40–57 u/s with
 * the helm on Stop. Cause: crumbs from the same cut rested against the hull
 * on the beam line; a beam-line body was pulled toward the muzzle even inside
 * `hold`, and the muzzle sits inside the hull, so the crumb pressed on the
 * hull with lineFrac × F. The emitter feels no reaction, so that press was a
 * free thruster pushing the ship along the pull. Same poses as the server
 * (`setTractorMountConstants` / `setTractorMuzzle` / `setTractorHold`).
 */
describe('PhysicsWorld — tractor on a real skiff with a crumb on the beam line', () => {
  it('the ship stays put and the piece closes to the hold while a crumb rests on the hull', async () => {
    const kind = getShipKind('mining-skiff');
    const mount = kind.mounts!.find((m) => m.weaponId === 'tractor')!;
    const w = await PhysicsWorld.create();
    w.spawnShip('ship', 0, 0, 'mining-skiff');
    // The locked piece straight ahead of the dish, ~250 u past the muzzle.
    w.spawnObstacle('piece', mount.localX, mount.localY + 266, 16, 60);
    // A crumb on the beam line, just off the bow at the dish.
    w.spawnObstacle('crumb', mount.localX, mount.localY + 55, 12, 30);
    w.tick(DT);
    const f: TractorForceField = tractor({ target: 'piece', emitter: 'ship', lineCount: 1, lineIds: ['crumb'] });
    expect(setTractorMountConstants(f, mount)).toBe(true);
    let maxPieceD = 0;
    run(w, 600, () => {
      const s = w.getShipState('ship')!;
      setTractorMuzzle(f, s.x, s.y, s.angle, mount);
      const p = pos(w, 'piece');
      setTractorHold(f, mount, 'mining-skiff', s.angle, p.x, p.y, 16);
      f.mvx = s.vx; f.mvy = s.vy;
      w.setForceField('t', f);
      maxPieceD = Math.max(maxPieceD, Math.hypot(p.x - f.mx, p.y - f.my));
    });
    const s = w.getShipState('ship')!;
    expect(Math.hypot(s.x, s.y), 'the ship is not towed by its own beam').toBeLessThan(5);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(1);
    const p = pos(w, 'piece');
    expect(Math.hypot(p.x - f.mx, p.y - f.my), 'the piece settles at the hold').toBeLessThan(f.hold + 5);
    expect(maxPieceD).toBeLessThan(270);
  });
});
