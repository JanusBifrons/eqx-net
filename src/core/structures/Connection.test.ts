import { describe, it, expect } from 'vitest';
import { Connection, connectionLength } from './Connection.js';
import { FLASH_DURATION_MS } from './structureGridConstants.js';

describe('Connection', () => {
  it('getOtherNode returns the opposite endpoint, null for non-members', () => {
    const c = new Connection(1, 'a', 'b', 100);
    expect(c.getOtherNode('a')).toBe('b');
    expect(c.getOtherNode('b')).toBe('a');
    expect(c.getOtherNode('c')).toBeNull();
  });

  it('hasNode identifies endpoints', () => {
    const c = new Connection(2, 'a', 'b', 100);
    expect(c.hasNode('a')).toBe(true);
    expect(c.hasNode('b')).toBe(true);
    expect(c.hasNode('z')).toBe(false);
  });

  it('flash opens a window for FLASH_DURATION_MS and tags the material', () => {
    const c = new Connection(3, 'a', 'b', 100);
    expect(c.isFlashing(1000)).toBe(false);
    c.flash(1000, 'minerals');
    expect(c.flowMaterial).toBe('minerals');
    expect(c.isFlashing(1000)).toBe(true);
    expect(c.isFlashing(1000 + FLASH_DURATION_MS - 1)).toBe(true);
    expect(c.isFlashing(1000 + FLASH_DURATION_MS)).toBe(false);
  });

  it('flash accepts an explicit duration', () => {
    const c = new Connection(4, 'a', 'b', 100);
    c.flash(0, 'power', 50);
    expect(c.isFlashing(49)).toBe(true);
    expect(c.isFlashing(50)).toBe(false);
  });

  it('connectionLength is Euclidean', () => {
    expect(connectionLength({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 6);
  });
});
