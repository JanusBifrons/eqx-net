/**
 * Build mirror (base loop job 4A): a building can be placed mirrored
 * (left-right flipped). Mirror is x → −x in the structure's LOCAL frame,
 * applied BEFORE the quarter-turn rotation, by the one shared transform
 * (`structureLocalToWorld`) every shape rule reads. Here: socket and
 * keep-clear world positions of a mirrored building are the flip of the
 * unmirrored ones, and the flag rides the room-state `flags` to the client.
 */
import { describe, it, expect } from 'vitest';
import {
  structureLocalToWorld,
  structureSockets,
  structureSocketToWorld,
  type MutStructureSocket,
} from '../../src/shared-types/structureKinds.js';
import { keepClearBox, placementRejection } from '../../src/core/structures/placementRules.js';
import { STRUCTURE_FLAG_BUILT, STRUCTURE_FLAG_MIRROR } from '../../src/shared-types/structureStateWire.js';
import { decodeStructureState, emptyStructureRow } from '../../src/client/net/structureStateDecode.js';
import { PlaceStructureSchema } from '../../src/shared-types/messages.js';

const CX = 1000, CY = -400;

function sock(): MutStructureSocket {
  return { x: 0, y: 0, nx: 0, ny: 0 };
}

describe('build mirror — the shared local→world transform (4A)', () => {
  it('flips local x before rotating (an asymmetric point)', () => {
    const out = { x: 0, y: 0 };
    structureLocalToWorld(30, 10, CX, CY, 1, 0, true, out);
    expect(out).toEqual({ x: CX - 30, y: CY + 10 });
    // Rot 90 (cos 0, sin 1): the mirrored local (−30, 10) turns to (−10, −30).
    structureLocalToWorld(30, 10, CX, CY, 0, 1, true, out);
    expect(out).toEqual({ x: CX - 10, y: CY - 30 });
    structureLocalToWorld(30, 10, CX, CY, 0, 1, false, out);
    expect(out).toEqual({ x: CX - 10, y: CY + 30 });
  });

  it("a mirrored building's sockets are the x-flip of the unmirrored ones (rot 0)", () => {
    const list = structureSockets('refinery');
    expect(list.length).toBeGreaterThan(0);
    const a = sock(), b = sock();
    let asymmetric = false;
    for (const s of list) {
      structureSocketToWorld(s, CX, CY, 0, a);
      structureSocketToWorld(s, CX, CY, 0, b, true);
      expect(b.x).toBeCloseTo(2 * CX - a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.nx).toBeCloseTo(-a.nx, 6);
      expect(b.ny).toBeCloseTo(a.ny, 6);
      if (Math.abs(s.x) > 1e-6) asymmetric = true;
    }
    expect(asymmetric, 'some socket sits off the centre line').toBe(true);
  });

  it('at a quarter turn the flip is across the rotated local y axis (world y flips)', () => {
    const a = sock(), b = sock();
    for (const s of structureSockets('refinery')) {
      structureSocketToWorld(s, CX, CY, Math.PI / 2, a);
      structureSocketToWorld(s, CX, CY, Math.PI / 2, b, true);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(2 * CY - a.y, 6);
    }
  });

  it('keep-clear pads go through the same transform (mirror flips the pad offset)', () => {
    for (const rot of [0, 90, 180, 270]) {
      const plain = { ...keepClearBox('capital', CX, CY, rot)! };
      const flipped = { ...keepClearBox('capital', CX, CY, rot, true)! };
      expect(flipped.hw).toBe(plain.hw);
      expect(flipped.hh).toBe(plain.hh);
      // The pad's local offset (cx, cy) maps through structureLocalToWorld.
      if (rot % 180 === 0) {
        expect(flipped.x).toBeCloseTo(2 * CX - plain.x, 6);
        expect(flipped.y).toBeCloseTo(plain.y, 6);
      } else {
        expect(flipped.x).toBeCloseTo(plain.x, 6);
        expect(flipped.y).toBeCloseTo(2 * CY - plain.y, 6);
      }
    }
  });

  it('placementRejection accepts the mirror flag for both the new and the placed building', () => {
    const placed = [{ x: 0, y: 0, radius: 100, kind: 'capital', rot: 0, mirror: true }];
    expect(placementRejection('solar', 50_000, 0, placed, null, 0, true)).toBeNull();
  });
});

describe('build mirror — the flag on the wire (4A)', () => {
  it('place_structure accepts an optional boolean mirror (strict schema)', () => {
    expect(PlaceStructureSchema.safeParse({ type: 'place_structure', kind: 'solar', x: 0, y: 0, rot: 90, mirror: true }).success).toBe(true);
    expect(PlaceStructureSchema.safeParse({ type: 'place_structure', kind: 'solar', x: 0, y: 0 }).success).toBe(true);
    expect(PlaceStructureSchema.safeParse({ type: 'place_structure', kind: 'solar', x: 0, y: 0, mirror: 1 }).success).toBe(false);
  });

  it('the client decodes the mirror bit from flags (and leaves it absent when clear)', () => {
    const on = emptyStructureRow();
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT | STRUCTURE_FLAG_MIRROR, connTo: [] }, { ids: [], names: [] }, on, 'solar');
    expect(on.mirror).toBe(true);
    const off = emptyStructureRow();
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT, connTo: [] }, { ids: [], names: [] }, off, 'solar');
    expect(off.mirror).toBeUndefined();
  });

  it('the mirror bit is the free top bit of the uint16 flags field', () => {
    expect(STRUCTURE_FLAG_MIRROR).toBe(32768);
  });
});
