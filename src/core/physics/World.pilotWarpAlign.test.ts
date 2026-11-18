/**
 * A pilot's warp-to turns the hull to face the jump before the run, whatever
 * the hull (ship parity with `World.botWarp`). A player battleship used to
 * engage after the fixed 3 s spool still ~90° off and snap round in one tick
 * (`setRotation` on engage), on the server worker and the client prediction
 * alike (both run `applyInput`).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld, type ShipInput } from './World.js';
import { WARP_SPOOL_TICKS } from './warpDrive.js';

const DT = 1 / 60;

function warpInput(x: number, y: number): ShipInput {
  return { thrust: false, turnLeft: false, turnRight: false, warpX: x, warpY: y };
}

/** Nose (-sin θ, cos θ) angle off the unit direction (dx, dy), radians. */
function offBy(angle: number, dx: number, dy: number): number {
  const want = Math.atan2(-dx, dy);
  return Math.abs(Math.atan2(Math.sin(want - angle), Math.cos(want - angle)));
}

async function flyWarp(kind: string): Promise<{ ticks: number; offAtEngage: number; maxStepTurn: number }> {
  const w = await PhysicsWorld.create();
  w.spawnShip('p', 0, 0, kind); // nose north; the target is due west
  const input = warpInput(-60_000, 0);
  let ticks = 0;
  let prev = w.getShipState('p')!.angle;
  let maxStepTurn = 0;
  while (w.warpPhase('p') !== 'cruise' && ticks < 3000) {
    w.applyInput('p', input);
    w.tick(DT);
    const a = w.getShipState('p')!.angle;
    maxStepTurn = Math.max(maxStepTurn, Math.abs(Math.atan2(Math.sin(a - prev), Math.cos(a - prev))));
    prev = a;
    ticks++;
  }
  expect(w.warpPhase('p')).toBe('cruise');
  return { ticks, offAtEngage: offBy(w.getShipState('p')!.angle, -1, 0), maxStepTurn };
}

describe('World.applyInput — a pilot warp engages only once facing the jump', () => {
  it('a player battleship keeps spooling until it faces its target: no snap round', async () => {
    const r = await flyWarp('battleship');
    expect(r.ticks, 'a longer spool than the fixed 3 s').toBeGreaterThan(WARP_SPOOL_TICKS + 30);
    expect(r.offAtEngage).toBeLessThan(0.01);
    expect(r.maxStepTurn, 'never turned more than a few degrees in one tick').toBeLessThan(0.1);
  });

  it('a fighter warps after the same 3 s spool as before', async () => {
    const r = await flyWarp('fighter');
    expect(r.ticks).toBe(WARP_SPOOL_TICKS + 1);
    expect(r.maxStepTurn).toBeLessThan(0.1);
  });
});
