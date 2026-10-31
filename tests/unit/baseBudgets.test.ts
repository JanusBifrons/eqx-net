/**
 * Procedural-bases budget CONSISTENCY lock (plan: soft-leaping-truffle, PR-B).
 *
 * `src/shared-types/baseBudgets.ts` is the single source of truth every base
 * stage is locked against. This test proves the budgets are coherent with
 * EACH OTHER and with the LIVE game they must fit inside (ship catalogue,
 * speeds, sector bounds, roam ring, entity pool, viewport). If a catalogue or
 * gameplay change makes a budget impossible, this fails and forces a review —
 * the budget is redesigned, never silently widened.
 *
 * It already caught one real error: the first draft set GALAXY_BASE_MAX_SIZE
 * to 5000, which straddles the roaming squads' radius-2000 ring.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_CHUNK_SIZE,
  BASE_LOD_ZOOM,
  CORRIDOR_RADIUS_MULTIPLE,
  GALAXY_BASE_MAX_SIZE,
  MAX_BASE_JOIN_BYTES,
  MAX_CLIENT_ACTIVE_PIECES,
  MAX_LAYOUT_BYTES_PER_BASE,
  MAX_PIECES_PER_BASE,
  MAX_PIECES_PER_CHUNK,
  MAX_PIECES_PER_SECTOR,
  MAX_TIER_B_PER_BASE,
  MAX_TIER_B_PER_SECTOR,
  MAX_VISIBLE_CHUNKS,
  MIN_CORRIDOR_WIDTH,
  MIN_WALL_THICKNESS,
  PREDWORLD_ACTIVE_RADIUS,
  ROAM_RING_KEEPOUT_MARGIN,
  SHOWCASE_BASE_MAX_SIZE,
} from '../../src/shared-types/baseBudgets.js';
import { GAMEPLAY_SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../src/shared-types/sectorBounds.js';
import { MAX_ENTITIES } from '../../src/shared-types/sabLayout.js';
import { FORMATION_DEST_RANGE } from '../../src/server/livingworld/LivingWorldDirector.js';
import { deriveStatMultipliers, pointBudget } from '../../src/core/leveling/shipStats.js';
import { LEVEL_CAP } from '../../src/core/leveling/shipXp.js';

/** Bytes per stored piece in the planned flat layout:
 *  kind u8 + x/y/w/h i32 (16) + rot90 u8 + chunk u16 = 20. */
const LAYOUT_BYTES_PER_PIECE = 20;
/** Descriptor scalars in room state (ver, archetype, seed, x, y, size, faction). */
const DESCRIPTOR_BYTES = 64;
/** The reference viewport the render budgets are sized for. */
const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;
const PHYSICS_HZ = 60;

describe('base budgets — internal consistency', () => {
  it('piece budgets nest: chunk ≤ base ≤ sector, client active set ≤ sector', () => {
    expect(MAX_PIECES_PER_CHUNK).toBeLessThanOrEqual(MAX_PIECES_PER_BASE);
    expect(MAX_PIECES_PER_BASE).toBeLessThanOrEqual(MAX_PIECES_PER_SECTOR);
    expect(MAX_CLIENT_ACTIVE_PIECES).toBeLessThanOrEqual(MAX_PIECES_PER_SECTOR);
  });

  it('a max base fits its layout-memory budget', () => {
    expect(MAX_PIECES_PER_BASE * LAYOUT_BYTES_PER_PIECE).toBeLessThanOrEqual(MAX_LAYOUT_BYTES_PER_BASE);
  });

  it('a max base fits its join-bytes budget (descriptor + one destroy bit per piece)', () => {
    const maskBytes = Math.ceil(MAX_PIECES_PER_BASE / 32) * 4;
    expect(DESCRIPTOR_BYTES + maskBytes).toBeLessThanOrEqual(MAX_BASE_JOIN_BYTES);
  });

  it('chunk capacity can hold a max base: enough chunks × pieces-per-chunk', () => {
    const chunksAcross = Math.ceil(SHOWCASE_BASE_MAX_SIZE / BASE_CHUNK_SIZE);
    expect(chunksAcross * chunksAcross * MAX_PIECES_PER_CHUNK).toBeGreaterThanOrEqual(MAX_PIECES_PER_BASE);
  });

  it('the zoomed-in render case fits MAX_VISIBLE_CHUNKS at the reference viewport', () => {
    // Just above the LOD zoom is the widest per-chunk view (below it the
    // single silhouette takes over). +1 per axis for partial chunks at edges.
    const spanX = VIEWPORT_W / BASE_LOD_ZOOM;
    const spanY = VIEWPORT_H / BASE_LOD_ZOOM;
    const visible = (Math.ceil(spanX / BASE_CHUNK_SIZE) + 1) * (Math.ceil(spanY / BASE_CHUNK_SIZE) + 1);
    expect(visible).toBeLessThanOrEqual(MAX_VISIBLE_CHUNKS);
  });

  it('the client predWorld active radius covers at least one chunk beyond the ship', () => {
    expect(PREDWORLD_ACTIVE_RADIUS).toBeGreaterThanOrEqual(BASE_CHUNK_SIZE * 2);
  });
});

describe('base budgets — grounded to the live game', () => {
  it('corridors clear the largest PLAYER-FLYABLE ship (engineering-only kinds excluded)', () => {
    let maxRadius = 0;
    for (const k of GAMEPLAY_SHIP_KINDS_LIST) maxRadius = Math.max(maxRadius, k.radius);
    // A bigger flyable ship landing in the catalogue must force a review here.
    expect(MIN_CORRIDOR_WIDTH).toBeGreaterThanOrEqual(CORRIDOR_RADIUS_MULTIPLE * maxRadius);
  });

  it('walls are thick enough that no flyable ship can tunnel through in one tick (CCD is off)', () => {
    // The real speed ceiling is the per-tick `maxSpeed` clamp in
    // applyShipInput (it binds while boosting too), scaled by the largest
    // possible topSpeed upgrade (every point at the level cap).
    const topSpeedMul = deriveStatMultipliers({ topSpeed: pointBudget(LEVEL_CAP) }).topSpeed;
    let maxPerTick = 0;
    for (const k of GAMEPLAY_SHIP_KINDS_LIST) {
      maxPerTick = Math.max(maxPerTick, (k.maxSpeed * topSpeedMul) / PHYSICS_HZ);
    }
    // 2× margin: a ship can't skip a wall of this thickness between steps.
    expect(MIN_WALL_THICKNESS).toBeGreaterThanOrEqual(2 * maxPerTick);
  });

  it('showcase bases fit the playable sector', () => {
    expect(SHOWCASE_BASE_MAX_SIZE).toBeLessThanOrEqual(2 * SECTOR_PLAYABLE_HALF_EXTENT);
  });

  it('a sector-centred galaxy base stays inside the roaming squads’ ring minus margin', () => {
    // Roaming AI has no static-obstacle avoidance yet (PR-N lifts this).
    expect(GALAXY_BASE_MAX_SIZE / 2).toBeLessThanOrEqual(FORMATION_DEST_RANGE - ROAM_RING_KEEPOUT_MARGIN);
  });

  it('Tier B live entities leave the entity pool overwhelmingly free', () => {
    expect(MAX_TIER_B_PER_BASE).toBeLessThanOrEqual(MAX_TIER_B_PER_SECTOR);
    // ≤ 5% of the shared 5120-slot pool (ships, drones, asteroids, scrap share it).
    expect(MAX_TIER_B_PER_SECTOR).toBeLessThanOrEqual(MAX_ENTITIES * 0.05);
  });
});
