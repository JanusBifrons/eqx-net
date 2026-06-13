/**
 * Unit tests for ScrapSpawner (scrap-on-death Phase 2b-ii) — the death→scrap
 * DECISION logic over hand-rolled hook mocks (no SAB / worker / registry), the
 * TransitOrchestrator testing pattern.
 */
import { describe, it, expect } from 'vitest';
import { ScrapSpawner, type ScrapSpawnSpec } from './ScrapSpawner.js';
import { shipScrapGroups } from '../../core/geometry/shipScrapGroups.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import {
  SCRAP_HP,
  SCRAP_BURST_SPEED,
  MAX_LIVE_SCRAP,
} from '../../core/swarm/scrapConstants.js';

function makeSpawner(spawnOk = true) {
  const spawned: ScrapSpawnSpec[] = [];
  const seeded: { id: string; hp: number }[] = [];
  const evicted: string[] = [];
  const spawner = new ScrapSpawner({
    spawnScrap: (spec) => {
      if (spawnOk) spawned.push(spec);
      return spawnOk;
    },
    seedHealth: (id, hp) => seeded.push({ id, hp }),
    evictScrap: (id) => evicted.push(id),
  });
  return { spawner, spawned, seeded, evicted };
}

describe('ScrapSpawner', () => {
  it('breaks a composite ship into one damageable scrap piece per component', () => {
    const { spawner, spawned, seeded } = makeSpawner();
    const pose = { x: 100, y: 200, vx: 5, vy: -3, angle: 0 };
    spawner.spawnFromDeath('havok', pose, 'scrap-A');

    const groups = shipScrapGroups('havok');
    expect(groups.length).toBe(7);
    expect(spawned).toHaveLength(7);

    spawned.forEach((s, i) => {
      expect(s.componentIndex).toBe(i);
      expect(s.id).toBe(`scrap-A-${i}`);
      expect(s.angle).toBe(pose.angle); // spawns at the dying ship's angle
      expect(s.parentShipKind).toBe('havok');
      expect(s.vertices.length).toBeGreaterThanOrEqual(3);
    });

    // Each piece spawns at a DISTINCT world position (the components don't stack).
    const keys = new Set(spawned.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)}`));
    expect(keys.size).toBe(7);

    // Every piece is seeded damageable with SCRAP_HP.
    expect(seeded).toHaveLength(7);
    seeded.forEach((s) => expect(s.hp).toBe(SCRAP_HP));
  });

  it('places each piece at its component world pose (matches shipShapeToPolygon mapping)', () => {
    const { spawner, spawned } = makeSpawner();
    // angle 0 so the rotation is identity and the offset is purely the
    // catalogue->math-up map (x*scale, -y*scale) added to the ship pose.
    spawner.spawnFromDeath('havok', { x: 100, y: 200, vx: 0, vy: 0, angle: 0 }, 's');
    const scale = shipShapeScale(getShipKind('havok'));
    const groups = shipScrapGroups('havok');
    spawned.forEach((s, i) => {
      const [cx, cy] = groups[i]!.centroid;
      expect(s.x).toBeCloseTo(100 + cx * scale, 4);
      expect(s.y).toBeCloseTo(200 + -cy * scale, 4);
    });
  });

  it('inherits the ship velocity plus a radial drift of SCRAP_BURST_SPEED', () => {
    const { spawner, spawned } = makeSpawner();
    const pose = { x: 0, y: 0, vx: 12, vy: -7, angle: 0 };
    spawner.spawnFromDeath('havok', pose, 's');
    for (const s of spawned) {
      // The burst is the velocity delta from the ship's own velocity; its
      // magnitude is SCRAP_BURST_SPEED (every Havok component is off-centre).
      const bx = s.vx - pose.vx;
      const by = s.vy - pose.vy;
      expect(Math.hypot(bx, by)).toBeCloseTo(SCRAP_BURST_SPEED, 4);
    }
  });

  it('spawns no scrap for a polygon (non-composite) kind', () => {
    const { spawner, spawned, seeded } = makeSpawner();
    spawner.spawnFromDeath('fighter', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 's');
    expect(spawned).toHaveLength(0);
    expect(seeded).toHaveLength(0);
    expect(spawner.liveCount()).toBe(0);
  });

  it('does not seed health or track a piece when the slot pool is exhausted', () => {
    const { spawner, spawned, seeded } = makeSpawner(false);
    spawner.spawnFromDeath('havok', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 's');
    expect(spawned).toHaveLength(0);
    expect(seeded).toHaveLength(0);
    expect(spawner.liveCount()).toBe(0);
  });

  it('enforces the global FIFO cap, evicting the oldest scrap first', () => {
    const { spawner, evicted } = makeSpawner();
    const perDeath = shipScrapGroups('havok').length; // 7
    const deaths = Math.ceil((MAX_LIVE_SCRAP + perDeath) / perDeath);
    for (let d = 0; d < deaths; d++) {
      spawner.spawnFromDeath('havok', { x: d, y: 0, vx: 0, vy: 0, angle: 0 }, `s${d}`);
    }
    expect(spawner.liveCount()).toBe(MAX_LIVE_SCRAP);
    expect(evicted.length).toBe(deaths * perDeath - MAX_LIVE_SCRAP);
    // FIFO: the very first piece spawned is the first evicted.
    expect(evicted[0]).toBe('s0-0');
  });

  it('notifyRemoved drops a combat-killed piece from the cap accounting', () => {
    const { spawner } = makeSpawner();
    spawner.spawnFromDeath('havok', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 's');
    expect(spawner.liveCount()).toBe(7);
    spawner.notifyRemoved('s-3');
    expect(spawner.liveCount()).toBe(6);
    spawner.notifyRemoved('does-not-exist'); // no-op
    expect(spawner.liveCount()).toBe(6);
  });
});
