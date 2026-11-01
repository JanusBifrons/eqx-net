/**
 * A2 two-sided contract (invariant #15; plan soft-leaping-truffle v2).
 *
 * Structure grid state moved from the per-snapshot slice into Colyseus room
 * state. This test round-trips server `StructureState` rows through the REAL
 * schema encoder/decoder (the same bytes a client receives) and decodes them
 * with the client's `decodeStructureState`, asserting the mirror row equals
 * what the pre-A2 slice produced for the same structure — including the
 * quantisation (float32 net power, 0-100 hp percent) and the "absent"
 * conventions the renderer and inspector rely on.
 */
import { describe, expect, it } from 'vitest';
import { Decoder, Encoder } from '@colyseus/schema';
import { SectorState, StructureState } from '../../../src/server/rooms/schema/SectorState.js';
import { decodeStructureState, emptyStructureRow } from '../../../src/client/net/structureStateDecode.js';

const OWNERS = { ids: ['p1'], names: ['Ada'] };
const OWNERS_UNRESOLVED = { ids: ['p1'], names: [''] };
import {
  STRUCTURE_ETA_NONE,
  STRUCTURE_ETA_STALLED,
  STRUCTURE_FLAG_BUILT,
  STRUCTURE_FLAG_DECONSTRUCTING,
  STRUCTURE_FLAG_POWERED,
  STRUCTURE_FLAG_WALL_ACTIVE,
} from '../../../src/shared-types/structureStateWire.js';

function row(fields: Partial<StructureState> & { connTo?: number[] }): StructureState {
  const st = new StructureState();
  const { connTo, ...rest } = fields;
  Object.assign(st, rest);
  for (const c of connTo ?? []) st.connTo.push(c);
  return st;
}

function roundTrip(rows: Record<string, StructureState>): SectorState {
  const server = new SectorState();
  for (const [k, v] of Object.entries(rows)) server.structures.set(k, v);
  const bytes = new Encoder(server).encodeAll();
  const client = new SectorState();
  new Decoder(client).decode(bytes);
  return client;
}

describe('structure room-state wire — server row → client mirror row', () => {
  it('a built, powered battery decodes exactly like the pre-A2 slice row', () => {
    const c = roundTrip({
      '42': row({
        flags: STRUCTURE_FLAG_BUILT | STRUCTURE_FLAG_POWERED,
        hpPct: 87, level: 2, netPower: 37.5, minerals: 0, storedPower: 120, storedPowerMax: 300,
        shieldWallTo: -1, etaMs: STRUCTURE_ETA_NONE, connTo: [7, 9],
      }),
    });
    const out = emptyStructureRow();
    decodeStructureState(c.structures.get('42')!, OWNERS, out);
    expect(out).toEqual({
      powered: true, netPower: 37.5, connTo: [7, 9], hpPct: 0.87, built: true, buildPct: 1,
      etaMs: undefined, deconstructPct: 0, isDeconstructing: undefined, minerals: undefined,
      storedPower: 120, storedPowerMax: 300, shieldWallTo: undefined, wallActive: undefined,
      owner: 'p1', ownerName: 'Ada', level: 2,
    });
  });

  it('a blueprint carries its build fraction and ETA; a stalled one reads null', () => {
    const c = roundTrip({
      '5': row({ flags: 0, hpPct: 10, buildPct: 0.25, etaMs: 12_000 }),
      '6': row({ flags: 0, hpPct: 10, buildPct: 0, etaMs: STRUCTURE_ETA_STALLED }),
    });
    const a = emptyStructureRow();
    decodeStructureState(c.structures.get('5')!, OWNERS_UNRESOLVED, a);
    expect(a.built).toBe(false);
    expect(a.buildPct).toBeCloseTo(0.25, 6);
    expect(a.etaMs).toBe(12_000);
    expect(a.ownerName).toBeUndefined(); // '' ⇒ unresolved owner
    expect(a.level).toBeUndefined(); // 1 ⇒ absent
    const b = emptyStructureRow();
    decodeStructureState(c.structures.get('6')!, OWNERS, b);
    expect(b.etaMs).toBeNull();
  });

  it('a pylon with an active wall, a deconstructing capital with minerals', () => {
    const c = roundTrip({
      '8': row({ flags: STRUCTURE_FLAG_BUILT | STRUCTURE_FLAG_POWERED | STRUCTURE_FLAG_WALL_ACTIVE, shieldWallTo: 11 }),
      '1': row({ flags: STRUCTURE_FLAG_BUILT | STRUCTURE_FLAG_DECONSTRUCTING, minerals: 4999.5, deconstructPct: 0.4 }),
    });
    const p = emptyStructureRow();
    decodeStructureState(c.structures.get('8')!, OWNERS, p);
    expect(p.shieldWallTo).toBe(11);
    expect(p.wallActive).toBe(true);
    const k = emptyStructureRow();
    decodeStructureState(c.structures.get('1')!, OWNERS, k);
    expect(k.isDeconstructing).toBe(true);
    expect(k.deconstructPct).toBeCloseTo(0.4, 6);
    expect(k.minerals).toBe(4999.5);
    expect(k.powered).toBe(false);
  });

  it('decoding into an existing row overwrites stale fields (in-place reuse)', () => {
    const c = roundTrip({
      '3': row({ flags: STRUCTURE_FLAG_BUILT, storedPowerMax: 0, shieldWallTo: -1 }),
    });
    const out = emptyStructureRow();
    out.storedPower = 50;
    out.storedPowerMax = 300;
    out.shieldWallTo = 4;
    out.wallActive = true;
    out.connTo.push(1, 2, 3);
    decodeStructureState(c.structures.get('3')!, OWNERS, out);
    expect(out.storedPower).toBeUndefined();
    expect(out.shieldWallTo).toBeUndefined();
    expect(out.connTo).toEqual([]);
  });
});
