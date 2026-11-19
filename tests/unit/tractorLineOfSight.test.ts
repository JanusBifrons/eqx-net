/**
 * Tractor line of sight (owner 2026-11-18: "you need line of sight to be able
 * to tractor something. So it would tractor the big wreck and not hit the
 * small piece"). A body between the dish and the locked target takes the beam:
 * the field acts on the FIRST body the line meets, never on the target behind
 * it. Wired through the room's real shared line query (`LineOfFireGate`) and
 * the real force-field step (`applyForceFields`), and the client's snapshot
 * slice (`TractorLinkClient`) so both sides agree on what the beam holds (#15).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForceFieldSubsystem, type TractorDeps, type TractorPoseOut } from '../../src/server/rooms/ForceFieldSubsystem.js';
import { LineOfFireGate, type LineOfFireBody } from '../../src/server/rooms/LineOfFireGate.js';
import type { WorkerCmd } from '../../src/server/rooms/PhysicsWorkerProxy.js';
import { rayHitsSphere } from '../../src/core/combat/Weapons.js';
import { applyForceFields, type ForceFieldBody, type TractorForceField, type ForceField } from '../../src/core/physics/forceFields.js';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../src/shared-types/sabLayout.js';
import { forEachBeamLink, type BeamLinks, type BeamLinkVisitor } from '../../src/shared-types/beamLinksWire.js';
import { TractorLinkClient } from '../../src/client/net/tractorLinks.js';
import { getShipKind, type WeaponMount } from '../../src/shared-types/shipKinds.js';
import type RAPIER from '@dimforge/rapier2d-compat';

interface Body extends LineOfFireBody { entityId: number }

// The emitter flies an interceptor whose first mount is made a tractor (as
// in tractorFieldParity), so both sides resolve the same mount.
const mounts = getShipKind('interceptor').mounts as WeaponMount[];
const saved = mounts.map((m) => ({ weaponId: m.weaponId, size: m.size }));
afterEach(() => { mounts.forEach((m, i) => { m.weaponId = saved[i]!.weaponId; m.size = saved[i]!.size; }); });
const mount = mounts[0]!;
beforeEach(() => { mount.weaponId = 'tractor'; mount.size = 'L'; });

function scene() {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const recs: Body[] = [];
  const poses = new Map<string, { x: number; y: number; radius: number }>();
  const put = (id: string, entityId: number, x: number, y: number, radius: number) => {
    let rec = recs.find((r) => r.id === id);
    if (rec === undefined) { rec = { id, slot: recs.length, radius, entityId }; recs.push(rec); }
    const b = slotBase(rec.slot);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y;
    poses.set(id, { x, y, radius });
  };
  let tick = 100;
  let version = 1;
  const gate = new LineOfFireGate<Body>({
    registry: { all: () => recs, get version() { return version; } },
    sabF32: sab,
    tick: () => tick,
    rayHit: (rec, fx, fy, dx, dy, max, cx, cy) => rayHitsSphere(fx, fy, dx, dy, max, cx, cy, rec.radius),
  });
  const posted: WorkerCmd[] = [];
  const deps: TractorDeps = {
    tick: () => tick,
    poseOf: (id: string, out: TractorPoseOut) => {
      const p = poses.get(id);
      if (!p) return false;
      out.x = p.x; out.y = p.y; out.angle = 0; out.kindId = null; out.radius = p.radius;
      return true;
    },
    lineBodies: (fx, fy, tx, ty, w, a, b, ids, cap) => gate.lineBodies(fx, fy, tx, ty, w, a, b, ids, cap),
    lineBlocker: (fx, fy, tx, ty, emitter, target) => gate.firstOnLine(fx, fy, tx, ty, emitter, target, () => true),
    inCrackHold: () => false,
    wireRef: (id) => recs.find((r) => r.id === id)?.entityId ?? id,
    onShipTractored: () => {},
    isTerrain: () => true,
  };
  const ff = new ForceFieldSubsystem({ post: (c) => posted.push(c), tractors: deps });
  const lastField = (): TractorForceField =>
    (posted.filter((c) => c.type === 'SET_FORCE_FIELD').at(-1) as { field: TractorForceField }).field;
  return { ff, put, lastField, recs, poses, step: () => { tick++; version++; } };
}

/** A fake dynamic Rapier body that records the impulses it is given. */
function fakeBody(x: number, y: number, radius: number): ForceFieldBody & { j: { x: number; y: number } } {
  const j = { x: 0, y: 0 };
  const body = {
    isDynamic: () => true,
    translation: () => ({ x, y }),
    linvel: () => ({ x: 0, y: 0 }),
    mass: () => radius * radius,
    applyImpulse: (v: { x: number; y: number }) => { j.x += v.x; j.y += v.y; },
  } as unknown as RAPIER.RigidBody;
  return { body, kind: { radius }, j };
}

