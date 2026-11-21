/**
 * Command speed on an owner's Move (`setTravel(x, y, speed)`): the AI pilot
 * flies the leg at no more than that fraction of the ship's own top speed
 * (Stop / ⅓ / ⅔ / Full, the Command speed telegraph). Full flies as before;
 * 0 brakes and holds short of the point, keeping the order, and a later
 * speed sends it on. Driven through the kinematic model of `applyShipInput`.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour, TRAVEL_ARRIVED, TRAVEL_ON_THE_WAY } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { HELM_SPEED_FRACTION } from '../helm/helm.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

function owned(): HostileDroneBehaviour {
  return new HostileDroneBehaviour(KIND, { side: 'players', ownerId: 'owner-1' });
}

/** Fly `ticks`; returns the top speed seen and the distance flown. */
function fly(b: HostileDroneBehaviour, self: Body, ticks: number, from = 100): { top: number } {
  const view: Mut<AiWorldView> = { players: [], swarms: [], tick: 0, dtSec: 1 / 60 };
  let top = 0;
  for (let t = from; t < from + ticks; t++) {
    view.tick = t;
    stepKinematic(self, KIND, b.tick(self, view));
    top = Math.max(top, Math.hypot(self.vx, self.vy));
  }
  return { top };
}

const body = (): Body => ({ id: 'own-1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
const FAR = 20000;

describe('HostileDroneBehaviour — Command speed on a Move', () => {
  it('a one-third Move never goes much past a third of the top speed', () => {
    const b = owned();
    const self = body();
    b.setTravel(0, FAR, HELM_SPEED_FRACTION[1]);
    const { top } = fly(b, self, 600);
    const cap = KIND.maxSpeed / 3;
    expect(top).toBeGreaterThan(cap * 0.6);
    // One thrust tap of slack over the cap (the pilot holds the keys a tick).
    expect(top).toBeLessThan(cap + KIND.thrustImpulse / 10);
  });

  it('two thirds is faster than one third, full faster still', () => {
    const tops = [1, 2, 3].map((i) => {
      const b = owned();
      b.setTravel(0, FAR, HELM_SPEED_FRACTION[i]);
      return fly(b, body(), 600).top;
    });
    expect(tops[1]!).toBeGreaterThan(tops[0]! * 1.3);
    expect(tops[2]!).toBeGreaterThanOrEqual(tops[1]!);
  });

  it('no speed = full (old clients fly as before)', () => {
    const a = owned(); a.setTravel(0, FAR);
    const c = owned(); c.setTravel(0, FAR, 1);
    expect(fly(a, body(), 400).top).toBeCloseTo(fly(c, body(), 400).top, 6);
  });

  it('Stop (0) halts in place and keeps the order; a new speed sends it on', () => {
    const b = owned();
    const self = body();
    b.setTravel(0, FAR, 1);
    fly(b, self, 240);
    expect(Math.hypot(self.vx, self.vy)).toBeGreaterThan(KIND.maxSpeed * 0.3);
    b.setTravel(0, FAR, 0);
    fly(b, self, 900, 400);
    const heldY = self.y;
    expect(Math.hypot(self.vx, self.vy), 'braked to a halt').toBeLessThan(KIND.maxSpeed * 0.05);
    fly(b, self, 300, 1400);
    expect(Math.abs(self.y - heldY), 'holds the spot').toBeLessThan(KIND.radius * 4);
    expect(b.getTravelState(), 'still under orders').toBe(TRAVEL_ON_THE_WAY);
    b.setTravel(0, FAR, HELM_SPEED_FRACTION[2]);
    fly(b, self, 300, 1800);
    expect(self.y).toBeGreaterThan(heldY + KIND.radius * 4);
    expect(b.getTravelState()).not.toBe(TRAVEL_ARRIVED);
  });
});
