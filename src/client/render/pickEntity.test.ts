/**
 * Unit lock for `pickEntityAt` (structures follow-up Item B1, invariant #13).
 *
 * The pick is the entry point for click-to-inspect: tap a world point, get the
 * nearest selectable entity (or null). These cases assert the load-bearing
 * rules from the handoff:
 *   - tap inside a drone → that drone (`swarm-<id>`)
 *   - tap on the OWN active ship → null (excluded via the localPlayerId key)
 *   - empty space → null
 *   - overlapping candidates → the NEAREST centre wins
 *   - asteroids (kind 0) ARE selectable (WS-9/R2.23)
 *   - structures (kind 2) ARE selectable
 *   - wrecks ARE selectable
 *   - lingering hulls ARE selectable (WS-9/R2.23, by shipInstanceId)
 */
import { describe, it, expect } from 'vitest';
import type {
  RenderMirror,
  ShipRenderState,
  SwarmRenderState,
  WreckRenderState,
} from '@core/contracts/IRenderer';
import { pickEntityAt } from './pickEntity.js';

function ship(x: number, y: number, kind = 'fighter'): ShipRenderState {
  return { x, y, angle: 0, vx: 0, vy: 0, kind };
}

function swarm(x: number, y: number, kind: number, radius = 30): SwarmRenderState {
  // Only the fields pickEntityAt reads are populated; the rest are filler.
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0, radius, kind, sleeping: false, lastUpdateTick: 0,
  } as SwarmRenderState;
}

function wreck(x: number, y: number, kind = 'fighter'): WreckRenderState {
  return { shipInstanceId: '', x, y, vx: 0, vy: 0, angle: 0, angvel: 0, kind, health: 50, maxHealth: 100 };
}

function lingering(x: number, y: number, ownerPlayerId: string, kind = 'fighter'): ShipRenderState & { ownerPlayerId: string } {
  return { x, y, angle: 0, vx: 0, vy: 0, kind, ownerPlayerId };
}

function mirror(over: Partial<RenderMirror>): RenderMirror {
  return {
    ships: new Map(),
    swarm: new Map(),
    wrecks: new Map(),
    localPlayerId: null,
    ...over,
  } as RenderMirror;
}

describe('pickEntityAt', () => {
  it('tap inside a drone selects that drone', () => {
    const m = mirror({ swarm: new Map([[42, swarm(100, 100, 1, 30)]]) });
    const hit = pickEntityAt(105, 95, m);
    expect(hit).toEqual({ id: 'swarm-42', kind: 'drone' });
  });

  it('tap on the OWN active ship returns null (own ship excluded)', () => {
    const m = mirror({
      ships: new Map([['me', ship(0, 0)]]),
      localPlayerId: 'me',
    });
    // Dead-centre on the own ship — still not selectable.
    const hit = pickEntityAt(0, 0, m);
    expect(hit).toBeNull();
  });

  it('tap on a REMOTE ship selects it (only the own ship is excluded)', () => {
    const m = mirror({
      ships: new Map([
        ['me', ship(0, 0)],
        ['them', ship(500, 0)],
      ]),
      localPlayerId: 'me',
    });
    const hit = pickEntityAt(503, 2, m);
    expect(hit).toEqual({ id: 'them', kind: 'ship' });
  });

  it('empty space returns null', () => {
    const m = mirror({ swarm: new Map([[1, swarm(0, 0, 1, 20)]]) });
    const hit = pickEntityAt(10_000, 10_000, m);
    expect(hit).toBeNull();
  });

  it('overlapping candidates return the nearest centre', () => {
    // Two drones whose hit-discs both contain the tap; the closer centre wins.
    const m = mirror({
      swarm: new Map([
        [1, swarm(100, 100, 1, 60)], // centre 0 units from tap below
        [2, swarm(140, 100, 1, 60)], // centre 40 units from tap
      ]),
    });
    const hit = pickEntityAt(100, 100, m);
    expect(hit).toEqual({ id: 'swarm-1', kind: 'drone' });
  });

  it('asteroids (kind 0) ARE selectable (WS-9/R2.23)', () => {
    const m = mirror({ swarm: new Map([[7, swarm(0, 0, 0, 50)]]) });
    const hit = pickEntityAt(0, 0, m);
    expect(hit).toEqual({ id: 'swarm-7', kind: 'asteroid' });
  });

  it('lingering hulls ARE selectable by shipInstanceId (WS-9/R2.23)', () => {
    const m = mirror({
      lingeringShips: new Map([['linger-xyz', lingering(300, 300, 'owner-1')]]),
    });
    const hit = pickEntityAt(302, 298, m);
    expect(hit).toEqual({ id: 'linger-xyz', kind: 'lingering' });
  });

  it('a closer drone beats a lingering hull across buckets', () => {
    const m = mirror({
      swarm: new Map([[1, swarm(10, 0, 1, 40)]]), // drone centre 10 from origin
      lingeringShips: new Map([['linger-far', lingering(100, 0, 'owner-2')]]), // 100 away
    });
    const hit = pickEntityAt(0, 0, m);
    expect(hit).toEqual({ id: 'swarm-1', kind: 'drone' });
  });

  it('structures (kind 2) ARE selectable', () => {
    const m = mirror({ swarm: new Map([[9, swarm(0, 0, 2, 50)]]) });
    const hit = pickEntityAt(0, 0, m);
    expect(hit).toEqual({ id: 'swarm-9', kind: 'structure' });
  });

  it('wrecks ARE selectable (by shipInstanceId)', () => {
    const w = wreck(200, 200);
    w.shipInstanceId = 'wreck-abc';
    const m = mirror({ wrecks: new Map([['wreck-abc', w]]) });
    const hit = pickEntityAt(202, 198, m);
    expect(hit).toEqual({ id: 'wreck-abc', kind: 'wreck' });
  });

  it('a structure closer than a drone wins across buckets', () => {
    const m = mirror({
      ships: new Map(),
      swarm: new Map([
        [1, swarm(100, 0, 1, 40)], // drone, centre 100 from tap origin
        [2, swarm(10, 0, 2, 40)], // structure, centre 10 from tap origin
      ]),
    });
    const hit = pickEntityAt(0, 0, m);
    expect(hit).toEqual({ id: 'swarm-2', kind: 'structure' });
  });
});
