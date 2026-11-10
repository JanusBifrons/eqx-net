/**
 * Friendly fire (owner decision 2026-11-10: "Fire hits all"). A bolt hits the
 * FIRST thing in its path, the shooter's own side included. Replaces the
 * allegiances-P0 rule 6 lock, where an AI bolt passed through ships of its own
 * allegiance. The one skip left is physical: a bolt never hits its shooter.
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
  });
  return { pipe, hits };
}

function fly(pipe: ProjectilePipeline, ticks: number): void {
  for (let i = 0; i < ticks; i++) pipe.advance();
}

describe('ProjectilePipeline — friendly fire', () => {
  it('a drone bolt hits the fellow drone in its path, not the robot behind it', () => {
    const { pipe, hits } = makePipeline([
      { id: 'd-shooter', slot: 0, x: 0, y: 0, shipKind: 'fighter' },
      { id: 'd-ally', slot: 1, x: 100, y: 0, shipKind: 'fighter' },
      { id: 'r-enemy', slot: 2, x: 200, y: 0, shipKind: 'robot-square' },
    ]);
    pipe.spawn('d-shooter', 20, 0, 1200, 0, 10, 4, 120, 'laser');
    fly(pipe, 30);
    expect(hits).toEqual([{ target: 'd-ally', shooter: 'd-shooter' }]);
  });

  it('a bolt never hits its own shooter', () => {
    const { pipe, hits } = makePipeline([
      { id: 'd-shooter', slot: 0, x: 0, y: 0, shipKind: 'fighter' },
      { id: 'r-enemy', slot: 1, x: 100, y: 0, shipKind: 'robot-square' },
    ]);
    // Spawned inside its own shooter's circle.
    pipe.spawn('d-shooter', 0, 0, 1200, 0, 10, 4, 120, 'laser');
    fly(pipe, 30);
    expect(hits).toEqual([{ target: 'r-enemy', shooter: 'd-shooter' }]);
  });

  it('a player bolt hits the first swarm ship as before', () => {
    const { pipe, hits } = makePipeline([
      { id: 'd-a', slot: 1, x: 100, y: 0, shipKind: 'fighter' },
      { id: 'd-b', slot: 2, x: 200, y: 0, shipKind: 'fighter' },
    ]);
    pipe.spawn('player-1', 20, 0, 1200, 0, 10, 4, 120, 'laser');
    fly(pipe, 30);
    expect(hits).toEqual([{ target: 'd-a', shooter: 'player-1' }]);
  });
});
