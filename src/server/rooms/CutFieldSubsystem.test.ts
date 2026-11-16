import { describe, expect, it } from 'vitest';
import type { GameClock } from '../../core/clock/GameClock.js';
import { FIELD_WAKES_PER_TICK } from '../../core/terrain/chunkStreamer.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import { CutFieldSubsystem } from './CutFieldSubsystem.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

function setup(recs: Record<string, Partial<SwarmEntityRecord>>) {
  const posted: WorkerCmd[] = [];
  const clock = { now: () => 0, every: () => ({ cancel: () => {} }) } as unknown as GameClock;
  const registry = { get: (id: string) => (recs[id] as SwarmEntityRecord | undefined) ?? null, all: () => [] } as unknown as SwarmEntityRegistry;
  const sub = new CutFieldSubsystem('t', clock, registry, {} as SwarmSpawner, {
    shipSlots: () => [], sab: () => new Float32Array(0), post: (c) => posted.push(c), evict: () => {},
  });
  return { sub, posted };
}

describe('CutFieldSubsystem.wakeRock (a mining laser waking a field rock)', () => {
  it('wakes a sleeping field rock once and unfixes its body', () => {
    const recs: Record<string, Partial<SwarmEntityRecord>> = { r: { fieldRock: true } };
    const { sub, posted } = setup(recs);
    expect(sub.wakeRock('r', 'laser', 1)).toBe(true);
    expect(recs['r']!.fieldAwake).toBe(true);
    expect(sub.wakeRock('r', 'laser', 1)).toBe(true);
    expect(posted).toEqual([{ type: 'UNFIX_BODY', entityId: 'r' }]);
  });

  it('refuses anything that is not a field rock', () => {
    const { sub, posted } = setup({ a: {} });
    expect(sub.wakeRock('a', 'laser', 1)).toBe(false);
    expect(sub.wakeRock('missing', 'laser', 1)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('shares the per-tick wake cap, and the next tick wakes again', () => {
    const recs: Record<string, Partial<SwarmEntityRecord>> = {};
    for (let i = 0; i <= FIELD_WAKES_PER_TICK; i++) recs[`r${i}`] = { fieldRock: true };
    const { sub } = setup(recs);
    for (let i = 0; i < FIELD_WAKES_PER_TICK; i++) expect(sub.wakeRock(`r${i}`, 'laser', 5)).toBe(true);
    expect(sub.wakeRock(`r${FIELD_WAKES_PER_TICK}`, 'laser', 5)).toBe(false);
    expect(sub.wakeRock(`r${FIELD_WAKES_PER_TICK}`, 'laser', 6)).toBe(true);
  });
});
