/**
 * Redesign T3 — the warp route check poses a door kind's leaves from its
 * decoded row, and with no door decoded at the kind's REST pose
 * (`doorRestPos`): a teleporter chamber stands open, a gate shut.
 */
import { describe, expect, it } from 'vitest';
import { gateHitBoxes, writeDoorLeafBoxes } from '../../core/structures/doorLeafBoxes.js';
import type { WarpStructureFootprint } from '../../core/nav/warpLineStop.js';
import { DOOR_POS_MAX } from '../../core/structures/gateGeometry.js';
import { WarpRouteClient, type WarpRouteRow, type WarpRouteSwarmEntry } from './warpRoute.js';

function boxesOf(kind: string, row: WarpRouteRow): Float32Array {
  const c = new WarpRouteClient().gather({
    structures: new Map([[1, row]]),
    swarm: new Map<number, WarpRouteSwarmEntry>([[1, { x: 0, y: 0, angle: 0, shipKind: kind }]]),
    rigTick: 1000,
  });
  const out: WarpStructureFootprint = { x: 0, y: 0, halfW: 0, halfH: 0, boxes: undefined };
  c.footprint(0, out);
  return Float32Array.from(out.boxes!);
}

function posed(kind: string, pos: number): Float32Array {
  const b = gateHitBoxes(kind, 0)!;
  writeDoorLeafBoxes(kind, 0, pos, pos, b);
  return b;
}

describe('warp route door poses (redesign T3)', () => {
  it('a chamber with no door row reads its doors OPEN (rest), not shut', () => {
    for (const kind of ['teleporter', 'teleporter_large', 'pocket_pad']) {
      const got = boxesOf(kind, {});
      expect(got).toEqual(posed(kind, DOOR_POS_MAX));
      expect(got).not.toEqual(posed(kind, 0));
    }
  });

  it('a chamber with a shut door row reads shut', () => {
    expect(boxesOf('teleporter', { doorA: { p0: 0, t0: 0, dir: -1, level: 0 } })).toEqual(posed('teleporter', 0));
  });

  it('a gate with no door row still reads shut', () => {
    expect(boxesOf('shield_gate', {})).toEqual(posed('shield_gate', 0));
  });
});
