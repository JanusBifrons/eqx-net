import { describe, expect, it } from 'vitest';
import { PadDoors, type PadDoorHooks } from './padDoors.js';
import { gateHitBoxes } from './doorLeafBoxes.js';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS } from '../../core/structures/gateGeometry.js';
import { doorPosAt } from '../../core/structures/doorMotion.js';
import type { StructureRecord } from './StructureRegistry.js';
import type { RigClipCmd } from './structureRigClip.js';

function rig(kind: string, supply = 1) {
  const st = { tick: 0, ms: 0, supply, active: [] as boolean[], posts: [] as RigClipCmd[] };
  const boxes = gateHitBoxes(kind, 0)!;
  const hooks: PadDoorHooks = {
    serverTick: () => st.tick, nowMs: () => st.ms, supplyFrac: () => st.supply,
    setActive: (_r, on) => { st.active.push(on); }, post: (c) => { st.posts.push(c); }, hitBoxes: () => boxes,
  };
  const rec = { id: 'p1', kind, x: 0, y: 0, rot: 0, isConstructed: true } as unknown as StructureRecord;
  return { st, doors: new PadDoors(hooks), rec, boxes };
}

/** Drive shut until the doors read shut; returns the ticks taken. */
function closeTicks(r: ReturnType<typeof rig>): number {
  r.doors.drive(r.rec, false);
  const t0 = r.st.tick;
  while (!r.doors.shut(r.rec) && r.st.tick - t0 < 100_000) { r.st.tick++; r.st.ms += 1000 / 60; r.doors.drive(r.rec, false); }
  return r.st.tick - t0;
}

describe('PadDoors (teleporter redesign T2)', () => {
  it('an undriven chamber rests open; opening it is a no-op', () => {
    const r = rig('teleporter');
    expect(r.doors.drive(r.rec, true)).toBe(false);
    expect(r.doors.segFor('p1')).toBeUndefined();
    expect(r.doors.shut(r.rec)).toBe(false);
  });

  it('closes on full power in the gate travel time, scrubs the door clip and re-poses the leaf boxes', () => {
    const r = rig('teleporter');
    const open = Float32Array.from(r.boxes);
    expect(r.doors.drive(r.rec, false)).toBe(true);
    const cmd = r.st.posts[0]!;
    expect(cmd.type).toBe('RIG_CLIP');
    const ticks = closeTicks(r);
    expect(ticks).toBe(DOOR_POS_MAX / DOOR_POWER_LEVELS);
    expect(Array.from(r.boxes)).not.toEqual(Array.from(open));
    expect(r.st.active).toContain(true); // a moving door draws full power
    expect(r.st.active[r.st.active.length - 1]).toBe(false); // still once shut
    // and back open: the boxes return to the rest pose
    r.doors.drive(r.rec, true);
    r.st.tick += DOOR_POS_MAX; r.st.ms += 100_000;
    r.doors.drive(r.rec, true);
    expect(doorPosAt(r.doors.segFor('p1')!, r.st.tick)).toBe(DOOR_POS_MAX);
    expect(Array.from(r.boxes)).toEqual(Array.from(open));
  });

  it('closes slower on a weak grid', () => {
    expect(closeTicks(rig('teleporter', 0.5))).toBeGreaterThan(closeTicks(rig('teleporter', 1)));
  });

  it('the Transit Pad (free, no grid) runs at full speed and never touches a grid', () => {
    const r = rig('pocket_pad', 0);
    expect(r.doors.level(r.rec)).toBe(DOOR_POWER_LEVELS);
    expect(closeTicks(r)).toBe(DOOR_POS_MAX / DOOR_POWER_LEVELS);
    expect(r.st.active).toHaveLength(0);
  });

  it('an unpowered chamber stalls (the cycle cancels); a shut one does not', () => {
    const r = rig('teleporter', 0);
    r.doors.drive(r.rec, false);
    expect(r.doors.stalled(r.rec)).toBe(true);
    const p = rig('teleporter', 1);
    closeTicks(p);
    p.st.supply = 0;
    expect(p.doors.stalled(p.rec)).toBe(false);
  });

  it('ignores non-chamber kinds (the Ancients\' gate keeps its iris)', () => {
    const r = rig('alien_gate');
    expect(r.doors.drive(r.rec, false)).toBe(false);
    expect(r.doors.stalled(r.rec)).toBe(false);
    expect(r.st.posts).toHaveLength(0);
  });
});
