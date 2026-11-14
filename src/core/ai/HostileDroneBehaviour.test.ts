import { describe, it, expect } from 'vitest';
// Some cases lock AUTHORED 1× numbers (ranges, distances inside today's
// standoff); they run at 1× via `pnpm test:authored-scale` (ship-scale.md).
import { AT_AUTHORED_SHIP_SCALE } from '../../shared-types/shipScale/config.js';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { DriftingAsteroidBehaviour } from './DriftingAsteroidBehaviour.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { boostOf, stepKinematic, throttleOf, turnOf } from './pilotTestKit.js';

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
    // It flies with control keys (virtual pilot): some key is held, and no
    // AI-only impulse is ever produced.
    expect(intent.input).toBeDefined();
    expect(intent.input).not.toBe(0);
    expect(intent.fx).toBe(0);
    expect(intent.fy).toBe(0);
    expect(intent.setAngvel).toBeUndefined();
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
    // bias active, its control keys — integrated by a kinematic model of
    // applyShipInput — should bring it closer to origin over time.
    const b = new HostileDroneBehaviour();
    const kind = getShipKind('fighter');
    const body = { x: 5000, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    for (let t = 0; t < 1200; t++) {
      const intent = b.tick({ id: 'd', ...body }, viewWith([], t));
      stepKinematic(body, kind, intent);
    }
    const { x, y } = body;
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
    return turnOf(intent);
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
    const turn1 = turnOf(t1);
    // Within the dwell window an equidistant `right` appears. Dwell holds `left`
    // → turn keeps the same sign (still steering toward the left target).
    const t2 = b.tick(droneAt(0, 0, 0, 0), view([at('left', -100, 0, 100), at('right', 100, 0, 100)], 210));
    const turn2 = turnOf(t2);
    expect(Math.sign(turn2)).toBe(Math.sign(turn1));
    expect(turn1).not.toBe(0);
  });
});

