/**
 * NPC warp-to (wrap-up W2a): a bot body warps through the same spool → run →
 * drop machine as a pilot, driven by a held target (`World.botWarp`), so a
 * flagship fleet can cross a solar-system sector the way players do.
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { WARP_SPOOL_TICKS } from './warpDrive.js';

async function bot(): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnObstacle('bot', 0, 0, 24, 3);
  return w;
}

/** One server step: the warp (when it owns the body) then the physics tick. */
function step(w: PhysicsWorld, target: { x: number; y: number } | null): boolean {
  const owns = w.botWarp('bot', target);
  w.tick(1 / 60);
  return owns;
}

describe('World.botWarp', () => {
  it('spools in place, turns to face the target, runs, and drops on it', async () => {
    const w = await bot();
    const target = { x: 60_000, y: 0 };
    for (let i = 0; i < WARP_SPOOL_TICKS - 5; i++) expect(step(w, target)).toBe(true);
    expect(w.warpPhase('bot')).toBe('spool');
    const mid = w.getShipState('bot')!;
    expect(Math.hypot(mid.x, mid.y)).toBeLessThan(5); // held in place
    // Facing the target (nose = (-sin θ, cos θ) points +x ⇒ θ ≈ -π/2).
    expect(Math.abs(Math.atan2(Math.sin(mid.angle + Math.PI / 2), Math.cos(mid.angle + Math.PI / 2)))).toBeLessThan(0.1);

    let ran = false;
    for (let i = 0; i < 600 && !w.warpArrived('bot'); i++) {
      step(w, target);
      if (w.warpPhase('bot') === 'cruise') ran = true;
    }
    expect(ran).toBe(true);
    expect(w.warpArrived('bot')).toBe(true);
    const end = w.getShipState('bot')!;
    expect(Math.hypot(end.x - target.x, end.y - target.y)).toBeLessThan(50);
  });

  it('a slow-turning capital keeps spooling until it faces its target, then engages (no snap round)', async () => {
    const w = await PhysicsWorld.create();
    w.spawnShip('bot', 0, 0, 'battleship'); // nose north; the target is due west
    const target = { x: -60_000, y: 0 };
    let ticks = 0;
    while (w.warpPhase('bot') !== 'cruise' && ticks < 3000) { step(w, target); ticks++; } // 90° at the 9°/s floor ≈ 10 s
    expect(ticks).toBeGreaterThan(WARP_SPOOL_TICKS + 30); // a longer spool than a fighter's
    expect(w.warpPhase('bot')).toBe('cruise');
    // It engaged facing the target: nose (-sin θ, cos θ) ≈ (-1, 0).
    const s0 = w.getShipState('bot')!;
    expect(-Math.sin(s0.angle)).toBeLessThan(-0.99);
  });

  it('dropping the request during the spool cancels it; with no warp it never owns the body', async () => {
    const w = await bot();
    expect(w.botWarp('bot', null)).toBe(false);
    for (let i = 0; i < 30; i++) step(w, { x: 0, y: 50_000 });
    expect(w.warpPhase('bot')).toBe('spool');
    expect(step(w, null)).toBe(false);
    expect(w.warpPhase('bot')).toBe('idle');
  });
});
