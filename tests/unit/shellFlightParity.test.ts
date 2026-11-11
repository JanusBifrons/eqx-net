/**
 * Two-sided contract (#15), shells as events slice 0
 * (docs/architecture/shell-events.md §4): the client will draw a naval shell's
 * flight from `shellPoseAt` while the server keeps Euler-stepping it in
 * `ProjectilePipeline.advance`. This test flies every naval gun's shell, in
 * both range modes, for its full flight on the REAL pipeline from a quantised
 * spawn and checks `shellPoseAt` against every step (drift < 0.01 u). It also
 * checks that a spawn sent over the wire (JSON) reproduces the same poses on
 * the receiving side. If the pipeline's step or tick length changes, this
 * fails.
 */
import { describe, expect, it } from 'vitest';
import { DT_SEC, ProjectilePipeline } from '../../src/server/rooms/ProjectilePipeline.js';
import {
  SHELL_TICK_DT_S,
  quantiseShellSpawn,
  shellPoseAt,
  type ShellPoseMut,
  type ShellSpawnMut,
} from '../../src/core/combat/shellFlight.js';
import {
  LEGACY_NAVAL_GUN_BALLISTICS,
  navalGunBallisticsFor,
  type NavalGunId,
} from '../../src/shared-types/combat/navalGuns.js';
import type { NavalRangeMode } from '../../src/shared-types/combat/navalRange.js';

const GUNS = Object.keys(LEGACY_NAVAL_GUN_BALLISTICS) as NavalGunId[];
const MODES: NavalRangeMode[] = ['legacy', 'real'];
const DRIFT_MAX = 0.01;

function makePipeline(tickRef: { t: number }): ProjectilePipeline {
  return new ProjectilePipeline({
    sabF32: new Float32Array(1024),
    serverTick: () => tickRef.t,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerSweep: () => null,
    swarmRegistry: { all: () => [] },
    lingeringSlots: new Map(),
    applyDamage: () => {},
  });
}

describe('shellPoseAt matches the ProjectilePipeline Euler step', () => {
  it('uses the same tick length as the pipeline', () => {
    expect(SHELL_TICK_DT_S).toBe(DT_SEC);
  });

  for (const mode of MODES) {
    for (const gun of GUNS) {
      it(`${gun} (${mode}): every step of the full flight within ${DRIFT_MAX} u`, () => {
        const { speed, maxTicks } = navalGunBallisticsFor(mode)[gun];
        // An awkward bearing and a far-from-origin muzzle: worst case for
        // floating-point accumulation in the Euler sum.
        const bearing = 0.7311;
        const spawn: ShellSpawnMut = { x: 0, y: 0, vx: 0, vy: 0 };
        quantiseShellSpawn(41_234.567, -38_765.4321, Math.cos(bearing) * speed, Math.sin(bearing) * speed, spawn);

        const tick = { t: 9_000 };
        const fireTick = tick.t;
        const pipe = makePipeline(tick);
        pipe.spawn('gun', spawn.x, spawn.y, spawn.vx, spawn.vy, 100, 4, maxTicks, gun);
        const rec = pipe.liveProjectiles.values().next().value!;
        expect(rec.birthTick).toBe(fireTick);

        const pose: ShellPoseMut = { x: 0, y: 0 };
        let maxDrift = 0;
        let steps = 0;
        while (pipe.size() > 0) {
          pipe.advance();
          tick.t++;
          if (pipe.size() === 0) break;
          steps++;
          // After `steps` advances the record is at fireTick + steps.
          shellPoseAt(spawn.x, spawn.y, spawn.vx, spawn.vy, fireTick, fireTick + steps, pose);
          maxDrift = Math.max(maxDrift, Math.abs(pose.x - rec.x), Math.abs(pose.y - rec.y));
        }
        // The last committed pose is the fall point `origin + v·n/60`.
        expect(steps).toBe(maxTicks);
        expect(maxDrift).toBeLessThan(DRIFT_MAX);
      });
    }
  }
});

describe('a quantised spawn reproduces the same flight on both sides', () => {
  it('JSON round trip of the quantised spawn gives bit-identical poses', () => {
    for (const mode of MODES) {
      for (const gun of GUNS) {
        const { speed, maxTicks } = navalGunBallisticsFor(mode)[gun];
        const server: ShellSpawnMut = { x: 0, y: 0, vx: 0, vy: 0 };
        quantiseShellSpawn(-1234.5678, 98_765.4321, Math.cos(2.2) * speed, Math.sin(2.2) * speed, server);
        // What the client parses off the wire.
        const client = JSON.parse(JSON.stringify(server)) as ShellSpawnMut;
        // Re-quantising on receipt changes nothing (idempotent).
        const again: ShellSpawnMut = { x: 0, y: 0, vx: 0, vy: 0 };
        quantiseShellSpawn(client.x, client.y, client.vx, client.vy, again);
        expect(again).toEqual(server);

        const a: ShellPoseMut = { x: 0, y: 0 };
        const b: ShellPoseMut = { x: 0, y: 0 };
        for (const k of [0, 1, 17, maxTicks >> 1, maxTicks]) {
          shellPoseAt(server.x, server.y, server.vx, server.vy, 500, 500 + k, a);
          shellPoseAt(client.x, client.y, client.vx, client.vy, 500, 500 + k, b);
          expect(b.x).toBe(a.x);
          expect(b.y).toBe(a.y);
        }
      }
    }
  });
});
