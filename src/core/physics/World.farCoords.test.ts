/**
 * Solar-system sectors (plan prancy-squishing-donut Phase 4) span ±200,000 u.
 * Physics, the SAB and the binary wire all hold positions as float32, which
 * at 200,000 u resolves 1/64 u. A ship must fly the same out there as at the
 * centre: same manoeuvre, same path relative to its start, within a few
 * float32 steps; and a pose must survive the float32 round trip.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from './World.js';

const FAR = { x: 200_000, y: -200_000 };

async function fly(x0: number, y0: number): Promise<Array<{ x: number; y: number; angle: number }>> {
  const w = await PhysicsWorld.create();
  w.spawnShip('s', x0, y0, 'fighter');
  const path: Array<{ x: number; y: number; angle: number }> = [];
  for (let t = 0; t < 600; t++) { // 10 s: thrust, turn, boost, coast
    const turnLeft = t > 120 && t < 240, boost = t > 300 && t < 360, thrust = t < 420;
    w.applyInput('s', { thrust, turnLeft, turnRight: false, boost, reverse: false });
    w.tick(1 / 60);
    const s = w.getShipState('s')!;
    path.push({ x: s.x - x0, y: s.y - y0, angle: s.angle });
  }
  w.dispose();
  return path;
}

describe('physics at solar-system distances', () => {
  it('a ship flies the same path at ±200,000 u as at the origin', async () => {
    const near = await fly(0, 0);
    const far = await fly(FAR.x, FAR.y);
    let worst = 0, worstAngle = 0;
    for (let i = 0; i < near.length; i++) {
      worst = Math.max(worst, Math.hypot(far[i]!.x - near[i]!.x, far[i]!.y - near[i]!.y));
      worstAngle = Math.max(worstAngle, Math.abs(far[i]!.angle - near[i]!.angle));
    }
    const travelled = Math.hypot(near[near.length - 1]!.x, near[near.length - 1]!.y);
    expect(travelled).toBeGreaterThan(500); // it really flew
    // Within a few float32 steps at 200,000 u (1/64 u each) after 10 s.
    expect(worst).toBeLessThan(0.5);
    expect(worstAngle).toBeLessThan(1e-3);
  });

  it('a pose survives the float32 round trip (SAB / wire) to 1/32 u', () => {
    const f32 = new Float32Array(2);
    for (const v of [199_999.987, -199_999.4, 150_000.03, 0.001]) {
      f32[0] = v;
      expect(Math.abs(f32[0]! - v)).toBeLessThan(1 / 32);
    }
  });
});
