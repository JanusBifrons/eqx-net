import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { DriftingAsteroidBehaviour } from './DriftingAsteroidBehaviour.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';

const droneAt = (x: number, y: number, angle = 0, angvel = 0): AiEntity => ({
  id: 'drone-1', x, y, vx: 0, vy: 0, angle, angvel,
});

const viewWith = (
  players: Array<{ id: string; x: number; y: number }>,
  tick = 0,
): AiWorldView => ({
  players: players.map((p) => ({ ...p, vx: 0, vy: 0 })),
  tick,
  dtSec: 1 / 60,
});

describe('DriftingAsteroidBehaviour', () => {
  it('returns zero intent regardless of player position', () => {
    const b = new DriftingAsteroidBehaviour();
    const intent = b.tick(droneAt(0, 0), viewWith([{ id: 'p1', x: 50, y: 0 }]));
    expect(intent.fx).toBe(0);
    expect(intent.fy).toBe(0);
    expect(intent.torque).toBe(0);
    expect(intent.fire).toBeUndefined();
  });

  it('does not allocate per call (returns frozen singleton)', () => {
    const b = new DriftingAsteroidBehaviour();
    const a = b.tick(droneAt(0, 0), viewWith([]));
    const c = b.tick(droneAt(10, 10), viewWith([]));
    expect(a).toBe(c);
  });
});

describe('HostileDroneBehaviour — IDLE patrol', () => {
  it('starts in IDLE state', () => {
    const b = new HostileDroneBehaviour();
    expect(b.getState()).toBe('IDLE');
  });

  it('IDLE drone with no players still produces patrol motion (does not idle to zero)', () => {
    // Phase 1 deliberately changed the "no players => zero intent"
    // contract: drones now patrol when not provoked. This documents the
    // new behaviour.
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(500, 0, 0, 0), viewWith([]));
    // Some component of motion should be non-zero.
    const motion = Math.abs(intent.fx) + Math.abs(intent.fy) + Math.abs(intent.torque);
    expect(motion).toBeGreaterThan(0);
    // IDLE drones never fire.
    expect(intent.fire).toBeUndefined();
  });

  it('IDLE drone never fires even when a non-hostile player is in lethal position', () => {
    const b = new HostileDroneBehaviour();
    // Player directly ahead of a drone facing +y, in fire range.
    const intent = b.tick(
      droneAt(0, 0, 0, 0),
      viewWith([{ id: 'innocent', x: 0, y: 100 }], 100),
    );
    expect(intent.fire).toBeUndefined();
  });

  it('IDLE drone outside the patrol radius steers back inward over many ticks', () => {
    // Spawn the drone well outside the patrol radius. With the inward
    // bias active, repeated ticks of patrol intent — applied through a
    // simple Euler integrator that mimics Rapier's drag — should bring
    // the drone closer to origin over time.
    const b = new HostileDroneBehaviour();
    let x = 5000, y = 0, angle = 0, angvel = 0;
    let vx = 0, vy = 0;
    const drag = 0.97; // approximation of Rapier linear damping per tick
    for (let t = 0; t < 1200; t++) {
      const intent = b.tick({ id: 'd', x, y, vx, vy, angle, angvel }, viewWith([], t));
      // Linear: velocity Verlet–ish. Mass=1 for simplicity.
      vx = vx * drag + intent.fx;
      vy = vy * drag + intent.fy;
      x += vx * (1 / 60);
      y += vy * (1 / 60);
      // Angular: drones now use the player snap-set path
      // (`setAngvel` rather than torque), so the integrator just adopts
      // the requested angvel directly. Falls back to a damped-residual
      // step when the intent didn't request a setAngvel (defensive).
      if (intent.setAngvel !== undefined) {
        angvel = intent.setAngvel;
      } else {
        angvel = angvel * 0.85 + intent.torque;
      }
      angle += angvel * (1 / 60);
    }
    const finalR = Math.hypot(x, y);
    // Drone should have moved measurably toward origin (started at 5000).
    expect(finalR).toBeLessThan(5000);
  });
});

