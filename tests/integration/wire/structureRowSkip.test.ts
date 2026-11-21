/**
 * Perf (Sol Prime profile): `syncStructures` runs every snapshot and used to
 * re-decode EVERY room-state structure row, changed or not. Counts the decodes
 * through the REAL schema encoder/decoder (the bytes a client receives): an
 * unchanged row is decoded once, a changed row (field or `connTo` entry) is
 * decoded again, and the mirror still converges from room state alone (#16).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decoder, Encoder } from '@colyseus/schema';
import type { RenderMirror, SwarmRenderState } from '../../../src/core/contracts/IRenderer.js';
import { SectorState, StructureState } from '../../../src/server/rooms/schema/SectorState.js';
import { STRUCTURE_FLAG_BUILT, STRUCTURE_FLAG_POWERED } from '../../../src/shared-types/structureStateWire.js';

const decodes = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../../src/client/net/structureStateDecode.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/client/net/structureStateDecode.js')>();
  return {
    ...mod,
    decodeStructureState: (...args: Parameters<typeof mod.decodeStructureState>) => {
      decodes.n++;
      mod.decodeStructureState(...args);
    },
  };
});

const { StructureRowSync } = await import('../../../src/client/net/mirror/structureRowSync.js');

const N = 40;
const K = 10;

function setup() {
  const server = new SectorState();
  server.structureOwners.set('0', 'p1');
  server.structureOwnerNames.set('0', 'Ada');
  for (let i = 1; i <= N; i++) {
    const st = new StructureState();
    st.ownerIdx = 0;
    st.flags = STRUCTURE_FLAG_BUILT;
    st.hpPct = 100;
    st.connTo.push(i === N ? 1 : i + 1);
    server.structures.set(String(i), st);
  }
  const encoder = new Encoder(server);
  const client = new SectorState();
  const decoder = new Decoder(client);
  decoder.decode(encoder.encodeAll());
  encoder.discardChanges();
  const swarm = new Map<number, SwarmRenderState>();
  const mirror = { swarm } as unknown as RenderMirror;
  const room = { state: client, serializer: { decoder } };
  const sync = new StructureRowSync(mirror, { ids: [], names: [] });
  /** One server patch (possibly empty) decoded client-side, then a snapshot. */
  const apply = (): void => {
    const patch = encoder.encode();
    encoder.discardChanges();
    if (patch.byteLength > 0) decoder.decode(patch);
    sync.sync(room);
  };
  return { server, mirror, apply };
}

describe('StructureRowSync — unchanged rows skip the decode', () => {
  beforeEach(() => { decodes.n = 0; });

  it(`${N} structures, ${K} snapshots with no row change → ${N} decodes, not ${N * K}`, () => {
    const { mirror, apply } = setup();
    for (let k = 0; k < K; k++) apply();
    expect(decodes.n).toBe(N);
    expect(mirror.structures!.size).toBe(N);
    expect(mirror.structures!.get(3)!.ownerName).toBe('Ada');
  });

  it('a changed field re-decodes only that row, and the mirror reads the new value', () => {
    const { server, mirror, apply } = setup();
    apply();
    decodes.n = 0;
    server.structures.get('5')!.flags = STRUCTURE_FLAG_BUILT | STRUCTURE_FLAG_POWERED;
    apply();
    expect(decodes.n).toBe(1);
    expect(mirror.structures!.get(5)!.powered).toBe(true);
    apply();
    expect(decodes.n).toBe(1);
  });

  it('a changed connTo entry (child array) re-decodes its row', () => {
    const { server, mirror, apply } = setup();
    apply();
    decodes.n = 0;
    server.structures.get('7')!.connTo.push(20);
    apply();
    expect(decodes.n).toBe(1);
    expect(mirror.structures!.get(7)!.connTo).toEqual([8, 20]);
  });

  it('a new owner name re-decodes every row (ownerName comes from the owner table)', () => {
    const { server, mirror, apply } = setup();
    apply();
    decodes.n = 0;
    server.structureOwnerNames.set('0', 'Bea');
    apply();
    expect(decodes.n).toBe(N);
    expect(mirror.structures!.get(1)!.ownerName).toBe('Bea');
  });

  it('a row whose kind becomes known later is re-decoded once; a removed row is swept', () => {
    const { server, mirror, apply } = setup();
    apply();
    decodes.n = 0;
    (mirror.swarm as Map<number, SwarmRenderState>).set(2, { kind: 2, shipKind: 'battery' } as SwarmRenderState);
    apply();
    apply();
    expect(decodes.n).toBe(1);
    server.structures.delete('2');
    apply();
    expect(mirror.structures!.has(2)).toBe(false);
    expect(mirror.swarm!.has(2)).toBe(false);
  });

  it('without a schema change feed every row is decoded every snapshot (pre-fix behaviour)', () => {
    const { mirror } = setup();
    const server = new SectorState();
    const st = new StructureState();
    st.connTo.push(1);
    server.structures.set('1', st);
    const client = new SectorState();
    new Decoder(client).decode(new Encoder(server).encodeAll());
    const sync = new StructureRowSync(mirror, { ids: [], names: [] });
    decodes.n = 0;
    for (let k = 0; k < 3; k++) sync.sync({ state: client });
    expect(decodes.n).toBe(3);
  });
});
