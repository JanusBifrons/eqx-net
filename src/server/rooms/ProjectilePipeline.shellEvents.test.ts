/**
 * Shells as events, slice 1 (docs/architecture/shell-events.md §2): with
 * events on (always, since slice 4), a naval shell is quantised at spawn, follows the closed
 * form `shellPoseAt` keyed on the WORKER tick (not on how many room updates
 * ran), and reports its spawn / hit / wall / miss through the hooks.
 *
 * Why the closed form: the room calls `advance()` once per update, but
 * `serverTick` is the physics worker's counter read from the SAB, which can
 * skip a tick or repeat one when the two drift. The old Euler step moved a
 * shell once per update while its lifetime counted worker ticks, so the
 * server's shell slid off `shellPoseAt`, which the client will draw from.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline, type ProjectileRecord } from './ProjectilePipeline.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { quantiseShellSpawn, shellPathEndTick, shellPoseAt } from '../../core/combat/shellFlight.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';

interface Ent { id: string; slot: number; x: number; y: number }

function harness(ents: Ent[], wallAtX?: number) {
  const sab = new Float32Array(8192);
  for (const e of ents) {
    const b = slotBase(e.slot);
    sab[b + SLOT_X_OFF] = e.x;
    sab[b + SLOT_Y_OFF] = e.y;
  }
  const clock = { tick: 500 };
  const log: string[] = [];
  const ends: Array<{ id: string; tick: number; x: number; y: number; r: number }> = [];
  const hits: Array<{ target: string; x?: number; y?: number }> = [];
  const pipe = new ProjectilePipeline({
    sabF32: sab,
    serverTick: () => clock.tick,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerSweep: () => null,
    swarmRegistry: { all: () => ents.map((e) => ({ id: e.id, slot: e.slot, radius: 12, kind: 1, shipKind: 'fighter' })) },
    lingeringSlots: new Map(),
    applyDamage: (target, _s, _d, x, y) => { hits.push({ target, x, y }); },
    wallBlocksProjectile: wallAtX === undefined ? undefined : (x, _y, sx) => x < wallAtX && x + sx >= wallAtX,
    onShellSpawn: (id) => { log.push(`spawn ${id}`); },
    onShellEnd: (id, tick, x, y, r) => { log.push(`end ${id}`); ends.push({ id, tick, x, y, r }); },
    onShellExpire: (id) => { log.push(`expire ${id}`); },
  });
  return { pipe, clock, log, ends, hits };
}

const only = (p: ProjectilePipeline): ProjectileRecord => p.liveProjectiles.values().next().value!;

describe('ProjectilePipeline — event shells (shell-events slice 1)', () => {
  it('quantises a naval shell at spawn and stamps its origin; a bolt is untouched', () => {
    const { pipe, log } = harness([]);
    pipe.spawn('gun', 10.04, -3.06, 1234.5678, -9.8765, 100, 4, 300, 'naval_xl');
    const r = only(pipe);
    const q = { x: 0, y: 0, vx: 0, vy: 0 };
    quantiseShellSpawn(10.04, -3.06, 1234.5678, -9.8765, q);
    expect([r.x, r.y, r.vx, r.vy]).toEqual([q.x, q.y, q.vx, q.vy]);
    expect([r.ox, r.oy]).toEqual([q.x, q.y]);
    expect(log).toEqual(['spawn proj-0']);
    pipe.spawn('gun', 10.04, -3.06, 1234.5678, 0, 10, 2, 60, 'laser');
    const bolt = [...pipe.liveProjectiles.values()][1]!;
    expect(bolt.x).toBe(10.04);
    expect(bolt.ox).toBeUndefined();
    expect(log).toHaveLength(1);
  });

  it('follows shellPoseAt on the WORKER tick when updates skip and repeat ticks', () => {
    const { pipe, clock } = harness([]);
    const fireTick = clock.tick;
    pipe.spawn('gun', 0, 0, 1900, 700, 100, 4, 400, 'naval_xl');
    const r = only(pipe);
    const want = { x: 0, y: 0 };
    // Room updates vs worker ticks: +1, +2 (a skipped tick), +0 (a repeat), +1, +3.
    for (const dt of [1, 2, 0, 1, 3, 1, 1, 2]) {
      pipe.advance();
      shellPoseAt(r.ox!, r.oy!, r.vx, r.vy, fireTick, clock.tick + 1, want);
      expect(Math.abs(r.x - want.x)).toBeLessThan(1e-6);
      expect(Math.abs(r.y - want.y)).toBeLessThan(1e-6);
      clock.tick += dt;
    }
  });

  it('a hit reports its tick, point and blast radius; a plain shell has radius 0', () => {
    const { pipe, clock, ends, hits } = harness([{ id: 'target', slot: 1, x: 300, y: 0 }]);
    pipe.spawn('gun', 0, 0, 1900, 0, 100, 4, 400, 'naval_xl');
    for (let i = 0; i < 20 && pipe.size() > 0; i++) { pipe.advance(); clock.tick++; }
    expect(ends).toHaveLength(1);
    expect(ends[0]!.r).toBe(0);
    expect(ends[0]!.x).toBe(hits[0]!.x);
    expect(ends[0]!.y).toBe(hits[0]!.y);
    // Contact at 300 − 12 − 4 = 284 u. The advance at tick 500 + k sweeps
    // steps k → k + 1 (31.67 u each), so step 8 → 9 reaches it: tick 508.
    expect(ends[0]!.tick).toBe(508);

    const siege = harness([{ id: 'target', slot: 1, x: 300, y: 0 }]);
    siege.pipe.spawn('gun', 0, 0, 1900, 0, 100, 4, 400, 'naval_siege');
    for (let i = 0; i < 20 && siege.pipe.size() > 0; i++) { siege.pipe.advance(); siege.clock.tick++; }
    const w = getWeapon('naval_siege');
    expect(siege.ends[0]!.r).toBe(w.mode === 'projectile' ? w.splash!.radius : -1);
  });

  it('a shield wall ends it as a hit with radius 0; a miss expires silently at shellPathEndTick', () => {
    const wall = harness([], 200);
    wall.pipe.spawn('gun', 0, 0, 1900, 0, 100, 4, 400, 'naval_xl');
    for (let i = 0; i < 20 && wall.pipe.size() > 0; i++) { wall.pipe.advance(); wall.clock.tick++; }
    expect(wall.log).toEqual(['spawn proj-0', 'end proj-0']);
    expect(wall.ends[0]!.r).toBe(0);

    const miss = harness([]);
    const fireTick = miss.clock.tick;
    miss.pipe.spawn('gun', 0, 0, 1900, 0, 100, 4, 30, 'naval_xl');
    const r = only(miss.pipe);
    let lastTick = -1;
    while (miss.pipe.size() > 0) { lastTick = miss.clock.tick; miss.pipe.advance(); miss.clock.tick++; }
    expect(miss.log).toEqual(['spawn proj-0', 'expire proj-0']);
    // Its last advance ran at t + n and swept to the pose at shellPathEndTick.
    expect(lastTick).toBe(fireTick + 30);
    const end = { x: 0, y: 0 };
    shellPoseAt(r.ox!, r.oy!, r.vx, r.vy, fireTick, shellPathEndTick(fireTick, 30), end);
    expect(r.x).toBeCloseTo(end.x, 6);
  });
});
