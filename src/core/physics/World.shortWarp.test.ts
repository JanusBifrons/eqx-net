/**
 * A short warp (the picker's "near side" point, 1–3 km off) must always end.
 * Smoke test 2026-11-21: a pilot on Full helm picked a near side 3 km away;
 * the spool never ended ("Warping to … / CANCEL" for 60 s+) while the ship
 * drifted ~4 km. A ship still thrusting either overshot the point during the
 * 3 s spool, or circled a point inside its turning circle that it could never
 * face, so the align hold (`spoolHeldForAlign`) kept the spool for ever. A
 * ship that got there under its own engines (at the point, or past it along
 * the line from where the spool began) ends the warp where it is: latched, no
 * snap, no run backwards (`warpReached`, warpDrive.ts).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld, type ShipInput } from './World.js';
import { newWarpState, stepWarp, WARP_SPOOL_TICKS } from './warpDrive.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const DT = 1 / 60;
/** Plenty for any hull to come about; the bug spooled for ever. */
const BOUND = 2400;

interface Run { endedAt: number; ranCruise: boolean; maxStep: number; maxTurn: number }

async function fly(w: PhysicsWorld, id: string, step: () => void): Promise<Run> {
  let prev = w.getShipState(id)!;
  let ranCruise = false, maxStep = 0, maxTurn = 0, endedAt = -1;
  for (let t = 0; t < BOUND; t++) {
    step();
    const s = w.getShipState(id)!;
    if (w.warpPhase(id) === 'cruise') ranCruise = true;
    maxStep = Math.max(maxStep, Math.hypot(s.x - prev.x, s.y - prev.y));
    maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(s.angle - prev.angle), Math.cos(s.angle - prev.angle))));
    prev = s;
    if (w.warpArrived(id)) { endedAt = t; break; }
  }
  return { endedAt, ranCruise, maxStep, maxTurn };
}

/** A point `dist` from the ship, `deg` off its nose (nose = (-sin θ, cos θ)). */
function pointOff(w: PhysicsWorld, id: string, dist: number, deg: number): { x: number; y: number } {
  const s = w.getShipState(id)!;
  const a = s.angle + (deg * Math.PI) / 180;
  return { x: s.x - Math.sin(a) * dist, y: s.y + Math.cos(a) * dist };
}

function expectEndedInPlace(r: Run): void {
  expect(r.endedAt, 'the warp ended (no endless spool)').toBeGreaterThanOrEqual(0);
  expect(r.ranCruise, 'no warp run (it was already there)').toBe(false);
  expect(r.maxStep, 'no teleport').toBeLessThan(40);
  expect(r.maxTurn, 'no snap round').toBeLessThan(0.2);
}

describe('a short warp reached under the ship\'s own engines ends where the ship is', () => {
  const cases = [
    // [kind, boost, dist, degrees off the nose]: at speed on full helm.
    ['heavy', true, 1500, 0],       // overshoots the point during the spool
    ['destroyer', false, 1200, 60], // circles a point inside its turning circle
    ['battleship', false, 1200, 90],
    ['crossguard', true, 2000, 80],
  ] as const;
  for (const [kind, boost, dist, deg] of cases) {
    it(`${kind}${boost ? ' on boost' : ''}, full thrust, a point ${dist} u at ${deg}°: the spool ends latched, no snap`, async () => {
      const w = await PhysicsWorld.create();
      w.spawnShip('p', 0, 0, kind);
      const fly0: ShipInput = { thrust: true, boost, turnLeft: false, turnRight: false };
      for (let i = 0; i < 900; i++) { w.applyInput('p', fly0); w.tick(DT); } // up to speed
      const p = pointOff(w, 'p', dist, deg);
      const input: ShipInput = { ...fly0, warpX: p.x, warpY: p.y };
      const r = await fly(w, 'p', () => { w.applyInput('p', input); w.tick(DT); });
      expectEndedInPlace(r);
      expect(w.warpPhase('p')).toBe('idle');
      w.dispose();
    });
  }

  it('a key-flown AI pilot on boost that overshoots ends in place, not a run back', async () => {
    // A bot's align hold brakes (botWarpStep), so it never spooled for ever,
    // but it turned round and warped back to a point it had flown past.
    const w = await PhysicsWorld.create();
    w.spawnShip('bot', 0, 0, 'crossguard');
    w.setPilotKind('bot', getShipKind('crossguard'));
    const keys = { thrust: true, turnLeft: false, turnRight: false, boost: true, reverse: false };
    for (let i = 0; i < 900; i++) { w.applyAiInput('bot', keys); w.tick(DT); }
    const target = pointOff(w, 'bot', 1200, 0);
    const r = await fly(w, 'bot', () => {
      if (!w.botWarp('bot', w.warpArrived('bot') ? null : target, keys)) w.applyAiInput('bot', keys);
      w.tick(DT);
    });
    expectEndedInPlace(r);
    w.dispose();
  });
});

describe('stepWarp: where the ship is when the spool is up', () => {
  function spoolTo(endY: number): ReturnType<typeof stepWarp> {
    const s = newWarpState();
    const req = { x: 0, y: 1500 };
    stepWarp(s, req, 0, 0, DT); // the spool starts at the origin
    for (let i = 0; i < WARP_SPOOL_TICKS - 1; i++) stepWarp(s, req, 0, (endY * i) / WARP_SPOOL_TICKS, DT);
    const act = stepWarp(s, req, 0, endY, DT);
    if (act === 'arrive') { expect(s.phase).toBe('idle'); expect(s.latched).toBe(true); }
    return act;
  }
  it('past the point: over, latched, where it is', () => { expect(spoolTo(1600)).toBe('arrive'); });
  it('at the point (within one tick of the run): over, no snap', () => { expect(spoolTo(1300)).toBe('arrive'); });
  it('short of it: the run engages as before', () => { expect(spoolTo(900)).toBe('engage'); });
});