describe('HostileDroneBehaviour — wave-system Phase 2 structure targeting', () => {
  // Same sign-of-turn convention as Part C: a target to the LEFT vs RIGHT
  // produces opposite-sign turns, so matching a single-target reference tells
  // us which candidate was picked.
  const player = (id: string, x: number, y: number): AiWorldView['players'][number] => ({
    id, x, y, vx: 0, vy: 0, health: 100, maxHealth: 100,
  });
  const structure = (
    id: string, x: number, y: number, priority = 1,
  ): NonNullable<AiWorldView['structures']>[number] => ({
    id, x, y, health: 300, maxHealth: 300, priority,
  });
  const view = (
    players: AiWorldView['players'],
    structures: AiWorldView['structures'],
    tick = 200,
  ): AiWorldView => ({ players, structures, tick, dtSec: 1 / 60 });
  const turnFor = (markIds: string[], v: AiWorldView): number => {
    const b = new HostileDroneBehaviour();
    for (const id of markIds) b.markHostile(id, 100);
    const intent = b.tick(droneAt(0, 0, 0, 0), v);
    return turnOf(intent);
  };

  it('targets a hostile structure when it is the only candidate', () => {
    // Structure to the RIGHT, hostile, no players. The drone should steer
    // toward it (non-zero turn matching a player-at-the-same-spot reference).
    const structTurn = turnFor(['s1'], view([], [structure('s1', 100, 0)]));
    const playerRef = turnFor(['p1'], view([player('p1', 100, 0)], []));
    expect(structTurn).not.toBe(0);
    expect(Math.sign(structTurn)).toBe(Math.sign(playerRef));
  });

  it('prefers a structure over an equidistant player (priority bias, req #2)', () => {
    // player RIGHT (priority 0), structure LEFT (priority 1). Both equidistant,
    // both hostile, equal health. The structure priority bias must win → turn
    // sign matches the structure-only reference, opposite the player-only one.
    const both = turnFor(['p1', 's1'], view([player('p1', 100, 0)], [structure('s1', -100, 0)]));
    const structOnly = turnFor(['s1'], view([], [structure('s1', -100, 0)]));
    const playerOnly = turnFor(['p1'], view([player('p1', 100, 0)], []));
    expect(Math.sign(both)).toBe(Math.sign(structOnly));
    expect(Math.sign(both)).not.toBe(Math.sign(playerOnly));
    expect(structOnly).not.toBe(0);
  });

  it('ignores a structure that is NOT in the hostile set (neutral base)', () => {
    // Structure present in the view but the drone is only hostile to the player.
    // It must pick the player, never the un-marked structure.
    const both = turnFor(['p1'], view([player('p1', 100, 0)], [structure('s1', -100, 0)]));
    const playerOnly = turnFor(['p1'], view([player('p1', 100, 0)], []));
    expect(Math.sign(both)).toBe(Math.sign(playerOnly));
    expect(playerOnly).not.toBe(0);
  });

  it('absent structures ⇒ identical pick to players-only (byte-identical default)', () => {
    const withUndefined = turnFor(['p1', 'p2'], view([player('p1', 100, 0), player('p2', -100, 30)], undefined));
    const withEmpty = turnFor(['p1', 'p2'], view([player('p1', 100, 0), player('p2', -100, 30)], []));
    expect(withUndefined).toBe(withEmpty);
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

  it.runIf(AT_AUTHORED_SHIP_SCALE)('targets the nearest hostile when two players are present', () => {
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
    // Already aimed at near → bearing error ≈ 0 → no turn key; thrust in.
    expect(turnOf(intent)).toBe(0);
    expect(throttleOf(intent)).toBe(1);
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
    // Off-bearing ⇒ a turn key toward it (target on the right ⇒ turn right).
    expect(turnOf(intent)).toBe(-1);
  });

  it.runIf(AT_AUTHORED_SHIP_SCALE)('flies with player keys only: facing away, it turns rather than thrust sideways', () => {
    // Drone at angle=π/2 → forward = (-1, 0); target behind it at +x in the
    // approach window. A player can only push along the nose, so the pilot
    // turns toward the target and never thrusts away from it (owner rule
    // 2026-11-13: no AI-only impulse toward the target).
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, Math.PI / 2, 0), viewWith([{ id: 'p', x: 400, y: 0 }]));
    expect(intent.fx).toBe(0);
    expect(intent.fy).toBe(0);
    expect(turnOf(intent)).not.toBe(0);
    expect(throttleOf(intent)).not.toBe(1);
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
    expect(turnOf(intent)).toBe(-1); // leads to the right (+x)
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

  it('boosts (thrust + boost keys) when the hostile target is far, not when near', () => {
    // Engage-boost threshold = 1.5 × fireRange. Target at 3 × fireRange
    // (boosted) vs 0.8 × (approach window, no boost).
    const b1 = new HostileDroneBehaviour();
    b1.markHostile('p', 0);
    const farIntent = b1.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: b1.getFireRange() * 3 }]));

    const b2 = new HostileDroneBehaviour();
    b2.markHostile('p', 0);
    const nearIntent = b2.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: b2.getFireRange() * 0.8 }]));

    expect(throttleOf(farIntent)).toBe(1);
    expect(boostOf(farIntent)).toBe(true);
    expect(boostOf(nearIntent)).toBe(false);
    // Boost is paid from the NPC's energy pool, as a pilot's is.
    expect(b1.getEnergy()).toBeLessThan(b2.getEnergy());
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
  it.runIf(AT_AUTHORED_SHIP_SCALE)('per-weapon fire ranges: beam very close, bolt medium, missile long', () => {
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
    // back-off band (fireRange × 0.4). It must press REVERSE (−y) to kite.
    const close = 0.2 * range;
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: close }], 100));
    expect(throttleOf(intent)).toBe(-1);
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
    expect(throttleOf(farIntent)).toBe(1); // boring in
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
    expect(ia.input).toBeDefined();
    expect(ia.input).toBe(ib.input);
  });
});
