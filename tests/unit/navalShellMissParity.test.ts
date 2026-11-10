/**
 * Two-sided contract (#15): a naval shell that misses ends without a burst on
 * BOTH sides.
 *
 * Owner's rule (2026-11-10): heavy shells "hit anything in-between if it's
 * there, but only explode on target". The server (`ProjectilePipeline`) drops
 * a shell that reaches the end of its flight with no `onBlast` and no splash.
 * The client has no "shell hit" event: it bursts a naval shell that vanished
 * before ~its full range and lets one that ran its full range fade
 * (`turretFx.shellEndedOnHit`, used by the naval-shell burst tracker). This
 * test flies every naval gun's shell to expiry on the real server pipeline and
 * checks the client reads the distance it covered as "ran its full range".
 * If either side's notion of full range changes, this fails.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline } from '../../src/server/rooms/ProjectilePipeline.js';
import { getWeapon, type WeaponId } from '../../src/core/combat/WeaponCatalogue.js';
import { shellEndedOnHit } from '../../src/client/render/art/fx/turretFx.js';

const NAVAL: readonly WeaponId[] = ['naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege'];

describe('naval shell miss: server and client agree', () => {
  for (const id of NAVAL) {
    it(`${id}: a miss expires silently, and the client sees full range (no burst)`, () => {
      const w = getWeapon(id);
      if (w.mode !== 'projectile') throw new Error(`${id} is not a projectile weapon`);
      let tick = 0;
      const blasts: number[] = [];
      const hits: string[] = [];
      const pipe = new ProjectilePipeline({
        sabF32: new Float32Array(1024),
        serverTick: () => tick,
        playerToSlot: [],
        getActiveShip: () => undefined,
        shipPoseCache: new Map(),
        playerSweep: () => null,
        swarmRegistry: { all: () => [] },
        lingeringSlots: new Map(),
        applyDamage: (target) => { hits.push(target); },
        onBlast: (_x, _y, r) => { blasts.push(r); },
      });
      pipe.spawn('gun', 0, 0, w.speed, 0, 100, w.radius, w.maxTicks, id);
      // The client first sees the shell at its spawn point and last sees it
      // the tick before it disappears.
      let lastSeenX = 0;
      for (let i = 0; i < w.maxTicks + 5 && pipe.size() > 0; i++) {
        for (const p of pipe.liveProjectiles.values()) lastSeenX = p.x;
        pipe.advance();
        tick++;
      }
      expect(pipe.size()).toBe(0);
      expect(blasts).toEqual([]);
      expect(hits).toEqual([]);
      const clientReach = (w.speed * w.maxTicks) / 60;
      expect(shellEndedOnHit(lastSeenX, clientReach)).toBe(false);
    });
  }
});
