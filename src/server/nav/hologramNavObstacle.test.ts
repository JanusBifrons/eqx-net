/**
 * Hologram pass-through, navigation side (base loop 3F2): a blueprint whose
 * body is still a ghost is no nav obstacle (ships fly through it, so routes
 * may too); it becomes one the moment its body turns solid
 * (`settleBlueprintBody` → `StructureRegistry.bodyChanged`). Same shared rule
 * as physics: `isStructureBodySolid`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { GridObstacle } from '../../core/structures/Grid.js';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';

const obstacles = new Map<number, GridObstacle>();
vi.mock('./NavWorker.js', () => ({
  getNavWorker: () => ({
    addField: () => ({
      built: new Promise(() => {}),
      obstacle: (id: number, o: GridObstacle | null) => { if (o) obstacles.set(id, o); else obstacles.delete(id); },
      chunk: () => {}, rockGone: () => {}, rockMoved: () => {}, detach: () => {}, route: () => null, stats: null,
    }),
  }),
}));

const { RoomNav } = await import('./RoomNav.js');
const { StructureRegistry } = await import('../structures/StructureRegistry.js');
const { settleBlueprintBody } = await import('../structures/blueprintBody.js');
const { structureHalfExtents, structureKindToIndex } = await import('../../shared-types/structureKinds.js');
type Rec = import('../structures/StructureRegistry.js').StructureRecord;

function rec(id: string, x: number, ghost: boolean): Rec {
  const { hw, hh } = structureHalfExtents('capital', 0);
  return {
    id, owner: 'p1', kind: 'capital', subtypeIndex: structureKindToIndex('capital'), x, y: 0, radius: 20, rot: 0, halfW: hw, halfH: hh,
    isConstructed: !ghost, ...(ghost ? { ghostBody: true } : {}), constructionProgress: 0, constructionCost: 10, isDeconstructing: false,
    minerals: 0, storedPower: 0, level: 1,
  };
}

function hostedNav(registry: InstanceType<typeof StructureRegistry>): InstanceType<typeof RoomNav> {
  const logger = { info: () => {}, error: () => {} } as unknown as Logger;
  const nav = new RoomNav({
    now: () => 0, logger, sectorKey: () => 's', stopped: () => false, hullOf: () => null, structures: () => registry,
  });
  nav.host({ attachNav: () => ({ gone: [], moved: [] }) }, {} as ChunkOpts);
  return nav;
}

describe('holograms and the nav obstacle map (3F2)', () => {
  it('a hologram is not a nav obstacle; it becomes one when its body turns solid', () => {
    obstacles.clear();
    const registry = new StructureRegistry();
    const nav = hostedNav(registry);
    const bp = rec('bp', 0, true);
    registry.add(bp);
    expect(obstacles.size, 'a ghost body is passable').toBe(0);
    // Finished with no ship inside: the room's grid pulse turns it solid.
    expect(settleBlueprintBody(bp, { shipHulls: () => [], solidify: () => {}, registry })).toBe(true);
    expect(obstacles.size, 'solid now: routes go round it').toBe(1);
    registry.remove('bp');
    expect(obstacles.size).toBe(0);
    nav.detach();
  });

  it('a hologram with a ship inside stays passable to nav while it waits', () => {
    obstacles.clear();
    const registry = new StructureRegistry();
    const nav = hostedNav(registry);
    const bp = rec('bp2', 0, true);
    registry.add(bp);
    expect(settleBlueprintBody(bp, { shipHulls: () => [{ x: 0, y: 0, r: 10 }], solidify: () => {}, registry })).toBe(false);
    expect(obstacles.size).toBe(0);
    nav.detach();
  });

  it('a road (flat deck tile) is never a nav obstacle, even built (base platforms 20)', () => {
    obstacles.clear();
    const registry = new StructureRegistry();
    const nav = hostedNav(registry);
    const road: Rec = { ...rec('road', 0, true), kind: 'road', subtypeIndex: structureKindToIndex('road') };
    registry.add(road);
    road.isConstructed = true;
    expect(settleBlueprintBody(road, { shipHulls: () => [], solidify: () => {}, registry })).toBe(true);
    expect(obstacles.size, 'ships fly over a road').toBe(0);
    nav.detach();
  });

  it('a built structure is a nav obstacle from placement (unchanged)', () => {
    obstacles.clear();
    const registry = new StructureRegistry();
    const nav = hostedNav(registry);
    registry.add(rec('built', 0, false));
    expect(obstacles.size).toBe(1);
    nav.detach();
  });
});
