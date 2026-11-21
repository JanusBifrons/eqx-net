import { describe, it, expect } from 'vitest';
import { RecentCommands, RECENT_COMMANDS, worldFailedMsg } from './worldFailure.js';
import type { WorkerCommand } from './workerCommands.js';

const cmd = (c: Record<string, unknown>): WorkerCommand => c as unknown as WorkerCommand;

describe('RecentCommands', () => {
  it('keeps the latest commands oldest first, skipping per-tick inputs', () => {
    const r = new RecentCommands();
    r.note(cmd({ type: 'SPAWN', playerId: 'p1' }));
    r.note(cmd({ type: 'INPUT', playerId: 'p1' }));
    r.note(cmd({ type: 'AI_INPUTS' }));
    r.note(cmd({ type: 'SPAWN_OBSTACLE', obstacleId: 'rock-1' }));
    r.note(cmd({ type: 'CLOCK_RATE' }));
    expect(r.dump()).toEqual(['SPAWN p1', 'SPAWN_OBSTACLE rock-1', 'CLOCK_RATE']);
  });
  it('wraps at RECENT_COMMANDS', () => {
    const r = new RecentCommands();
    for (let i = 0; i < RECENT_COMMANDS + 5; i++) r.note(cmd({ type: 'DESPAWN', entityId: `e${i}` }));
    const d = r.dump();
    expect(d.length).toBe(RECENT_COMMANDS);
    expect(d[0]).toBe('DESPAWN e5');
    expect(d[d.length - 1]).toBe(`DESPAWN e${RECENT_COMMANDS + 4}`);
  });
  it('builds a WORLD_FAILED message', () => {
    const r = new RecentCommands();
    r.note(cmd({ type: 'SPAWN', playerId: 'p1' }));
    const m = worldFailedMsg(3, 'step', new Error('unreachable'), 99, r);
    expect(m).toMatchObject({ type: 'WORLD_FAILED', worldId: 3, phase: 'step', errMessage: 'unreachable', tick: 99, recent: ['SPAWN p1'] });
  });
});
