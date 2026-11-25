import { describe, expect, it } from 'vitest';
import { writePadDoorRow } from './doorMotionRow.js';
import { decodeDoorMotion, decodeRigClipIndex, type DoorMotionSeg } from '../../shared-types/structureStateWire.js';
import { DOOR_POS_MAX } from '../../core/structures/gateGeometry.js';
import { rigClipIndex } from '../../core/articulation/rig.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import type { StructureState } from './schema/SectorState.js';

const decode = (st: StructureState): DoorMotionSeg =>
  decodeDoorMotion(st.gateOpen ?? 0, st.rigStart ?? 0, st.rigHold ?? 0, { p0: 0, t0: 0, dir: -1, level: 0 });

describe('writePadDoorRow (teleporter redesign T2)', () => {
  it('no track: the row reads open and still on the door clip', () => {
    for (const kind of ['teleporter', 'teleporter_large', 'pocket_pad']) {
      const st = {} as StructureState;
      writePadDoorRow(undefined, kind, st);
      const seg = decode(st);
      expect(seg.p0).toBe(DOOR_POS_MAX);
      expect(seg.dir).toBe(1);
      expect(seg.level).toBe(0);
      expect(decodeRigClipIndex(st.rigClip ?? 0)).toBe(rigClipIndex(rigForStructureKind(kind)!, 'door'));
    }
  });
  it('carries a closing segment', () => {
    const st = {} as StructureState;
    writePadDoorRow({ p0: 300, t0: 1234, dir: -1, level: 7 }, 'teleporter', st);
    expect(decode(st)).toEqual({ p0: 300, t0: 1234, dir: -1, level: 7 });
  });
});
