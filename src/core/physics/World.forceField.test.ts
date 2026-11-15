/**
 * Force fields in the physics world (`setForceField` / `removeForceField`).
 * The `pad` kind is v4 T2's teleporter closing push. The server worker and
 * the client's prediction world run this same code from the same pad phase,
 * so the push is identical on both sides (#15).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { FORCE_FIELD_MASS_SCALED, type PadForceField } from './forceFields.js';

const HALF = 320;

function pad(active: boolean, half = HALF): PadForceField {
  return { kind: 'pad', cx: 0, cy: 0, half, active };
}

async function straddler(x: number, y = 0, kind: 'fighter' | 'corvette' = 'fighter'): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnShip('ship', x, y, kind);
  return w;
}

function runTicks(w: PhysicsWorld, n: number): void {
  for (let i = 0; i < n; i++) w.tick(1 / 60);
}

describe('PhysicsWorld — pad force field (closing iris push)', () => {
  it('pushes a ship straddling the edge on the pad side further in', async () => {
    const w = await straddler(HALF - 10);
    w.setForceField('pad', pad(true));
    runTicks(w, 60);
    expect(w.getAllShipStates().get('ship')!.x).toBeLessThan(HALF - 10 - 5);
  });

  it('pushes a ship straddling the edge from outside further out', async () => {
    const w = await straddler(HALF + 10);
    w.setForceField('pad', pad(true));
    runTicks(w, 60);
    expect(w.getAllShipStates().get('ship')!.x).toBeGreaterThan(HALF + 10 + 5);
  });

  it('does nothing while inactive, or once removed', async () => {
    const w = await straddler(HALF - 10);
    w.setForceField('pad', pad(false));
    runTicks(w, 30);
    expect(w.getAllShipStates().get('ship')!.x).toBeCloseTo(HALF - 10, 3);
    w.setForceField('pad', pad(true));
    w.removeForceField('pad');
    runTicks(w, 30);
    expect(w.getAllShipStates().get('ship')!.x).toBeCloseTo(HALF - 10, 3);
  });

  it('copies the field: a caller may reuse (and mutate) one scratch object', async () => {
    const w = await straddler(HALF - 10);
    const scratch = pad(false);
    w.setForceField('pad', scratch);
    scratch.active = true; // not re-set: the world must not see this
    runTicks(w, 30);
    expect(w.getAllShipStates().get('ship')!.x).toBeCloseTo(HALF - 10, 3);
    w.setForceField('pad', scratch); // re-set: now active
    runTicks(w, 30);
    expect(w.getAllShipStates().get('ship')!.x).toBeLessThan(HALF - 10 - 1);
  });

  it('two worlds given the same field and ship end in the same place (parity)', async () => {
    const a = await straddler(HALF - 5);
    const b = await straddler(HALF - 5);
    a.setForceField('pad', pad(true));
    b.setForceField('pad', pad(true));
    runTicks(a, 90);
    runTicks(b, 90);
    expect(a.getAllShipStates().get('ship')!.x).toBe(b.getAllShipStates().get('ship')!.x);
  });

  it('pads are mass-scaled (fixed acceleration, every mass moves alike)', () => {
    expect(FORCE_FIELD_MASS_SCALED.pad).toBe(true);
  });

  // Exact pose and velocity after 60 steps, recorded from the pre-refactor
  // `setPadField` code (impulse = mass × PAD_PUSH_ACCEL × FIXED_DT). The
  // force-field list must reproduce them bit for bit.
  it.each([
    ['fighter', 310, 0, 291.6258544921875, 0, -22.988515853881836, 0],
    ['fighter', 330, 0, 348.3741455078125, 0, 22.988515853881836, 0],
    ['fighter', 0, -315, 0, -296.6258544921875, 0, 22.988515853881836],
    ['corvette', 300, 290, 285.5692138671875, 286.056640625, -5.870072364807129, -17.11844253540039],
  ] as const)('matches the old pad push exactly: %s at (%d, %d)', async (kind, x, y, ex, ey, evx, evy) => {
    const w = await straddler(x, y, kind);
    w.setForceField('pad', pad(true));
    runTicks(w, 60);
    const s = w.getAllShipStates().get('ship')!;
    expect([s.x, s.y, s.vx, s.vy]).toEqual([ex, ey, evx, evy]);
  });
});
