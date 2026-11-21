/**
 * Solid doors slice 10b: a shut door's leaves block gunfire on the server hit
 * path (the gate's `boxes` gain one box per rig leaf, re-posed from the door
 * position by the GateController). Leaf geometry is read from the rig defs,
 * never copied, so these tests follow the def too.
 */
import { describe, expect, it } from 'vitest';
import { doorLeafCount, gateHitBoxes, writeDoorLeafBoxes } from './doorLeafBoxes.js';
import { GateController } from './GateController.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { rayHitsBox } from '../../core/combat/Weapons.js';
import { AIRLOCK_DOORS_DEF, GATE_DOORS_DEF } from '../../core/articulation/rigs/fences.js';
import type { RigDef } from '../../core/articulation/rig.js';
import { DOOR_POS_MAX, DOOR_TRAVEL_TICKS, gateWorldAxisBoxes } from '../../core/structures/gateGeometry.js';
import { structureHalfExtents } from '../../shared-types/structureKinds.js';

const physicalLeaves = (def: RigDef): number => def.parts.filter((p) => p.kind === 'physical').length;
/** Slide travel of a def's first leaf (its joint max), read from the def. */
const travel = (def: RigDef): number => {
  const j = def.parts[0]!.joint;
  return j.type === 'slide' ? j.max : NaN;
};
/** Anchor y of a def's leaves for the clip named `clip`. */
const endY = (def: RigDef, clip: string): number => {
  const part = def.clips.find((c) => c.id === clip)!.tracks[0]!.part;
  return def.parts.find((p) => p.id === part)!.anchorY;
};

/** A thin shot along +y at x = `x`, from far below a structure at the origin. */
function shotUp(kind: string, boxes: Float32Array, x: number): number | null {
  const ext = structureHalfExtents(kind);
  return rayHitsBox(x, -1000, 0, 1, 2000, 0, 0, ext.hw, ext.hh, boxes);
}

describe('door-leaf hit boxes', () => {
  it('a gate carries one leaf box per physical rig leaf (2), an airlock 4', () => {
    expect(doorLeafCount('shield_gate')).toBe(physicalLeaves(GATE_DOORS_DEF));
    expect(doorLeafCount('shield_airlock')).toBe(physicalLeaves(AIRLOCK_DOORS_DEF));
    expect(doorLeafCount('shield_pylon')).toBe(0);
    const fixed = gateWorldAxisBoxes('shield_gate', 0)!;
    expect(gateHitBoxes('shield_gate', 0)!.length).toBe(fixed.length + 4 * physicalLeaves(GATE_DOORS_DEF));
  });

  it('a shut gate blocks a shot through its gap; a fully open one lets it through', () => {
    const boxes = gateHitBoxes('shield_gate', 0)!; // spawned shut
    expect(shotUp('shield_gate', boxes, 0)).not.toBeNull();
    // Without the leaves the gap is open (the static boxes alone).
    expect(shotUp('shield_gate', gateWorldAxisBoxes('shield_gate', 0)!, 0)).toBeNull();
    writeDoorLeafBoxes('shield_gate', 0, DOOR_POS_MAX, 0, boxes);
    expect(shotUp('shield_gate', boxes, 0)).toBeNull();
    expect(shotUp('shield_gate', boxes, travel(GATE_DOORS_DEF) * 0.5)).toBeNull();
  });

  it('a half-open gate blocks only the part its leaves still cover', () => {
    const boxes = gateHitBoxes('shield_gate', 0)!;
    writeDoorLeafBoxes('shield_gate', 0, DOOR_POS_MAX / 2, 0, boxes);
    const len = travel(GATE_DOORS_DEF);
    expect(shotUp('shield_gate', boxes, 0)).toBeNull(); // centre: uncovered
    expect(shotUp('shield_gate', boxes, len * 0.25)).toBeNull();
    expect(shotUp('shield_gate', boxes, len * 0.75)).not.toBeNull(); // still covered
    expect(shotUp('shield_gate', boxes, -len * 0.75)).not.toBeNull();
  });

  it('a rotated gate turns its leaves with it', () => {
    const boxes = gateHitBoxes('shield_gate', Math.PI / 2)!;
    const ext = structureHalfExtents('shield_gate', 90);
    // The gap now runs along world y: a shot along +x through the centre.
    expect(rayHitsBox(-1000, 0, 1, 0, 2000, 0, 0, ext.hw, ext.hh, boxes)).not.toBeNull();
    writeDoorLeafBoxes('shield_gate', Math.PI / 2, DOOR_POS_MAX, 0, boxes);
    expect(rayHitsBox(-1000, 0, 1, 0, 2000, 0, 0, ext.hw, ext.hh, boxes)).toBeNull();
  });

  it('an airlock: the shut end blocks, the open end passes', () => {
    const boxes = gateHitBoxes('shield_airlock', 0)!;
    const yA = endY(AIRLOCK_DOORS_DEF, 'door-a');
    const yB = endY(AIRLOCK_DOORS_DEF, 'door-b');
    const near = Math.min(yA, yB);
    const far = Math.max(yA, yB);
    // Both shut: the shot stops at the near (lower) end.
    const both = shotUp('shield_airlock', boxes, 0)!;
    expect(both).toBeLessThan(1000 + near);
    // Open the near end only: the shot passes it and stops at the far end.
    const nearIsB = yB < yA;
    writeDoorLeafBoxes('shield_airlock', 0, nearIsB ? 0 : DOOR_POS_MAX, nearIsB ? DOOR_POS_MAX : 0, boxes);
    const d = shotUp('shield_airlock', boxes, 0)!;
    expect(d).toBeGreaterThan(1000 + near);
    expect(d).toBeLessThan(1000 + far);
    // Both open: through.
    writeDoorLeafBoxes('shield_airlock', 0, DOOR_POS_MAX, DOOR_POS_MAX, boxes);
    expect(shotUp('shield_airlock', boxes, 0)).toBeNull();
  });
});

describe('GateController re-poses the leaf boxes', () => {
  it('a gate opening for its owner clears the gap; shut it blocks', () => {
    const registry = new StructureRegistry();
    const g: StructureRecord = {
      id: 'g', owner: 'p1', kind: 'shield_gate', subtypeIndex: 0, x: 0, y: 0, radius: 100,
      isConstructed: true, constructionProgress: 1, constructionCost: 1,
      isDeconstructing: false, minerals: 0, storedPower: 0, level: 1,
    };
    registry.add(g);
    const boxes = gateHitBoxes('shield_gate', 0)!;
    let tick = 0;
    const ship = { y: -2000 };
    const gates = new GateController({
      registry,
      serverTick: () => tick,
      supplyFrac: () => 1,
      setActive: () => {},
      post: () => {},
      hitBoxes: (id) => (id === 'g' ? boxes : undefined),
      collectShips: (out) => {
        out.count = 1;
        out.playerIds[0] = 'p1'; out.xs[0] = 0; out.ys[0] = ship.y; out.radii[0] = 14;
      },
      relationOf: () => 'self',
    });
    gates.update(0);
    expect(shotUp('shield_gate', boxes, 0)).not.toBeNull();
    ship.y = -200; // approach: the door starts opening
    gates.update(100);
    tick = DOOR_TRAVEL_TICKS + 1;
    gates.update(200);
    expect(shotUp('shield_gate', boxes, 0)).toBeNull();
  });
});
