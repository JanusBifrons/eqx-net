import { describe, expect, it } from 'vitest';
import { ForceFieldSubsystem } from './ForceFieldSubsystem.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

describe('ForceFieldSubsystem', () => {
  it('tracks fields and posts SET/REMOVE_FORCE_FIELD to the worker', () => {
    const posted: WorkerCmd[] = [];
    const ff = new ForceFieldSubsystem({ post: (c) => posted.push(c) });
    const field = { kind: 'pad', cx: 1, cy: 2, half: 3, active: true } as const;
    ff.set('tpfield-7', { ...field });
    expect(ff.size).toBe(1);
    expect(ff.get('tpfield-7')).toEqual(field);
    ff.set('tpfield-7', { ...field, active: false });
    expect(ff.size).toBe(1);
    expect(ff.get('tpfield-7')?.active).toBe(false);
    ff.remove('tpfield-7');
    expect(ff.size).toBe(0);
    expect(posted).toEqual([
      { type: 'SET_FORCE_FIELD', id: 'tpfield-7', field },
      { type: 'SET_FORCE_FIELD', id: 'tpfield-7', field: { ...field, active: false } },
      { type: 'REMOVE_FORCE_FIELD', id: 'tpfield-7' },
    ]);
  });
});
