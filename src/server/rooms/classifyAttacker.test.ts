import { describe, it, expect } from 'vitest';
import { classifyAttacker } from './classifyAttacker.js';
import { SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';

/** A rock or wreck piece that rams something to death is not a player: the
 *  2026-11-21 log showed `belt:…-asteroid-N` paid an elite bounty and looked
 *  up as a structure owner. Classified by registry kind, never by id prefix. */
describe('classifyAttacker', () => {
  const kinds = new Map<string, number>([
    ['belt:1-0-asteroid-3', 0],
    ['wreck-27-4', 4],
    ['drone-x', SWARM_KIND_DRONE],
    ['struct-x', SWARM_KIND_STRUCTURE],
  ]);
  const swarm = { get: (id: string) => (kinds.has(id) ? { kind: kinds.get(id)! } : undefined) } as never;

  it('a registry rock or wreck piece is environment', () => {
    expect(classifyAttacker('belt:1-0-asteroid-3', swarm)).toBe('environment');
    expect(classifyAttacker('wreck-27-4', swarm)).toBe('environment');
  });
  it('an unknown id is still a player; prefixes keep their class', () => {
    expect(classifyAttacker('player-1', swarm)).toBe('player');
    expect(classifyAttacker('pstruct-1', swarm)).toBe('structure');
    expect(classifyAttacker('swarm-9', swarm)).toBe('drone');
    expect(classifyAttacker(undefined, swarm)).toBeUndefined();
  });
  it('drone and structure registry records are not reclassified', () => {
    expect(classifyAttacker('drone-x', swarm)).toBe('player');
    expect(classifyAttacker('struct-x', swarm)).toBe('player');
  });
  it('without a registry, behaves as before', () => {
    expect(classifyAttacker('belt:1-0-asteroid-3')).toBe('player');
  });
});
