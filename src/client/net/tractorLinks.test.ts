/**
 * The tractor client slice (salvage plan PR 11b): snapshot beam links →
 * `mirror.tractorLinks` rows (#16) + prediction-world tractor fields (#15).
 * No ship kind carries a tractor yet (the barge is PR 15), so the tests swap
 * the interceptor's mounts to `tractor` in-process and restore them after.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TractorLinkClient, type TractorMirrorView, type TractorPredWorld } from './tractorLinks.js';
import { encodeTractorLink, type BeamLinks, type BeamLinkVisitor } from '../../shared-types/beamLinksWire.js';
import { getShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { ForceField, TractorForceField } from '../../core/physics/forceFields.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';

const mounts = getShipKind('interceptor').mounts as WeaponMount[];
const saved = mounts.map((m) => m.weaponId);
afterEach(() => { mounts.forEach((m, i) => { m.weaponId = saved[i]!; }); });
const MOUNT = mounts[0]!.id;

function ship(x: number, y: number, angle = 0) {
  return { x, y, angle, vx: 0, vy: 0, kind: 'interceptor' };
}

function rig() {
  const mirror: TractorMirrorView = {
    ships: new Map([['me', ship(0, 0)]]),
    swarm: new Map([[42, { x: 0, y: 900, angle: 0, vx: 0, vy: 0 }]]),
  };
  const keys = new Map<number, string>([[42, 'swarm-42']]);
  const client = new TractorLinkClient(mirror, keys);
  const structures: number[] = [];
  const visitor: BeamLinkVisitor = { structure: (sid) => { structures.push(sid); }, tractor: client.add };
  const sets: Array<{ id: string; f: TractorForceField }> = [];
  const removes: string[] = [];
  const world: TractorPredWorld = {
    setForceField: (id: string, f: ForceField) => { sets.push({ id, f: { ...(f as TractorForceField) } }); },
    removeForceField: (id: string) => { removes.push(id); },
  };
  return { mirror, client, visitor, structures, sets, removes, world };
}

function links(...recs: Array<[number | string, string, number | string]>): BeamLinks {
  const out: BeamLinks = [7, -1, -1]; // one structure triple first (no targets)
  let at = out.length;
  for (const [e, m, t] of recs) at = encodeTractorLink(out, at, e, m, t, 100, 112);
  return out;
}

describe('TractorLinkClient — decode', () => {
  it('a tractor link reaches mirror.tractorLinks beside the structure triples; a dropped lease drops its row', () => {
    const r = rig();
    r.client.sync(links(['me', MOUNT, 42]), r.visitor, null);
    expect(r.structures).toEqual([7]);
    expect(r.mirror.tractorLinks).toEqual([{ emitter: 'me', mountId: MOUNT, target: 42 }]);
    r.client.sync([7, -1, -1], r.visitor, null);
    expect(r.mirror.tractorLinks).toEqual([]);
  });

  it('decodes with no structures at all (a tractor-only beam-links array)', () => {
    const r = rig();
    const flat: BeamLinks = [];
    encodeTractorLink(flat, 0, 42, MOUNT, 'me', 1, 2);
    r.client.sync(flat, r.visitor, null);
    expect(r.mirror.tractorLinks).toEqual([{ emitter: 42, mountId: MOUNT, target: 'me' }]);
    r.client.sync(undefined, r.visitor, null);
    expect(r.mirror.tractorLinks).toHaveLength(0);
  });

  it('reuses its rows: no new row object for a steady link (#14)', () => {
    const r = rig();
    r.client.sync(links(['me', MOUNT, 42]), r.visitor, null);
    const row = r.mirror.tractorLinks![0];
    r.client.sync(links(['me', MOUNT, 42]), r.visitor, null);
    expect(r.mirror.tractorLinks![0]).toBe(row);
  });
});

describe('TractorLinkClient — prediction world', () => {
  it('sets one tractor field per link from a tractor mount (target and emitter as predWorld body ids), removes it when the lease ends', () => {
    for (const m of mounts) m.weaponId = 'tractor';
    const r = rig();
    r.client.sync(links(['me', MOUNT, 42]), r.visitor, r.world);
    expect(r.sets).toHaveLength(1);
    const f = r.sets[0]!.f;
    expect(f.kind).toBe('tractor');
    expect(f.active).toBe(true);
    expect(f.target).toBe('swarm-42');
    expect(f.emitter).toBe('me');
    expect(f.force).toBe(getWeapon('tractor').tractor!.force * 1); // S mount: power 1
    expect(f.lineCount).toBe(0); // the beam-line set is server-only
    r.client.sync([], r.visitor, r.world);
    expect(r.removes).toEqual([r.sets[0]!.id]);
  });

  it('no field when the mount is not a tractor or the target has no body yet', () => {
    const r = rig();
    r.client.sync(links(['me', MOUNT, 42]), r.visitor, r.world); // still a laser
    expect(r.sets).toHaveLength(0);
    for (const m of mounts) m.weaponId = 'tractor';
    r.client.sync(links(['me', MOUNT, 99]), r.visitor, r.world); // 99: no body
    expect(r.sets).toHaveLength(0);
    expect(r.mirror.tractorLinks).toHaveLength(1); // still drawn
  });

  it('a pulled LOCAL ship is predicted pulled toward the emitter in a real PhysicsWorld', async () => {
    for (const m of mounts) m.weaponId = 'tractor';
    const w = await PhysicsWorld.create();
    w.spawnShip('me', 0, 0, 'interceptor');
    w.tick(1 / 60);
    const r = rig();
    // A drone emitter 900 u above, its tractor on the local ship.
    r.mirror.swarm = new Map([[42, { x: 0, y: 900, angle: Math.PI, vx: 0, vy: 0, shipKind: 'interceptor' }]]);
    r.client.sync(links([42, MOUNT, 'me']), r.visitor, w);
    for (let i = 0; i < 60; i++) w.tick(1 / 60);
    expect(w.getShipState('me')!.y).toBeGreaterThan(1);
    // The lease ends: the field goes, the ship stops being pulled harder.
    r.client.sync(undefined, r.visitor, w);
    const vy = w.getShipState('me')!.vy;
    for (let i = 0; i < 30; i++) w.tick(1 / 60);
    expect(w.getShipState('me')!.vy).toBeLessThanOrEqual(vy + 1e-6);
  });
});
