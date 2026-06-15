/**
 * Phase 1 lock (Generic Entity Pipeline): the EntityKindRegistry is complete,
 * its pose-core kind bytes are unique + match the wire constants, and the
 * append-only invariants hold. Phase 4 appends 'structure' (kind byte 2) and
 * extends the first test's tag list.
 */

import { describe, it, expect } from 'vitest';
import type { EntityKindTag } from './Entity.js';
import { getEntityKind, entityKinds, entityKindByPoseCore } from './EntityKindRegistry.js';
import { SWARM_KIND_ASTEROID, SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';

const ALL_TAGS: readonly EntityKindTag[] = [
  'active-ship',
  'lingering-hull',
  'drone',
  'asteroid',
  'projectile',
  'missile',
  'structure',
  'scrap',
];

describe('EntityKindRegistry', () => {
  it('resolves every known entity-kind tag', () => {
    for (const tag of ALL_TAGS) {
      expect(getEntityKind(tag).tag).toBe(tag);
    }
  });

  it('throws on an unregistered tag (catalogue is exhaustive)', () => {
    expect(() => getEntityKind('black-hole' as EntityKindTag)).toThrow(/unregistered/);
  });

  it('pose-core kind bytes are unique and match the wire constants', () => {
    const drone = getEntityKind('drone');
    const asteroid = getEntityKind('asteroid');
    expect(drone.sync.transport).toBe('pose-core');
    expect(drone.sync.poseCoreKind).toBe(SWARM_KIND_DRONE);
    expect(asteroid.sync.poseCoreKind).toBe(SWARM_KIND_ASTEROID);
    // Reverse lookup is consistent.
    expect(entityKindByPoseCore(SWARM_KIND_DRONE)).toBe('drone');
    expect(entityKindByPoseCore(SWARM_KIND_ASTEROID)).toBe('asteroid');
    // No collisions among all registered pose-core kinds.
    const bytes = new Set<number>();
    for (const d of entityKinds()) {
      if (d.sync.transport === 'pose-core') {
        expect(d.sync.poseCoreKind).toBeDefined();
        expect(bytes.has(d.sync.poseCoreKind!)).toBe(false);
        bytes.add(d.sync.poseCoreKind!);
      }
    }
  });

  it('marks only the right kinds damageable (asteroid/projectile/missile are not)', () => {
    expect(getEntityKind('active-ship').damageable).toBe(true);
    expect(getEntityKind('lingering-hull').damageable).toBe(true);
    expect(getEntityKind('drone').damageable).toBe(true);
    expect(getEntityKind('asteroid').damageable).toBe(false);
    expect(getEntityKind('projectile').damageable).toBe(false);
    expect(getEntityKind('missile').damageable).toBe(false);
    // P4: the structure is the new pose-core damageable kind.
    expect(getEntityKind('structure').damageable).toBe(true);
    // Scrap-on-death Phase 2a: scrap is a pose-core damageable kind too.
    expect(getEntityKind('scrap').damageable).toBe(true);
  });

  it('the structure rides pose-core kind byte 2 (P4 "for free" proof)', () => {
    const structure = getEntityKind('structure');
    expect(structure.sync.transport).toBe('pose-core');
    expect(structure.sync.poseCoreKind).toBe(2);
    expect(structure.sync.interpolated).toBe(false); // static, like an asteroid
    expect(entityKindByPoseCore(2)).toBe('structure');
  });

  it('scrap rides pose-core kind byte 3 (scrap-on-death Phase 2a)', () => {
    const scrap = getEntityKind('scrap');
    expect(scrap.sync.transport).toBe('pose-core');
    expect(scrap.sync.poseCoreKind).toBe(3);
    // Phase-5 desync fix: scrap is INTERPOLATED like a drone (dynamic, pushable
    // kinematic follower), NOT static like an asteroid — the server simulates it
    // as a dynamic mass-1 body, so the client must follow that interpolated pose
    // with an unlocked body (render == collision).
    expect(scrap.sync.interpolated).toBe(true);
    expect(scrap.render.interpolated).toBe(true);
    expect(entityKindByPoseCore(3)).toBe('scrap');
    // The parent ship-kind id (`shipKind`) + the scrap-group `componentIndex`
    // must survive the per-frame mirror rebuild.
    expect(scrap.render.preservedFields).toContain('shipKind');
    expect(scrap.render.preservedFields).toContain('componentIndex');
  });

  it('every kind carries a render bucket and a preservedFields array', () => {
    for (const d of entityKinds()) {
      expect(typeof d.render.bucket).toBe('string');
      expect(d.render.bucket.length).toBeGreaterThan(0);
      expect(Array.isArray(d.render.preservedFields)).toBe(true);
    }
  });
});
