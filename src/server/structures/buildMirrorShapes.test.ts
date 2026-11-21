/**
 * Build mirror (base loop 4A-2): every remaining structure shape goes through
 * the ONE transform `structureLocalToWorld` (flip local x, then turn). At
 * rotation 0 a mirrored structure's world point is the x-flip (about its
 * centre) of the unmirrored one's.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/PersistenceWorker.js', () => ({ getPlayerShipStore: () => null }));
import { structureLocalToWorld, structureWorldToLocal, getStructureKind } from '../../shared-types/structureKinds.js';
import { emitterAnchor, gateColliderPolygons, gateWorldAxisBoxes } from '../../core/structures/gateGeometry.js';
import { CAPITAL_BAY, craneBayWorldCentre, onStructureCraneBay } from '../../core/articulation/rigCatalogue.js';
import { newHullOrigin } from '../rooms/features/hullHandOff.js';
import { StructureMountTicker, type TurretTargetView } from './StructureMountTicker.js';
import { worldToRigHost } from './structureRigClip.js';
import { gateHitBoxes } from './doorLeafBoxes.js';
import type { StructureRecord } from './StructureRegistry.js';

const p = () => ({ x: 0, y: 0 });

describe('build mirror: structureWorldToLocal', () => {
  it('is the exact inverse of structureLocalToWorld, mirrored or not, at every turn', () => {
    for (const mirror of [false, true]) {
      for (const deg of [0, 90, 180, 270]) {
        const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const w = structureLocalToWorld(130, -40, 1000, -500, c, s, mirror, p());
        const l = structureWorldToLocal(w.x, w.y, 1000, -500, c, s, mirror, p());
        expect(l.x).toBeCloseTo(130, 9);
        expect(l.y).toBeCloseTo(-40, 9);
      }
    }
  });
});

describe('build mirror: gate posts and shield-wall anchors', () => {
  it('a mirrored gate anchors on the x-flip of the unmirrored anchor (toward point flipped too)', () => {
    for (const kind of ['shield_gate', 'shield_airlock']) {
      const cx = 1000, cy = 200;
      const plain = emitterAnchor(kind, cx, cy, 0, cx + 900, cy + 300, p());
      const flip = emitterAnchor(kind, cx, cy, 0, cx - 900, cy + 300, p(), true);
      expect(flip.x).toBeCloseTo(2 * cx - plain.x, 9);
      expect(flip.y).toBeCloseTo(plain.y, 9);
    }
  });
});

describe('build mirror: lopsided colliders (the Shipyard)', () => {
  it('collider polygons are the x-flip of the unmirrored ones', () => {
    const plain = gateColliderPolygons('shipyard')!;
    const flip = gateColliderPolygons('shipyard', true)!;
    expect(flip).toHaveLength(plain.length);
    for (let i = 0; i < plain.length; i++) {
      const xs = plain[i]!.map((q) => -q.x).sort((a, b) => a - b);
      expect(flip[i]!.map((q) => q.x).sort((a, b) => a - b)).toEqual(xs);
      expect(flip[i]!.map((q) => q.y).sort()).toEqual(plain[i]!.map((q) => q.y).sort());
    }
    // It really is lopsided: the flip moves something.
    expect(flip[0]![0]!.x).not.toBeCloseTo(plain[0]![0]!.x, 3);
  });

  it('weapon hit boxes (static parts) flip their centre x', () => {
    const plain = gateWorldAxisBoxes('shipyard', 0)!;
    const flip = gateWorldAxisBoxes('shipyard', 0, true)!;
    const hits = gateHitBoxes('shipyard', 0, true)!;
    for (let i = 0; i < plain.length; i += 4) {
      expect(flip[i]).toBeCloseTo(-plain[i]!, 4);
      expect(flip[i + 1]).toBeCloseTo(plain[i + 1]!, 4);
      expect(hits[i]).toBeCloseTo(-plain[i]!, 4);
    }
  });
});

describe('build mirror: turret mount positions', () => {
  function fires(mirror: boolean, targetX: number): number {
    const shots: number[] = [];
    let cands: TurretTargetView[] = [];
    const ticker = new StructureMountTicker({
      targets: (x, y, range, _o, out) => { let n = 0; for (const c of cands) if (Math.hypot(c.x - x, c.y - y) <= range) out[n++] = c; return n; },
      fire: (_r, _k, i) => { shots.push(i); return true; },
    });
    ticker.setInstantLocks(true);
    const kind = getStructureKind('coastal_casemate_8in');
    // One off-centre mount with a narrow embrasure straight ahead (+y).
    const mount = { ...kind.mounts![0]!, localX: 600, localY: 0, arcMin: -0.05, arcMax: 0.05 };
    const rec = { id: 'm', kind: kind.id, owner: 'npc:red', x: 0, y: 0, rot: 0, level: 1, isConstructed: true, mirror } as unknown as StructureRecord;
    cands = [{ id: 't', entityId: 1, x: targetX, y: 3000, vx: 0, vy: 0, cls: 'capital', signature: 200 }];
    let now = 0;
    for (let i = 0; i < 200; i++) { now += 100; const dt = ticker.beginTick(now, 0.1); ticker.tick(rec, kind, [mount], now, dt); }
    return shots.length;
  }

  it('a mirrored mount sits at the x-flip: it engages the flipped target, not the original', () => {
    expect(fires(false, 600)).toBeGreaterThan(0);
    expect(fires(true, -600)).toBeGreaterThan(0);
    expect(fires(true, 600)).toBe(0);
  });
});

describe('build mirror: crane pad and arm', () => {
  it('the Capital bay centre and the on-bay test flip x', () => {
    const plain = craneBayWorldCentre(CAPITAL_BAY, 0, 0, 0);
    const flip = craneBayWorldCentre(CAPITAL_BAY, 0, 0, 0, true);
    expect(flip.x).toBeCloseTo(-plain.x, 9);
    expect(flip.y).toBeCloseTo(plain.y, 9);
    expect(onStructureCraneBay('capital', 0, 0, 0, -plain.x, plain.y, true)).toBe(true);
    if (Math.abs(plain.x) > CAPITAL_BAY.padHalfW) {
      expect(onStructureCraneBay('capital', 0, 0, 0, plain.x, plain.y, true)).toBe(false);
    }
  });

  it('the arm target (world → rig host frame) undoes the flip', () => {
    const rec = { id: 'c', kind: 'capital', x: 100, y: 50, rot: 0, mirror: true } as unknown as StructureRecord;
    const h = worldToRigHost(rec, 100 - 300, 50 + 80);
    expect(h.x).toBeCloseTo(300, 9);
    expect(h.y).toBeCloseTo(80, 9);
  });
});

describe('build mirror: where a new hull appears (Shipyard)', () => {
  it('keel, park point and heading are the x-flip of the unmirrored yard', () => {
    const cx = 2000, cy = -300;
    const plain = newHullOrigin('shipyard', cx, cy, 0, 'crossguard', 0);
    const flip = newHullOrigin('shipyard', cx, cy, 0, 'crossguard', 0, true);
    expect(flip.x).toBeCloseTo(2 * cx - plain.x, 6);
    expect(flip.y).toBeCloseTo(plain.y, 6);
    expect(flip.parkX).toBeCloseTo(2 * cx - plain.parkX, 6);
    expect(flip.parkY).toBeCloseTo(plain.parkY, 6);
    // Nose (-sin a, cos a): x flips, y stays.
    expect(-Math.sin(flip.angle)).toBeCloseTo(Math.sin(plain.angle), 9);
    expect(Math.cos(flip.angle)).toBeCloseTo(Math.cos(plain.angle), 9);
  });
});
