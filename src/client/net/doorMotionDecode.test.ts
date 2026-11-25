/**
 * Teleporter redesign T3 — a chamber pad's blast doors reach the client on
 * the same door row as a gate's (`writePadDoorRow` on the server): the row
 * decodes to `doorA` plus the scrubbed `door` clip predWorld's leaves and the
 * drawn rig pose from. A row with nothing written yet is the REST pose: a
 * chamber open, a gate shut. The Ancients' gate has no doors.
 */
import { describe, expect, it } from 'vitest';
import type { StructureRenderState } from '../../core/contracts/IRenderer.js';
import { doorRestPos } from '../../core/structures/doorLeafBoxes.js';
import { doorClipTime, doorPosAt } from '../../core/structures/doorMotion.js';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, DOOR_TRAVEL_TICKS } from '../../core/structures/gateGeometry.js';
import { encodeDoorMotion, type StructureStateView } from '../../shared-types/structureStateWire.js';
import { decodeDoorRow, isDoorKind } from './doorMotionDecode.js';

function blank(): StructureRenderState {
  return { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 } as unknown as StructureRenderState;
}

describe('door row decode for teleporter chambers (redesign T3)', () => {
  it('every chamber kind is a door kind; the Ancients\' gate is not', () => {
    for (const k of ['teleporter', 'teleporter_large', 'pocket_pad', 'shield_gate', 'shield_airlock']) expect(isDoorKind(k)).toBe(true);
    expect(isDoorKind('alien_gate')).toBe(false);
    expect(isDoorKind(undefined)).toBe(false);
  });

  it('a chamber row with nothing written rests OPEN and still, scrubbed at the clip end', () => {
    for (const kind of ['teleporter', 'teleporter_large', 'pocket_pad']) {
      const out = blank();
      decodeDoorRow({} as StructureStateView, out, kind);
      expect(doorRestPos(kind)).toBe(DOOR_POS_MAX);
      expect(out.doorA).toMatchObject({ p0: DOOR_POS_MAX, dir: 1, level: 0 });
      expect(doorPosAt(out.doorA!, 1e6)).toBe(DOOR_POS_MAX);
      expect(out.doorB).toBeUndefined();
      expect(out.rigClip).toMatchObject({ clipId: 'door', from: doorClipTime(DOOR_POS_MAX), rate: 0 });
    }
  });

  it('a gate row with nothing written still rests shut', () => {
    const out = blank();
    decodeDoorRow({} as StructureStateView, out, 'shield_gate');
    expect(out.doorA).toMatchObject({ p0: 0, dir: -1, level: 0 });
    expect(out.rigClip!.from).toBe(0);
    expect(Math.abs(out.rigClip!.rate!)).toBe(0);
  });

  it('a closing chamber row scrubs its leaves shut along the segment', () => {
    const seg = { p0: DOOR_POS_MAX, t0: 500, dir: -1 as const, level: DOOR_POWER_LEVELS };
    const f = encodeDoorMotion(seg, 0, { rigClip: 0, rigStart: 0, rigHold: 0, gateOpen: 0 });
    const out = blank();
    decodeDoorRow(f, out, 'teleporter');
    expect(out.doorA).toMatchObject(seg);
    expect(doorPosAt(out.doorA!, 500 + DOOR_TRAVEL_TICKS)).toBe(0);
    expect(out.rigClip).toMatchObject({
      clipId: 'door', startTick: 500, from: doorClipTime(DOOR_POS_MAX), rate: doorClipTime(-DOOR_POWER_LEVELS),
    });
  });

  it('the open rest row the server writes decodes the same as no row', () => {
    const f = encodeDoorMotion({ p0: DOOR_POS_MAX, t0: 0, dir: 1, level: 0 }, 0, { rigClip: 0, rigStart: 0, rigHold: 0, gateOpen: 0 });
    const a = blank(), b = blank();
    decodeDoorRow(f, a, 'teleporter');
    decodeDoorRow({} as StructureStateView, b, 'teleporter');
    expect(a.doorA).toEqual(b.doorA);
    expect(a.rigClip).toEqual(b.rigClip);
  });
});
