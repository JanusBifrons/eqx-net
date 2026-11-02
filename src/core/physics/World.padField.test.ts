/**
 * v4 T2 — a teleporter pad's closing push in the physics world. The server
 * worker and the client's prediction world run this same code from the same
 * pad phase, so the push is identical on both sides (#15).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';

const HALF = 320;

async function straddler(x: number): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnShip('ship', x, 0, 'fighter');
  return w;
}

function runTicks(w: PhysicsWorld, n: number): void {
  for (let i = 0; i < n; i++) w.tick(1 / 60);
}

describe('PhysicsWorld — pad field (closing iris push)', () => {
  it('pushes a ship straddling the edge on the pad side further in', async () => {
    const w = await straddler(HALF - 10);
    w.setPadField('pad', 0, 0, HALF, true);
    runTicks(w, 60);
    expect(w.getAllShipStates().get('ship')!.x).toBeLessThan(HALF - 10 - 5);
  });

  it('pushes a ship straddling the edge from outside further out', async () => {
    const w = await straddler(HALF + 10);
    w.setPadField('pad', 0, 0, HALF, true);
    runTicks(w, 60);
    expect(w.getAllShipStates().get('ship')!.x).toBeGreaterThan(HALF + 10 + 5);
  });

  it('does nothing while inactive, or once removed', async () => {
    const w = await straddler(HALF - 10);
    w.setPadField('pad', 0, 0, HALF, false);
    runTicks(w, 30);
    expect(w.getAllShipStates().get('ship')!.x).toBeCloseTo(HALF - 10, 3);
    w.setPadField('pad', 0, 0, HALF, true);
    w.removePadField('pad');
    runTicks(w, 30);
    expect(w.getAllShipStates().get('ship')!.x).toBeCloseTo(HALF - 10, 3);
  });

  it('two worlds given the same field and ship end in the same place (parity)', async () => {
    const a = await straddler(HALF - 5);
    const b = await straddler(HALF - 5);
    a.setPadField('pad', 0, 0, HALF, true);
    b.setPadField('pad', 0, 0, HALF, true);
    runTicks(a, 90);
    runTicks(b, 90);
    expect(a.getAllShipStates().get('ship')!.x).toBe(b.getAllShipStates().get('ship')!.x);
  });
});
