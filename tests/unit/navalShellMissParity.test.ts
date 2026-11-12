/**
 * Two-sided contract (#15): a naval shell that misses ends without a burst on
 * BOTH sides.
 *
 * Owner's rule (2026-11-10): heavy shells "hit anything in-between if it's
 * there, but only explode on target". The server (`ProjectilePipeline`) lets a
 * shell that reaches the end of its flight EXPIRE: no `onShellEnd`, no
 * `onBlast`, no splash. The client bursts a naval shell only on a `shell_end`
 * (shells as events, slice 4: `NavalShellBursts`), so it draws nothing for
 * that shell. This flies every naval gun's shell to expiry on the real server
 * pipeline and feeds what the server reported into the real client burster.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline } from '../../src/server/rooms/ProjectilePipeline.js';
import { getWeapon, type WeaponId } from '../../src/core/combat/WeaponCatalogue.js';
import { NavalShellBursts } from '../../src/client/render/art/fx/navalShellBursts.js';

const NAVAL: readonly WeaponId[] = ['naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege'];

describe('naval shell miss: server and client agree', () => {
  for (const id of NAVAL) {
    it(`${id}: a miss expires silently, and the client bursts nothing`, () => {
      const w = getWeapon(id);
      if (w.mode !== 'projectile') throw new Error(`${id} is not a projectile weapon`);
      let tick = 0;
      const blasts: number[] = [];
      const hits: string[] = [];
      const ends: number[] = [];
      let expired = 0;
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
        onShellEnd: (_id, _t, x, y, r) => { ends.push(x, y, r); },
        onShellExpire: () => { expired++; },
      });
      pipe.spawn('gun', 0, 0, w.speed, 0, 100, w.radius, w.maxTicks, id);
      for (let i = 0; i < w.maxTicks + 5 && pipe.size() > 0; i++) {
        pipe.advance();
        tick++;
      }
      let drawn = 0;
      new NavalShellBursts().frame({ spawn: (): boolean => { drawn++; return true; } }, 0, ends);
      expect(pipe.size()).toBe(0);
      expect(expired).toBe(1);
      expect(ends).toEqual([]);
      expect(blasts).toEqual([]);
      expect(hits).toEqual([]);
      expect(drawn).toBe(0);
    });
  }
});
