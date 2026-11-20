/**
 * Structure-restyle 2d: `PhysicsWorld.stepRigs` is on the physics tick path
 * (server worker + client predWorld), so it allocates nothing (#14). Run
 * with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from './World.js';
import { rigById } from '../articulation/rigCatalogue.js';

function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('--expose-gc not set; run via pnpm test:gc');
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('PhysicsWorld.stepRigs heap delta', () => {
  it('posing rig parts with a playing clip allocates nothing', async () => {
    const w = await PhysicsWorld.create();
    const rig = rigById('sandbox-door-turret')!;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `turret-${i}`;
      ids.push(id);
      w.spawnObstacle(id, i * 400, 0, 70, 1000);
      w.lockBody(id);
      w.attachRig(id, rig);
    }
    // A clip far longer than the run, restarted each lap so every rig is
    // re-posed every call (the worst case: nothing idles).
    const lap = 60;
    const run = (n: number): void => {
      for (let t = 0; t < n; t++) {
        if (t % lap === 0) {
          for (let i = 0; i < 8; i++) w.setRigClip(ids[i]!, 'turret-deploy', t);
        }
        w.stepRigs(t + 1);
      }
    };
    run(2_000); // warm the JIT
    const before = heapUsed();
    run(10_000);
    const after = heapUsed();
    expect(after - before).toBeLessThan(200_000);
  });
});
