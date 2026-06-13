/**
 * Collision-group bit-math tests (scrap-on-death Phase 2b-i, Step A).
 *
 * Applies Rapier's two-direction collision rule to the exported constants:
 *
 *     collide(A, B) =
 *       (A.membership & B.filter) !== 0 AND (B.membership & A.filter) !== 0
 *
 * and proves SCRAP_COLLISION_GROUPS gives scrap-vs-scrap = NO collide,
 * scrap-vs-default = collide.
 */
import { describe, it, expect } from 'vitest';
import {
  SCRAP_COLLISION_GROUPS,
  DEFAULT_COLLISION_GROUPS,
} from '../../src/core/physics/collisionGroups.js';

/** Split a packed Rapier u32 into its 16-bit membership + filter halves. */
function unpack(groups: number): { membership: number; filter: number } {
  return {
    membership: (groups >>> 16) & 0xffff,
    filter: groups & 0xffff,
  };
}

/** Rapier's collision rule applied to two packed group words. */
function collide(aGroups: number, bGroups: number): boolean {
  const a = unpack(aGroups);
  const b = unpack(bGroups);
  return (a.membership & b.filter) !== 0 && (b.membership & a.filter) !== 0;
}

describe('collisionGroups constants', () => {
  it('SCRAP_COLLISION_GROUPS packs membership 0x0002, filter 0xFFFD', () => {
    expect(SCRAP_COLLISION_GROUPS).toBe(0x0002fffd);
    const { membership, filter } = unpack(SCRAP_COLLISION_GROUPS);
    expect(membership).toBe(0x0002);
    expect(filter).toBe(0xfffd);
  });

  it('DEFAULT_COLLISION_GROUPS is membership=all, filter=all', () => {
    expect(DEFAULT_COLLISION_GROUPS >>> 0).toBe(0xffffffff);
    const { membership, filter } = unpack(DEFAULT_COLLISION_GROUPS);
    expect(membership).toBe(0xffff);
    expect(filter).toBe(0xffff);
  });

  it('scrap vs scrap does NOT collide', () => {
    // (0x0002 & 0xFFFD) = 0 ⇒ first clause fails ⇒ no collision.
    expect(collide(SCRAP_COLLISION_GROUPS, SCRAP_COLLISION_GROUPS)).toBe(false);
  });

  it('scrap vs default body DOES collide (both directions)', () => {
    // (0x0002 & 0xFFFF)=0x0002 ≠ 0 AND (0xFFFF & 0xFFFD)=0xFFFD ≠ 0 ⇒ collide.
    expect(collide(SCRAP_COLLISION_GROUPS, DEFAULT_COLLISION_GROUPS)).toBe(true);
    // Symmetric — order of arguments must not matter.
    expect(collide(DEFAULT_COLLISION_GROUPS, SCRAP_COLLISION_GROUPS)).toBe(true);
  });

  it('default vs default collides (sanity — the unchanged baseline)', () => {
    expect(collide(DEFAULT_COLLISION_GROUPS, DEFAULT_COLLISION_GROUPS)).toBe(true);
  });
});
