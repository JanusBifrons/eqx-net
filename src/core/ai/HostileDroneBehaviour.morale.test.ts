/**
 * AI overhaul slice 6b: the morale die wired into the brain. A hull trigger
 * rolls (the roll is injected through the `setMoraleRoll` seam, so the
 * outcome is forced); FallBack and Flee then run locked, the roll sees the
 * sensor picture from the neighbour grid, and a Flee ends in a warp-out
 * request (`AiIntent.warpOut`) after which the ship stands down.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { AiEntity, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { MANOEUVRE_FALL_BACK, MANOEUVRE_FLEE } from './tactics/manoeuvre.js';
import { MORALE_LOCK_TICKS, MORALE_OUTCOME, type MoraleInputs, type MoraleOutcome } from './tactics/morale.js';
import { FLEE_MAX_TICKS } from './tactics/stanceManoeuvres.js';

const K = getShipKind('fighter');

interface Entry { id: string; x: number; y: number; side: string; capital?: boolean; radius?: number }

/** A brute-force neighbour index over a fixed list. */
function grid(list: Entry[]): IAiNeighbourQuery {
  return {
    count: list.length,
    queryNeighbours(x, y, r, maxK, out, excludeId) {
      let n = 0;
      for (let i = 0; i < list.length && n < maxK && n < out.length; i++) {
        const e = list[i]!;
        if (e.id === excludeId) continue;
        if (Math.hypot(e.x - x, e.y - y) <= r) out[n++] = i;
      }
      return n;
    },
    idAt: (i) => list[i]!.id,
    xAt: (i) => list[i]!.x,
    yAt: (i) => list[i]!.y,
    vxAt: () => 0,
    vyAt: () => 0,
    radiusAt: (i) => list[i]!.radius ?? 20,
    sideAt: (i) => list[i]!.side,
    isPilotAt: () => false,
    isCapitalAt: (i) => list[i]!.capital === true,
  };
}

function self(health: number): AiEntity {
  return { id: 'me', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, health };
}

function setup(entries: Entry[], forced: MoraleOutcome) {
  const b = new HostileDroneBehaviour(K);
  const seen: MoraleInputs[] = [];
  b.setMoraleRoll((inputs) => { seen.push({ ...inputs }); return forced; });
  b.markHostile('enemy', 0);
  const swarms: AiSwarmView[] = [{ id: 'enemy', x: 0, y: 600, vx: 0, vy: 0, allegiance: 'traders' }];
  const nb = grid([{ id: 'me', x: 0, y: 0, side: 'drones' }, { id: 'enemy', x: 0, y: 600, side: 'traders' }, ...entries]);
  const view = (tick: number): AiWorldView => ({ players: [], tick, dtSec: 1 / 60, swarms, neighbours: nb });
  return { b, seen, view };
}