describe('HostileDroneBehaviour — Part C target selection', () => {
  // Convention-agnostic: assert WHICH target was chosen by the SIGN of the
  // drone's turn intent (it rotates toward its target). Two equidistant
  // hostiles placed symmetrically left/right produce opposite-sign turns, so
  // matching the single-target reference tells us which one was picked.
  const turnToward = (view: AiWorldView): number => {
    const b = new HostileDroneBehaviour();
    b.markHostile('full', 100);
    b.markHostile('wounded', 100);
    const intent = b.tick(droneAt(0, 0, 0, 0), view);
    return intent.setAngvel ?? intent.torque ?? 0;
  };
  const at = (id: string, x: number, y: number, health: number): AiWorldView['players'][number] => ({
    id, x, y, vx: 0, vy: 0, health, maxHealth: 100,
  });
  const view = (players: AiWorldView['players'], tick = 200): AiWorldView => ({ players, tick, dtSec: 1 / 60 });

  it('picks the lower-health hostile over an equidistant full-HP one', () => {
    // full-HP to the RIGHT (first in order → pure-nearest tie-break), wounded to
    // the LEFT. Health weighting must pick the wounded (left) → turn sign equals
    // the wounded-only reference and is OPPOSITE the full-only reference.
    const both = turnToward(view([at('full', 100, 0, 100), at('wounded', -100, 0, 10)]));
    const woundedOnly = turnToward(view([at('wounded', -100, 0, 10)]));
    const fullOnly = turnToward(view([at('full', 100, 0, 100)]));
    expect(Math.sign(both)).toBe(Math.sign(woundedOnly));
    expect(Math.sign(both)).not.toBe(Math.sign(fullOnly));
    expect(woundedOnly).not.toBe(0);
  });

  it('holds its committed target through the dwell window', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('left', 100);
    b.markHostile('right', 100);
    // Acquire `left` first (only it in view).
    const t1 = b.tick(droneAt(0, 0, 0, 0), view([at('left', -100, 0, 100)], 200));
    const turn1 = t1.setAngvel ?? t1.torque ?? 0;
    // Within the dwell window an equidistant `right` appears. Dwell holds `left`
    // → turn keeps the same sign (still steering toward the left target).
    const t2 = b.tick(droneAt(0, 0, 0, 0), view([at('left', -100, 0, 100), at('right', 100, 0, 100)], 210));
    const turn2 = t2.setAngvel ?? t2.torque ?? 0;
    expect(Math.sign(turn2)).toBe(Math.sign(turn1));
    expect(turn1).not.toBe(0);
  });
});

describe('HostileDroneBehaviour — hostility lifecycle', () => {
  it('flips to COMBAT after markHostile', () => {
    const b = new HostileDroneBehaviour();
    expect(b.getState()).toBe('IDLE');
    b.markHostile('attacker', 100);
    expect(b.getState()).toBe('COMBAT');
  });

  it('returns to IDLE after purgeHostility clears the only hostile', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('attacker', 100);
    expect(b.getState()).toBe('COMBAT');
    b.purgeHostility('attacker');
    expect(b.getState()).toBe('IDLE');
  });

  it('stays in COMBAT after purging one of two hostiles', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('a', 100);
    b.markHostile('b', 100);
    b.purgeHostility('a');
    expect(b.getState()).toBe('COMBAT');
  });

  it('time-decays hostile players after FORGET_TICKS without a fresh hit', () => {
    // FORGET_TICKS = 1800 in HostileDroneBehaviour. Bump tick past that.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 100);
    // Tick at 100 + 1801: hostility should have decayed and state should
    // return to IDLE on the next tick (decay runs at the top of `tick`).
    b.tick(droneAt(0, 0, 0, 0), viewWith([], 100 + 1801));
    expect(b.getState()).toBe('IDLE');
  });

  it('markHostile is a no-op for falsy shooterIds', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('', 100);
    expect(b.getState()).toBe('IDLE');
  });

  it('purgeHostility is a no-op for unknown players', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('a', 100);
    b.purgeHostility('not-a');
    expect(b.getState()).toBe('COMBAT');
  });
});

