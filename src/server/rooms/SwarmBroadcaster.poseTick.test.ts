/**
 * Fleet-melee residual pop (review of take 11, after the client tick-stamp
 * fix): about every 14 frames the followed drone jumped ~one step FORWARD
 * along its heading and pulled back. A live probe of the binary swarm wire
 * showed 8.7 % of packets repeat the previous tick and 8.4 % skip one: the
 * room and the physics worker run separate 60 Hz loops, the room reads the
 * SAB tick at the START of its update, and the worker can publish the next
 * step before the encoder reads the poses. That packet then carried tick T+1
 * poses under tick T, and the client (which stamps samples by tick) drew the
 * drone a step ahead for a moment.
 *
 * The packet header must name the tick of the poses it carries: the SAB tick
 * read right before the encode, not the room's tick from earlier in update().
 */
import { describe, it, expect } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import { SwarmBroadcaster } from './SwarmBroadcaster.js';
import { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import { SpatialGrid } from '../interest/SpatialGrid.js';
import type { SnapshotBroadcaster } from './SnapshotBroadcaster.js';
import { SAB_TOTAL_BYTES, TICK_IDX, SLOT_X_OFF, SLOT_VX_OFF, slotBase } from '../../shared-types/sabLayout.js';

describe('SwarmBroadcaster — packet tick is the tick of its poses', () => {
  it('labels a packet with the SAB tick the poses were written at, not the room tick read earlier', () => {
    const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    const f32 = new Float32Array(sab);
    const u32 = new Uint32Array(sab);
    const registry = new SwarmEntityRegistry();
    registry.register('drone-1', 3, 1, 12, 0, 0, 0);
    const sent: Uint8Array[] = [];
    const client = { sessionId: 's1', send: (_t: string, p: Uint8Array) => { sent.push(p.slice()); }, leave: () => {} };
    const roomTick = 100;
    const b = new SwarmBroadcaster({
      serverTick: () => roomTick,
      sabF32: f32,
      sabU32: u32,
      clients: [client] as unknown as ClientArray<Client>,
      sessionToPlayer: new Map(),
      playerToSlot: new Map(),
      interestGrid: new SpatialGrid(),
      swarmRegistry: registry,
      swarmEncoder: new BinarySwarmBroadcast(),
      snapshotBroadcaster: { interestScratch: new Map() } as unknown as SnapshotBroadcaster,
      logger: { warn: () => {} } as unknown as Logger,
    });
    // The room read tick 100 at the top of its update; since then the worker
    // stepped to 101 and wrote that step's poses.
    const base = slotBase(3);
    f32[base + SLOT_X_OFF] = 2.8;
    f32[base + SLOT_VX_OFF] = 168;
    Atomics.store(u32, TICK_IDX, 101);
    b.broadcast();
    expect(sent).toHaveLength(1);
    expect(new DataView(sent[0]!.buffer).getUint32(4, true)).toBe(101);
  });
});