describe('HostileDroneBehaviour — morale wiring (slice 6b)', () => {
  it('a hull-25 trigger rolls; a forced FallBack runs FALL_BACK, locked for MORALE_LOCK_TICKS on its way', () => {
    // Friends well out of reach of a ship that never moves (the test pins
    // `self`), so it is still on its way when the lock runs out.
    const friends: Entry[] = [
      { id: 'f1', x: -1300, y: -200, side: 'drones' },
      { id: 'f2', x: -1400, y: 0, side: 'drones' },
      { id: 'f3', x: -1500, y: 200, side: 'drones' },
    ];
    const { b, seen, view } = setup(friends, MORALE_OUTCOME.FallBack);
    const hp = 0.2 * K.maxHealth;
    let t = 1;
    for (; t <= 60 && b.getManoeuvre() !== MANOEUVRE_FALL_BACK; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre()).toBe(MANOEUVRE_FALL_BACK);
    expect(b.getLastMoraleOutcome()).toBe(MORALE_OUTCOME.FallBack);
    expect(seen.length).toBe(1);
    // The roll saw the grid: 3 friends, 1 enemy, own size vs the enemy's.
    expect(seen[0]!.alliesNear).toBe(3);
    expect(seen[0]!.enemiesNear).toBe(1);
    expect(seen[0]!.hullFrac).toBeCloseTo(0.2, 5);
    expect(seen[0]!.ownSize).toBe(K.radius);
    expect(seen[0]!.isCapitalNearbyFriendly).toBe(false);
    // Held through the lock even at full decision cadence.
    const start = t;
    for (; t < start + MORALE_LOCK_TICKS - 30; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre()).toBe(MANOEUVRE_FALL_BACK);
    // Still on its way after the lock: it keeps going, until the cap
    // (3 × the lock), then the picker chooses again.
    for (; t < start + MORALE_LOCK_TICKS + 60; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre()).toBe(MANOEUVRE_FALL_BACK);
    for (; t < start + 3 * MORALE_LOCK_TICKS + 60; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre()).not.toBe(MANOEUVRE_FALL_BACK);
  });

  it('FallBack regroups, then re-engages: among its friends it returns to combat inside the lock', () => {
    // Filmed 2026-11-14 (take 1): a ship that had fallen back sat beside an
    // enemy at ~15 u/s for 5 s, held in FALL_BACK by the lock. Falling back
    // means regroup, then fight on from among them.
    const friends: Entry[] = [
      { id: 'f1', x: -150, y: -100, side: 'drones' },
      { id: 'f2', x: -200, y: 0, side: 'drones' },
      { id: 'f3', x: -250, y: 100, side: 'drones' },
    ];
    const { b, view } = setup(friends, MORALE_OUTCOME.FallBack);
    const hp = 0.2 * K.maxHealth;
    let t = 1;
    for (; t <= 60 && b.getManoeuvre() !== MANOEUVRE_FALL_BACK; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre()).toBe(MANOEUVRE_FALL_BACK);
    const start = t;
    for (; t < start + 30; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre(), 'among its friends: back to normal combat manoeuvres').not.toBe(MANOEUVRE_FALL_BACK);
    expect(t - start).toBeLessThan(MORALE_LOCK_TICKS);
  });

  it('FallBack with no friends to reach fights on', () => {
    const { b, view } = setup([], MORALE_OUTCOME.FallBack);
    const hp = 0.2 * K.maxHealth;
    let t = 1, fellBack = false;
    for (; t <= 60; t++) { b.tick(self(hp), view(t)); if (b.getManoeuvre() === MANOEUVRE_FALL_BACK) { fellBack = true; break; } }
    expect(fellBack).toBe(true);
    for (let k = 0; k < 30; k++, t++) b.tick(self(hp), view(t));
    expect(b.getLastMoraleOutcome()).toBe(MORALE_OUTCOME.FallBack);
    expect(b.getManoeuvre()).not.toBe(MANOEUVRE_FALL_BACK);
  });

  it('a friendly capital in sensors is reported to the roll', () => {
    const { b, seen, view } = setup([{ id: 'cap', x: -1500, y: 0, side: 'drones', capital: true, radius: 300 }], MORALE_OUTCOME.FallBack);
    for (let t = 1; t <= 60; t++) b.tick(self(0.2 * K.maxHealth), view(t));
    expect(seen[0]!.isCapitalNearbyFriendly).toBe(true);
  });

  it('FightOn leaves the normal picker in charge', () => {
    const { b, view } = setup([], MORALE_OUTCOME.FightOn);
    for (let t = 1; t <= 120; t++) b.tick(self(0.2 * K.maxHealth), view(t));
    expect(b.getLastMoraleOutcome()).toBe(MORALE_OUTCOME.FightOn);
    expect(b.getManoeuvre()).not.toBe(MANOEUVRE_FALL_BACK);
    expect(b.getManoeuvre()).not.toBe(MANOEUVRE_FLEE);
  });

  it('no trigger at full hull: the die is never rolled', () => {
    const { b, seen, view } = setup([], MORALE_OUTCOME.Flee);
    for (let t = 1; t <= 120; t++) b.tick(self(K.maxHealth), view(t));
    expect(seen.length).toBe(0);
  });

  it('a forced Flee runs FLEE, then asks to warp out once and stands down', () => {
    const { b, view } = setup([], MORALE_OUTCOME.Flee);
    const hp = 0.2 * K.maxHealth;
    let t = 1;
    for (; t <= 60 && b.getManoeuvre() !== MANOEUVRE_FLEE; t++) b.tick(self(hp), view(t));
    expect(b.getManoeuvre()).toBe(MANOEUVRE_FLEE);
    const fledAt = t;
    let warp: { x: number; y: number } | undefined;
    for (; t <= fledAt + FLEE_MAX_TICKS + 5 && warp === undefined; t++) {
      const i = b.tick(self(hp), view(t));
      if (i.warpOut) warp = { ...i.warpOut };
    }
    expect(warp, 'asked to warp out').toBeDefined();
    // Away from the enemy (it sits at +y).
    expect(warp!.y).toBeLessThan(-b.getSensorRange());
    expect(b.getWarpOutCount()).toBe(1);
    expect(b.getState()).toBe('IDLE');
    // The next tick carries no warp request.
    expect(b.tick(self(hp), view(t)).warpOut).toBeUndefined();
  });

  it('noteDamage feeds the burst trigger (20 % of max hull inside 2 s rolls)', () => {
    const { b, seen, view } = setup([], MORALE_OUTCOME.FightOn);
    b.noteDamage(0.25 * K.maxHealth, 1);
    for (let t = 1; t <= 30; t++) b.tick(self(0.9 * K.maxHealth), view(t));
    expect(seen.length).toBe(1);
    expect(seen[0]!.recentDamageRate).toBeCloseTo(0.25, 5);
  });

  it('noteCapitalLost rolls at the next decision', () => {
    const { b, seen, view } = setup([], MORALE_OUTCOME.FightOn);
    b.noteCapitalLost();
    for (let t = 1; t <= 30; t++) b.tick(self(K.maxHealth), view(t));
    expect(seen.length).toBe(1);
  });
});