describe('HostileDroneBehaviour — COMBAT pursuit', () => {
  // Combat tests now require markHostile to put the drone in COMBAT mode
  // (which targets only marked-hostile players, not "any nearest").

  it('targets the nearest hostile when two players are present', () => {
    // Default kind = fighter (bolt), fireRange ≈ 560 ⇒ STOP_DIST ≈ 336. The
    // near target sits in the approach window (> STOP_DIST so the drone
    // thrusts forward toward it; the standoff logic hovers inside STOP_DIST).
    // Both targets straight ahead so "nearest" is unambiguous + aim centred.
    const b = new HostileDroneBehaviour();
    b.markHostile('near', 0);
    b.markHostile('far', 0);
    const intent = b.tick(
      droneAt(0, 0, 0, 0),
      viewWith([{ id: 'far', x: 0, y: 700 }, { id: 'near', x: 0, y: 400 }]),
    );
    // Already aimed at near → bearing error ≈ 0 → setAngvel drops into
    // the dead zone and is 0 (or undefined).
    expect(Math.abs(intent.setAngvel ?? 0)).toBeLessThan(0.1);
    expect(intent.fy).toBeGreaterThan(0);
  });

  it('ignores non-hostile players (a bystander cannot bait the drone)', () => {
    // Drone hostile only to "attacker"; bystander is closer but invisible
    // to combat targeting. Drone should fall through to patrol because
    // there's no hostile in view (attacker not in view this frame).
    const b = new HostileDroneBehaviour();
    b.markHostile('attacker', 0);
    const intent = b.tick(
      droneAt(500, 0, 0, 0),
      viewWith([{ id: 'bystander', x: 510, y: 0 }]),
    );
    // Patrol intent: never fires on bystanders.
    expect(intent.fire).toBeUndefined();
  });

  it('produces nonzero turn intent when hostile target is off-bearing', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 100, y: 0 }]));
    // Drones now snap-set angvel (player parity); off-bearing should
    // produce a non-zero target angvel rather than a torque.
    expect(intent.setAngvel ?? 0).not.toBe(0);
  });

  it('thrust is along the drone\'s current forward, not toward the target', () => {
    // Drone at angle=π/2 → forward = (-sin(π/2), cos(π/2)) = (-1, 0). Target
    // placed in the approach window (> STOP_DIST ≈ 336 for the fighter bolt)
    // so the drone thrusts forward (−x) rather than hovering inside the stop
    // distance — proving thrust follows the body's facing, not the bearing.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, Math.PI / 2, 0), viewWith([{ id: 'p', x: 400, y: 0 }]));
    expect(intent.fx).toBeLessThan(0);
    expect(intent.fy).toBeCloseTo(0, 5);
  });

  it('fires when in range, aimed, and off cooldown', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 100 }], 100));
    expect(intent.fire).toBeDefined();
    expect(intent.fire!.dirX).toBeCloseTo(0, 5);
    expect(intent.fire!.dirY).toBeCloseTo(1, 5);
  });

  it('does not fire when out of range', () => {
    // fighter (bolt) fireRange ≈ 560; place the target well beyond it.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 900 }], 100));
    expect(intent.fire).toBeUndefined();
  });

  it('does not fire when off-bearing', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 100, y: 0 }], 100));
    expect(intent.fire).toBeUndefined();
  });

  it('respects cooldown (no fire on second call within WEAPON_COOLDOWN_TICKS)', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const aimed = viewWith([{ id: 'p', x: 0, y: 100 }], 100);
    const first = b.tick(droneAt(0, 0, 0, 0), aimed);
    expect(first.fire).toBeDefined();

    const tooSoon = viewWith([{ id: 'p', x: 0, y: 100 }], 100 + WEAPON_COOLDOWN_TICKS - 1);
    const second = b.tick(droneAt(0, 0, 0, 0), tooSoon);
    expect(second.fire).toBeUndefined();

    const offCooldown = viewWith([{ id: 'p', x: 0, y: 100 }], 100 + WEAPON_COOLDOWN_TICKS);
    const third = b.tick(droneAt(0, 0, 0, 0), offCooldown);
    expect(third.fire).toBeDefined();
  });

  it('lead-aims a moving target (off-axis aim error when target has lateral velocity)', () => {
    // Drone at origin facing +y, perfectly aligned with a STATIONARY
    // target at (0, 200) — would fire immediately. With the same target
    // moving at +x (vx=100, vy=0), the drone should now aim slightly
    // to the right of straight, producing a non-zero bearing error
    // and (with that error > tolerance) NOT firing this tick.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const moving: AiWorldView = {
      players: [{ id: 'p', x: 0, y: 200, vx: 100, vy: 0 }],
      tick: 100,
      dtSec: 1 / 60,
    };
    const intent = b.tick(droneAt(0, 0, 0, 0), moving);
    expect(intent.setAngvel ?? 0).not.toBe(0);
  });

  it('FIRES along the lead vector (intercept point), not straight at the target', () => {
    // Regression lock for the 2026-06-03 "AI bolts miss moving targets"
    // fix. Pre-fix the lead was computed for body STEERING only and the
    // shot fired along body-forward — so a drone aligned to a target that
    // is sliding sideways still shot at where the target IS, and the bolt
    // (with travel time) missed. The fired direction must now point at the
    // intercept point.
    const b = new HostileDroneBehaviour(); // fighter (bolt), muzzle 1600
    b.markHostile('p', 0);
    // Drone at origin facing +y; target dead ahead at (0,200) moving +x.
    // Intercept is to the RIGHT, so fire.dirX must be positive (it would
    // be exactly 0 — straight up the body-forward axis — pre-fix).
    const movingRight: AiWorldView = {
      players: [{ id: 'p', x: 0, y: 200, vx: 200, vy: 0 }],
      tick: 100,
      dtSec: 1 / 60,
    };
    const intent = b.tick(droneAt(0, 0, 0, 0), movingRight);
    expect(intent.fire).toBeDefined();
    expect(intent.fire!.dirX).toBeGreaterThan(0.05); // leads +x, not (0,1)
    expect(Math.hypot(intent.fire!.dirX, intent.fire!.dirY)).toBeCloseTo(1, 5);

    // Stationary target → no lead → fires straight at it (dirX ≈ 0).
    const b2 = new HostileDroneBehaviour();
    b2.markHostile('p', 0);
    const stationary: AiWorldView = {
      players: [{ id: 'p', x: 0, y: 200, vx: 0, vy: 0 }],
      tick: 100,
      dtSec: 1 / 60,
    };
    const intent2 = b2.tick(droneAt(0, 0, 0, 0), stationary);
    expect(intent2.fire).toBeDefined();
    expect(Math.abs(intent2.fire!.dirX)).toBeLessThan(0.01);
  });

  it('boosts forward thrust when the hostile target is far', () => {
    // fighter (bolt) fireRange ≈ 560 ⇒ engage-boost threshold = 1.5× ≈ 840.
    // Target at 1000 (> 840 → boosted) vs 400 (approach window → base thrust).
    const b1 = new HostileDroneBehaviour();
    b1.markHostile('p', 0);
    const farIntent = b1.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 1000 }]));

    const b2 = new HostileDroneBehaviour();
    b2.markHostile('p', 0);
    const nearIntent = b2.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 400 }]));

    expect(farIntent.fy).toBeGreaterThan(nearIntent.fy);
  });

  it('uses the wider point-blank fire arc when the target is very close', () => {
    // Point-blank threshold is 0.4 × DRONE_FIRE_RANGE. After the
    // weapons/energy/AI overhaul (2026-06-01) the beam range dropped to 250
    // ⇒ DRONE_FIRE_RANGE = 150 ⇒ point-blank threshold = 60. At normal
    // distance and a 0.3 rad bearing error the drone would be off-cone
    // (tolerance 0.25); at point-blank (tolerance 0.45) it fires.
    // Drone at (0,0,0): forward = +y. Player at distance 40 (< 60) along an
    // angle ~0.3 off the nose.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const angle = 0.3; // bearing error
    const dist = 40;
    const px = -Math.sin(angle) * dist;  // mirrors the forward derivation
    const py = Math.cos(angle) * dist;
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: px, y: py }], 100));
    expect(intent.fire).toBeDefined();
  });
});

