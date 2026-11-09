/**
 * Coastal defences — defence-structure fire control runs the capital-ship
 * rules (plan coastal-defences): arcs turned by the structure's rotation,
 * tracking limits, calibre priority, lead, a barrel that turns at its traverse
 * rate, and fire only when on target.
 */
import { describe, expect, it } from 'vitest';
import { StructureMountTicker, type TurretTargetView } from './StructureMountTicker.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import type { StructureRecord } from './StructureRegistry.js';
import type { TargetClass } from '../../core/combat/mountTargeting.js';

interface Shot { mountIdx: number; ndx: number; ndy: number; target: string }

function setup(kindId: StructureKindId, rot = 0) {
  let cands: TurretTargetView[] = [];
  const shots: Shot[] = [];
  const ticker = new StructureMountTicker({
    targets: (x, y, range, _owner, out) => {
      let n = 0;
      for (const c of cands) if (Math.hypot(c.x - x, c.y - y) <= range) out[n++] = c;
      return n;
    },
    fire: (_rec, _kind, mountIdx, _mount, _def, ndx, ndy, target) => { shots.push({ mountIdx, ndx, ndy, target: target.id }); return true; },
  });
  const kind = getStructureKind(kindId);
  const rec = { id: 'g', kind: kindId, owner: 'npc:red', x: 0, y: 0, rot, isConstructed: true } as unknown as StructureRecord;
  let now = 0;
  const step = (n = 1, dtMs = 100) => {
    for (let i = 0; i < n; i++) {
      now += dtMs;
      const dt = ticker.beginTick(now, 0.1);
      ticker.tick(rec, kind, kind.mounts!, now, dt, 1);
    }
  };
  const set = (list: Array<{ id: string; x: number; y: number; vx?: number; vy?: number; cls?: TargetClass }>) => {
    cands = list.map((c) => ({ id: c.id, entityId: 1, x: c.x, y: c.y, vx: c.vx ?? 0, vy: c.vy ?? 0, cls: c.cls ?? 'capital' }));
  };
  return { ticker, shots, rec, kind, step, set, angle: () => ticker.anglesOf('g')?.[0] ?? 0 };
}

describe('StructureMountTicker — the capital fire-control rules on defence structures', () => {
  it('a casemate never fires outside its embrasure, and does not train toward it', () => {
    const h = setup('coastal_casemate_8in');
    h.set([{ id: 'behind', x: 0, y: -2000 }]); // dead astern of a +y-facing casemate
    h.step(200);
    expect(h.shots).toHaveLength(0);
    expect(h.angle()).toBe(0);
  });

  it("a casemate's embrasure turns with the structure: rotation 270 faces +x", () => {
    const h = setup('coastal_casemate_8in', 270);
    h.set([{ id: 'east', x: 2000, y: 0 }]);
    h.step(20);
    expect(h.shots.length).toBeGreaterThan(0);
    expect(h.shots[0]!.ndx).toBeCloseTo(1, 2);
    const w = setup('coastal_casemate_8in', 270);
    w.set([{ id: 'west', x: -2000, y: 0 }]);
    w.step(200);
    expect(w.shots).toHaveLength(0);
  });

  it('turns at its traverse rate: a 16" barbette takes seconds to come round, not one tick', () => {
    const h = setup('coastal_barbette_16in');
    const off = 60 * (Math.PI / 180); // 60° off its rest bearing, inside its 72° arc
    h.set([{ id: 'cap', x: -Math.sin(off) * 3000, y: Math.cos(off) * 3000 }]);
    h.step(1);
    expect(Math.abs(h.angle())).toBeCloseTo(0.07 * 0.1, 5);
    expect(h.shots).toHaveLength(0);
    h.step(200); // 20 s: 0.07 rad/s × 20 s = 1.4 rad > 60°
    expect(h.angle()).toBeCloseTo(off, 2);
    expect(h.shots.length).toBeGreaterThan(0);
  });

  it('a heavy turret cannot track a fighter crossing its bows; a quad AA can', () => {
    // 943 u out (inside the AA's reach), bearing rate ≈ 0.27 rad/s: within the
    // AA's 0.45 × 0.8, far beyond the 11"'s 0.087 × 0.8.
    const fast = [{ id: 'fighter', x: 500, y: 800, vx: -300, vy: 0, cls: 'small' as const }];
    const big = setup('coastal_turret_11in');
    big.set(fast);
    big.step(10);
    expect(big.shots).toHaveLength(0);
    const aa = setup('aa_quad_40mm');
    aa.set(fast);
    aa.step(1);
    expect(aa.ticker.anglesOf('g')![0]).not.toBe(0); // it is on it
  });

  it('a 5" mount prefers the gunship over a nearer fighter; a quad AA prefers the fighter', () => {
    const targets = [
      { id: 'fighter', x: 0, y: 500, cls: 'small' as const },
      { id: 'gunship', x: 0, y: 1500, cls: 'subcapital' as const },
    ];
    const dp = setup('dp_mount_5in');
    dp.set(targets);
    dp.step(5);
    expect(dp.shots[0]?.target).toBe('gunship');
    const aa = setup('aa_quad_40mm');
    aa.set(targets);
    aa.step(5);
    expect(aa.shots[0]?.target).toBe('fighter');
  });

  it('leads a moving capital by its shell flight time, not its present bearing', () => {
    const h = setup('coastal_turret_11in');
    h.set([{ id: 'cap', x: 0, y: 3000, vx: 60, vy: 0 }]);
    h.step(300);
    // Lead bearing: the target ~1.4 s ahead (3000 u / 2200 u/s) at 60 u/s ≈ 82 u right.
    const want = Math.atan2(-(60 * (3000 / 2200)), 3000);
    expect(h.angle()).toBeCloseTo(want, 2);
    expect(h.angle()).toBeLessThan(-0.01); // not the 0 of the present bearing
  });

  it('keeps its target through a brief loss and fires on its own reload', () => {
    const h = setup('dp_mount_5in');
    h.set([{ id: 'gunship', x: 0, y: 1500, cls: 'subcapital' }]);
    h.step(1);
    expect(h.shots).toHaveLength(1);
    h.step(10); // 1 s later: still reloading (4 s)
    expect(h.shots).toHaveLength(1);
    h.step(31);
    expect(h.shots).toHaveLength(2);
  });
});
