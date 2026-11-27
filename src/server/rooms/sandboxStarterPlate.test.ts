import { describe, expect, it, vi } from 'vitest';
import { STARTER_CAPITAL_OFFSET } from './sandboxFleet.js';
import { seedStarterPlate, type StarterPlateHost } from './sandboxStarterPlate.js';

// Owner bug report: in the sandbox (a deck room) nothing could be built: a
// player with no plate is off-deck everywhere and a new plate must border one
// they own. The join now lays them a built starter plate.
interface Rec { id: string; owner: string; kind: string; x: number; y: number; isConstructed: boolean; constructionProgress: number; constructionCost: number }
function fakeHost(): { h: StarterPlateHost; recs: Map<string, Rec>; sync: ReturnType<typeof vi.fn> } {
  const recs = new Map<string, Rec>();
  const sync = vi.fn();
  let n = 0;
  const registry = {
    all: () => recs.values(), get: (id: string) => recs.get(id), topologyDirty: false, syncPlateOwners: sync,
  };
  const h = {
    structureRegistry: registry,
    structurePlacement: () => ({
      place: (owner: string, kind: string, x: number, y: number) => {
        const id = `st${n++}`;
        recs.set(id, { id, owner, kind, x, y, isConstructed: false, constructionProgress: 0, constructionCost: 10 });
        return id;
      },
    }),
    swarmHealth: () => new Map<string, number>(),
    logger: { warn: vi.fn() },
  } as unknown as StarterPlateHost;
  return { h, recs, sync };
}

describe('seedStarterPlate', () => {
  it('lays a built connector on the plate centre and a built Capital in its outer hex', () => {
    const { h, recs, sync } = fakeHost();
    expect(seedStarterPlate(h, 'p1', 0, 0)).toBe(2);
    const [conn, cap] = [...recs.values()];
    expect(conn).toMatchObject({ owner: 'p1', kind: 'connector', x: 0, y: 0, isConstructed: true });
    expect(cap).toMatchObject({ owner: 'p1', kind: 'capital', x: STARTER_CAPITAL_OFFSET.x, y: STARTER_CAPITAL_OFFSET.y, isConstructed: true });
    expect(sync).toHaveBeenCalled();
  });

  it('re-join: a player who already anchors a plate gets nothing more', () => {
    const { h, recs } = fakeHost();
    seedStarterPlate(h, 'p1', 0, 0);
    expect(seedStarterPlate(h, 'p1', 0, 0)).toBe(0);
    expect(recs.size).toBe(2);
  });

  it('another player still gets their own', () => {
    const { h } = fakeHost();
    seedStarterPlate(h, 'p1', 0, 0);
    expect(seedStarterPlate(h, 'p2', 5000, 0)).toBe(2);
  });
});
