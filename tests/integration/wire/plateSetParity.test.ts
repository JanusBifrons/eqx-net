/**
 * Base platforms slice 5 — #15 two-sided contract: the derived plate set.
 * The server's `StructureRegistry` and the client's `StructureRowSync` both
 * keep a `PlateSet` (core/hex/plateSet.ts); fed the same structures (one fed
 * records, the other room-state rows + swarm poses) they must hold the same
 * plates per owner, through adds, an owner flip and removals.
 */
import { describe, expect, it } from 'vitest';
import type { RenderMirror, SwarmRenderState } from '../../../src/core/contracts/IRenderer.js';
import { StructureState } from '../../../src/server/rooms/schema/SectorState.js';
import { StructureRegistry, type StructureRecord } from '../../../src/server/structures/StructureRegistry.js';
import { StructureRowSync } from '../../../src/client/net/mirror/structureRowSync.js';
import { SWARM_KIND_STRUCTURE } from '../../../src/shared-types/swarmWireFormat.js';
import { plateCentreWorldInto } from '../../../src/core/hex/plates.js';
import type { PlateSet } from '../../../src/core/hex/plateSet.js';

interface Spec { id: number; owner: string; kind: StructureRecord['kind']; x: number; y: number; built: boolean }

const centre = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });

function rec(s: Spec): StructureRecord {
  return {
    id: String(s.id), owner: s.owner, kind: s.kind, subtypeIndex: 0, x: s.x, y: s.y, radius: 10,
    isConstructed: s.built, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, level: 1,
  } as StructureRecord;
}

/** A plate set as sorted `owner:i,j` strings (test-only). */
function dump(ps: PlateSet<string> | PlateSet<number>, owners: string[]): string[] {
  const out: string[] = [];
  for (const o of owners) ps.forEachPlate(o, (i, j) => out.push(`${o}:${i},${j}`));
  return out.sort();
}

class Sides {
  readonly reg = new StructureRegistry();
  private readonly ownerIds: string[] = [];
  private readonly rows = new Map<string, StructureState>();
  private readonly swarm = new Map<number, SwarmRenderState>();
  private readonly sync = new StructureRowSync({ swarm: this.swarm } as unknown as RenderMirror, { ids: [], names: [] });
  private readonly room = { state: { structures: this.rows, structureOwners: new Map<string, string>() } };

  private ownerIdx(o: string): number {
    let i = this.ownerIds.indexOf(o);
    if (i < 0) { i = this.ownerIds.length; this.ownerIds.push(o); this.room.state.structureOwners.set(String(i), o); }
    return i;
  }

  add(s: Spec): void {
    this.reg.add(rec(s));
    this.swarm.set(s.id, { kind: SWARM_KIND_STRUCTURE, shipKind: s.kind, x: s.x, y: s.y } as unknown as SwarmRenderState);
    const row = new StructureState();
    row.ownerIdx = this.ownerIdx(s.owner);
    row.flags = s.built ? 1 : 0;
    this.rows.set(String(s.id), row);
    this.sync.sync(this.room);
  }

  setOwner(id: number, owner: string): void {
    this.reg.get(String(id))!.owner = owner;
    this.reg.syncPlateOwners();
    this.rows.get(String(id))!.ownerIdx = this.ownerIdx(owner);
    this.sync.sync(this.room);
  }

  remove(id: number): void {
    this.reg.remove(String(id));
    this.rows.delete(String(id));
    this.sync.sync(this.room);
  }

  expectSame(owners: string[]): string[] {
    const server = dump(this.reg.plates, owners);
    expect(dump(this.sync.plates, owners)).toEqual(server);
    return server;
  }
}

describe('derived plate set — server registry and client mirror agree (#15)', () => {
  it('same structures ⇒ same plates, through adds, an owner flip and removals', () => {
    const s = new Sides();
    const owners = ['alice', 'bob'];
    const c00 = centre(0, 0);
    const c10 = centre(1, 0);
    const cm1 = centre(-1, 2);
    s.add({ id: 1, owner: 'alice', kind: 'connector', ...c00, built: true });
    s.add({ id: 2, owner: 'alice', kind: 'connector', ...c10, built: false }); // blueprint
    s.add({ id: 3, owner: 'bob', kind: 'connector', ...cm1, built: true });
    s.add({ id: 4, owner: 'bob', kind: 'connector', x: c10.x + 400, y: c10.y, built: true }); // off-centre
    s.add({ id: 5, owner: 'alice', kind: 'solar', x: c00.x + 3440, y: c00.y, built: true }); // not a connector
    expect(s.expectSame(owners)).toEqual(['alice:0,0', 'alice:1,0', 'bob:-1,2']);
    s.setOwner(2, 'bob');
    expect(s.expectSame(owners)).toEqual(['alice:0,0', 'bob:-1,2', 'bob:1,0']);
    s.remove(1);
    s.remove(3);
    expect(s.expectSame(owners)).toEqual(['bob:1,0']);
  });
});
