import { describe, expect, it } from 'vitest';
import { ForceFieldSubsystem } from './ForceFieldSubsystem.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

describe('ForceFieldSubsystem', () => {
  it('tracks fields and posts SET/REMOVE_FORCE_FIELD to the worker', () => {
    const posted: WorkerCmd[] = [];
    const ff = new ForceFieldSubsystem({ post: (c) => posted.push(c) });
    const field = { kind: 'pad', cx: 1, cy: 2, half: 3, active: true } as const;
    ff.set('tpfield-7', { ...field });
    expect(ff.size).toBe(1);
    expect(ff.get('tpfield-7')).toEqual(field);
    ff.set('tpfield-7', { ...field, active: false });
    expect(ff.size).toBe(1);
    expect(ff.get('tpfield-7')?.active).toBe(false);
    ff.remove('tpfield-7');
    expect(ff.size).toBe(0);
    expect(posted).toEqual([
      { type: 'SET_FORCE_FIELD', id: 'tpfield-7', field },
      { type: 'SET_FORCE_FIELD', id: 'tpfield-7', field: { ...field, active: false } },
      { type: 'REMOVE_FORCE_FIELD', id: 'tpfield-7' },
    ]);
  });
});

// ─── Tractor leases (salvage plan PR 11) ───
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { forEachBeamLink, type BeamLinkVisitor } from '../../shared-types/beamLinksWire.js';
import { TRACTOR_LEASE_CAP, lockKeyBodyId, type TractorDeps, type TractorPoseOut } from './ForceFieldSubsystem.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';
import type { TractorForceField } from '../../core/physics/forceFields.js';

function rig(over: Partial<TractorDeps> = {}) {
  const posted: WorkerCmd[] = [];
  const st = { tick: 100, poses: new Map<string, { x: number; y: number; angle: number }>(), line: [] as string[], hold: false, tractored: [] as string[] };
  st.poses.set('ship', { x: 0, y: 0, angle: 0 });
  st.poses.set('pod', { x: 0, y: 800, angle: 0 });
  const deps: TractorDeps = {
    tick: () => st.tick,
    poseOf: (id: string, out: TractorPoseOut) => {
      const p = st.poses.get(id);
      if (!p) return false;
      out.x = p.x; out.y = p.y; out.angle = p.angle;
      return true;
    },
    lineBodies: (_fx, _fy, _tx, _ty, _w, a, b, ids, cap) => {
      let n = 0;
      for (const id of st.line) if (id !== a && id !== b && n < cap) ids[n++] = id;
      return n;
    },
    inCrackHold: () => st.hold,
    wireRef: (id) => (id === 'pod' ? 42 : id),
    onShipTractored: (e, t) => { st.tractored.push(`${e}>${t}`); },
    isTerrain: (id) => id === 'pod',
    ...over,
  };
  const ff = new ForceFieldSubsystem({ post: (c) => posted.push(c), tractors: deps });
  return { ff, posted, st };
}
const mount = (size: WeaponMount['size'], weaponId: WeaponMount['weaponId'] = 'tractor'): WeaponMount =>
  ({ id: `m-${size}`, localX: 0, localY: 10, baseAngle: 0, arc: Math.PI, rotationSpeed: 1, weaponId, size }) as WeaponMount;
const lastField = (posted: WorkerCmd[]): TractorForceField =>
  (posted.filter((c) => c.type === 'SET_FORCE_FIELD').at(-1) as { field: TractorForceField }).field;