describe('HostileDroneBehaviour — weapon-aware engagement (overhaul §4)', () => {
  it('per-weapon fire ranges: beam very close, bolt medium, missile long', () => {
    const beam = new HostileDroneBehaviour('interceptor'); // hitscan
    const bolt = new HostileDroneBehaviour('fighter');     // laser
    const missile = new HostileDroneBehaviour('missile-frigate'); // heat-seeker
    expect(beam.getWeaponMode()).toBe('hitscan');
    expect(bolt.getWeaponMode()).toBe('projectile');
    expect(missile.getWeaponMode()).toBe('missile');
    // Ordering is the load-bearing intent (knife-fight < dogfight < artillery).
    expect(beam.getFireRange()).toBeLessThan(bolt.getFireRange());
    expect(bolt.getFireRange()).toBeLessThan(missile.getFireRange());
    // Beam is genuinely close (a few hundred u), missile is genuinely long.
    expect(beam.getFireRange()).toBeLessThan(300);
    expect(missile.getFireRange()).toBeGreaterThan(1000);
  });

  it('a missile drone backs AWAY when the target closes inside its fire range', () => {
    const b = new HostileDroneBehaviour('missile-frigate');
    b.markHostile('p', 0);
    const range = b.getFireRange();
    // Drone at origin facing +y; target straight ahead well inside the
    // back-off band (fireRange × 0.4). It must thrust in REVERSE (−y) to kite.
    const close = 0.2 * range;
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: close }], 100));
    expect(intent.fy).toBeLessThan(0);
  });

  it('a missile drone only fires from long range (out of range up close)', () => {
    const b = new HostileDroneBehaviour('missile-frigate');
    b.markHostile('p', 0);
    const range = b.getFireRange();
    // Aligned + long range → fires.
    const far = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 0.8 * range }], 100));
    expect(far.fire).toBeDefined();
  });

  it('a beam drone bores in to short range (does not fire from afar)', () => {
    const b = new HostileDroneBehaviour('interceptor');
    b.markHostile('p', 0);
    const range = b.getFireRange();
    // Beyond the (short) beam range → no fire, and it thrusts forward to close.
    const farIntent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: range * 3 }], 100));
    expect(farIntent.fire).toBeUndefined();
    expect(farIntent.fy).toBeGreaterThan(0); // boring in
    // In close range + aligned → fires.
    const closeIntent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: range * 0.8 }], 200));
    expect(closeIntent.fire).toBeDefined();
  });

  it('determinism: same inputs ⇒ same intent for a missile drone', () => {
    const a = new HostileDroneBehaviour('missile-frigate');
    const b = new HostileDroneBehaviour('missile-frigate');
    a.markHostile('p', 0);
    b.markHostile('p', 0);
    const ia = a.tick(droneAt(10, 20, 0.3, 0), viewWith([{ id: 'p', x: 300, y: 800 }], 100));
    const ib = b.tick(droneAt(10, 20, 0.3, 0), viewWith([{ id: 'p', x: 300, y: 800 }], 100));
    expect(ia.fx).toBeCloseTo(ib.fx, 10);
    expect(ia.fy).toBeCloseTo(ib.fy, 10);
    expect(ia.setAngvel ?? 0).toBeCloseTo(ib.setAngvel ?? 0, 10);
  });
});
