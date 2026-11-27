import { describe, expect, it } from 'vitest';
import { tagSkipSwarmId } from './tagSkip.js';

describe('tagSkipSwarmId (S9 radar skip for the edge-stuck world tag)', () => {
  it('a swarm selection id names its swarm entity', () => {
    expect(tagSkipSwarmId('swarm-0')).toBe(0);
    expect(tagSkipSwarmId('swarm-1234')).toBe(1234);
  });

  it('a ship key, junk or no tag skips no swarm entity', () => {
    expect(tagSkipSwarmId('p1')).toBe(-1);
    expect(tagSkipSwarmId('swarm-')).toBe(-1);
    expect(tagSkipSwarmId('swarm-12a')).toBe(-1);
    expect(tagSkipSwarmId(null)).toBe(-1);
    expect(tagSkipSwarmId(undefined)).toBe(-1);
  });
});