describe('ForceFieldSubsystem — tractor leases', () => {
  const spec = getWeapon('tractor').tractor!;

  it('a renew posts a tractor field on the target with force by mount size, muzzle at the mount, line set from the shared query', () => {
    const { ff, posted, st } = rig();
    st.line = ['rock', 'ship', 'pod', 'scrap'];
    expect(ff.renewTractor('ship', mount('L'), 'pod')).toBe(true);
    ff.tickTractors();
    const f = lastField(posted);
    expect(f.kind).toBe('tractor');
    expect(f.target).toBe('pod');
    expect(f.emitter).toBe('ship');
    expect(f.force).toBe(spec.force * MOUNT_SIZE_TUNING.L.power);
    expect(f.mx).toBeCloseTo(0); expect(f.my).toBeCloseTo(10);
    expect(f.active).toBe(true);
    expect(f.lineIds.slice(0, f.lineCount)).toEqual(['rock', 'scrap']);
    expect(f.dRef).toBeLessThanOrEqual(f.hold); // PR 10 rule: dRef ≤ hold
    const s = rig();
    s.ff.renewTractor('ship', mount('S'), 'pod');
    s.ff.tickTractors();
    expect(lastField(s.posted).force).toBe(spec.force);
  });

  it('expires leaseTicks after the last renew (REMOVE_FORCE_FIELD); a renew in time keeps it', () => {
    const { ff, posted, st } = rig();
    ff.renewTractor('ship', mount('S'), 'pod');
    st.tick += spec.leaseTicks - 1;
    ff.tickTractors();
    expect(ff.tractorCount).toBe(1);
    ff.renewTractor('ship', mount('S'), 'pod');
    st.tick += spec.leaseTicks - 1;
    ff.tickTractors();
    expect(ff.tractorCount).toBe(1);
    st.tick += 1;
    ff.tickTractors();
    expect(ff.tractorCount).toBe(0);
    expect(posted.at(-1)).toEqual({ type: 'REMOVE_FORCE_FIELD', id: 'tractor:ship:m-S' });
  });

  it('ends when the target is gone; no pull during a wreck crack hold', () => {
    const { ff, posted, st } = rig();
    st.hold = true;
    ff.renewTractor('ship', mount('S'), 'pod');
    ff.tickTractors();
    expect(lastField(posted).active).toBe(false);
    st.poses.delete('pod');
    ff.tickTractors();
    expect(ff.tractorCount).toBe(0);
  });

  it('refuses a non-tractor mount, no target and a self-target; tractoring a ship is a hostile act, terrain is not', () => {
    const { ff, st } = rig();
    expect(ff.renewTractor('ship', mount('S', 'laser'), 'pod')).toBe(false);
    expect(ff.renewTractor('ship', mount('S'), null)).toBe(false);
    expect(ff.renewTractor('ship', mount('S'), 'ship')).toBe(false);
    ff.renewTractor('ship', mount('S'), 'pod');
    expect(st.tractored).toEqual([]);
    st.poses.set('other', { x: 0, y: 500, angle: 0 });
    ff.renewTractor('ship', mount('M'), 'other');
    expect(st.tractored).toEqual(['ship>other']);
  });

  it('caps live leases', () => {
    const { ff } = rig();
    for (let i = 0; i < TRACTOR_LEASE_CAP; i++) expect(ff.renewTractor(`e${i}`, mount('S'), 'pod')).toBe(true);
    expect(ff.renewTractor('one-more', mount('S'), 'pod')).toBe(false);
  });

  it('beam links: structure triples pass through untouched with no tractor; tractor records follow them, round-trip', () => {
    const { ff, st } = rig();
    const structure = [7, 9, -1, 8, -1, 12];
    expect(ff.beamLinks(structure)).toBe(structure);
    expect(ff.beamLinks(undefined)).toBeUndefined();
    ff.renewTractor('ship', mount('S'), 'pod');
    const links = ff.beamLinks(structure)!;
    const seen: unknown[] = [];
    const v: BeamLinkVisitor = {
      structure: (sid, t, m) => seen.push(['s', sid, t, m]),
      tractor: (e, mid, t, a, b) => seen.push(['t', e, mid, t, a, b]),
    };
    forEachBeamLink(links, v);
    expect(seen).toEqual([['s', 7, 9, -1], ['s', 8, -1, 12], ['t', 'ship', 'm-S', 42, st.tick, st.tick + spec.leaseTicks]]);
  });

  it('lockKeyBodyId maps a lock key to its body id', () => {
    const reg = { getByEntityId: (n: number) => (n === 5 ? { id: 'loot-5' } : undefined) };
    expect(lockKeyBodyId('s:5', reg)).toBe('loot-5');
    expect(lockKeyBodyId('s:6', reg)).toBeNull();
    expect(lockKeyBodyId('p:abc', reg)).toBe('abc');
    expect(lockKeyBodyId(null, reg)).toBeNull();
  });
});
