/**
 * Allegiances P0 (plan peppy-jumping-pinwheel) — AI bolts skip same-allegiance
 * swarm combatants (no drone-on-drone friendly fire), but still hit an enemy
 * allegiance and players. This is a deliberate behaviour change: pre-P0 a
 * drone bolt detonated on ANY swarm entity except its owner.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline } from './ProjectilePipeline.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';

function makePipeline(swarm: Array<{ id: string; slot: number; x: number; y: number; shipKind: string }>) {
  const sab = new Float32Array(4096);
  for (const s of swarm) {
    const b = slotBase(s.slot);
    sab[b + SLOT_X_OFF] = s.x;
    sab[b + SLOT_Y_OFF] = s.y;
  }
  const hits: Array<{ target: string; shooter: string }> = [];
  const owners = new Map(swarm.map((s) => [s.id, s.shipKind]));
  const pipe = new ProjectilePipeline({
    sabF32: sab,
    serverTick: () => 0,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerSweep: () => null,
    swarmRegistry: {
      all: () => swarm.map((s) => ({ id: s.id, slot: s.slot, radius: 12, kind: 1, shipKind: s.shipKind })),
    },
    lingeringSlots: new Map(),
    applyDamage: (target, shooter) => { hits.push({ target, shooter }); },
    ownerAllegianceOf: (id) => {
      const k = owners.get(id);
      return k === undefined ? undefined : (k.startsWith('robot') ? 'robots' : 'drones');
    },
  });
  return { pipe, hits };
}

function fly(pipe: ProjectilePipeline, ticks: number): void {
  for (let i = 0; i < ticks; i++) pipe.advance();
}

describe('ProjectilePipeline — allegiance friendly fire (P0)', () => {
  it('a drone bolt passes through a fellow drone and hits the robot behind it', () => {
    const { pipe, hits } = makePipeline([
      { id: 'd-shooter', slot: 0, x: 0, y: 0, shipKind: 'fighter' },
      { id: 'd-ally', slot: 1, x: 100, y: 0, shipKind: 'fighter' },
      { id: 'r-enemy', slot: 2, x: 200, y: 0, shipKind: 'robot-square' },
    ]);
    pipe.spawn('d-shooter', 20, 0, 1200, 0, 10, 4, 120, 'laser');
    fly(pipe, 30);
    expect(hits).toEqual([{ target: 'r-enemy', shooter: 'd-shooter' }]);
  });

  it('a robot bolt still hits a drone in its path', () => {
    const { pipe, hits } = makePipeline([
      { id: 'r-shooter', slot: 0, x: 0, y: 0, shipKind: 'robot-square' },
      { id: 'd-target', slot: 1, x: 100, y: 0, shipKind: 'fighter' },
    ]);
    pipe.spawn('r-shooter', 20, 0, 1200, 0, 10, 4, 120, 'laser');
    fly(pipe, 30);
    expect(hits).toEqual([{ target: 'd-target', shooter: 'r-shooter' }]);
  });

  it('a player bolt (no owner allegiance) hits the first swarm ship as before', () => {
    const { pipe, hits } = makePipeline([
      { id: 'd-a', slot: 1, x: 100, y: 0, shipKind: 'fighter' },
      { id: 'd-b', slot: 2, x: 200, y: 0, shipKind: 'fighter' },
    ]);
    pipe.spawn('player-1', 20, 0, 1200, 0, 10, 4, 120, 'laser');
    fly(pipe, 30);
    expect(hits).toEqual([{ target: 'd-a', shooter: 'player-1' }]);
  });
});