describe('tractor line of sight', () => {
  it('a big wreck between the dish and a small piece takes the beam: the small piece is not pulled', () => {
    const s = scene();
    s.put('barge', 1, 0, 0, 5);
    s.put('big', 2, 0, 400, 100); // spans y 300..500, squarely on the line
    s.put('small', 3, 0, 600, 10);
    expect(s.ff.renewTractor('barge', mount, 'small')).toBe(true);
    s.ff.tickTractors();
    const f = s.lastField();
    expect(f.target).toBe('big');
    expect(f.lineIds.slice(0, f.lineCount)).not.toContain('small');

    // The worker's own step: the blocker moves, the small piece does not.
    const big = fakeBody(0, 400, 100), small = fakeBody(0, 600, 10);
    const bodies = new Map<string, ForceFieldBody>([['big', big], ['small', small]]);
    applyForceFields(new Map<string, ForceField>([['t', f]]), bodies, 1 / 60);
    expect(small.j).toEqual({ x: 0, y: 0 });
    expect(big.j.y).toBeLessThan(0); // toward the dish

    // The snapshot names the body the beam holds, so the client draws and
    // predicts the beam on the blocker too (#15, #16).
    const links = s.ff.beamLinks(undefined) as BeamLinks;
    const targets: Array<number | string> = [];
    forEachBeamLink(links, { structure: () => {}, tractor: (_e, _m, t) => { targets.push(t); } });
    expect(targets).toEqual([2]);
    const mirror = {
      ships: new Map<string, { x: number; y: number; angle: number; vx: number; vy: number; kind?: string }>(),
      swarm: new Map([
        [1, { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 1, shipKind: 'interceptor' }],
        [2, { x: 0, y: 400, angle: 0, vx: 0, vy: 0, kind: 4, radius: 100 }],
        [3, { x: 0, y: 600, angle: 0, vx: 0, vy: 0, kind: 4, radius: 10 }],
      ]),
    };
    const client = new TractorLinkClient(mirror, new Map([[1, 'barge'], [2, 'big'], [3, 'small']]));
    const set: TractorForceField[] = [];
    const visitor: BeamLinkVisitor = { structure: () => {}, tractor: client.add };
    client.sync(links, visitor, { setForceField: (_id, fld) => { set.push({ ...(fld as TractorForceField) }); }, removeForceField: () => {} });
    expect(client.live.map((r) => r.target)).toEqual([2]);
    expect(set.length).toBe(1);
    for (const cf of set) expect(cf.target).toBe('big');
  });

  it('a clear line pulls the locked target; the beam returns to it once the blocker moves off the line', () => {
    const s = scene();
    s.put('barge', 1, 0, 0, 5);
    s.put('big', 2, 0, 400, 100);
    s.put('small', 3, 0, 600, 10);
    s.ff.renewTractor('barge', mount, 'small');
    s.ff.tickTractors();
    expect(s.lastField().target).toBe('big');
    s.put('big', 2, 1000, 400, 100); // off the line
    s.step();
    s.ff.tickTractors();
    expect(s.lastField().target).toBe('small');
  });

  it('a body behind the target, or beside the line, never takes the beam', () => {
    const s = scene();
    s.put('barge', 1, 0, 0, 5);
    s.put('small', 3, 0, 600, 10);
    s.put('behind', 4, 0, 900, 200);
    s.put('beside', 5, 300, 300, 50);
    s.ff.renewTractor('barge', mount, 'small');
    s.ff.tickTractors();
    expect(s.lastField().target).toBe('small');
  });
});
