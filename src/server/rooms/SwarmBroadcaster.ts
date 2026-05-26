/**
 * Per-client binary swarm packet encode + send.
 *
 * Runs every server tick (60 Hz) — the encoder returns null when no
 * pose has changed past the quantisation epsilon (or when not at the
 * every-60th-tick full-snapshot), so the wire cost is dominated by the
 * full-snapshot keyframe + rare-but-real motion deltas.
 *
 * Per-client encoding (Phase 5d): the spatial grid's 9-cell interest
 * window scopes the entity set the encoder serialises. Out-of-interest
 * entities still ship at decimated cadence inside the encoder. The
 * 9-cell scratch Set populated here is REUSED by SnapshotBroadcaster's
 * per-client drone slice — same interest, no second `query9` call.
 *
 * Extracted from SectorRoom (commit 22 partial).
 */

import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { checkBackpressure } from '../net/Backpressure.js';
import type { SpatialGrid } from '../interest/SpatialGrid.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import type { SnapshotBroadcaster } from './SnapshotBroadcaster.js';

export interface SwarmBroadcasterDeps {
  serverTick: () => number;
  sabF32: Float32Array;
  sabU32: Uint32Array;
  clients: ClientArray<Client>;
  sessionToPlayer: Map<string, string>;
  playerToSlot: Map<string, number>;
  interestGrid: SpatialGrid;
  swarmRegistry: SwarmEntityRegistry;
  swarmEncoder: BinarySwarmBroadcast;
  /** Snapshot broadcaster owns the interestScratch map. The 9-cell sets
   *  populated here are reused by its per-client drone slice. */
  snapshotBroadcaster: SnapshotBroadcaster;
  logger: Logger;
}

export class SwarmBroadcaster {
  constructor(private readonly deps: SwarmBroadcasterDeps) {}

  broadcast(): void {
    const d = this.deps;
    const serverTick = d.serverTick();
    if (serverTick <= 0 || d.clients.length === 0) return;
    for (const client of d.clients) {
      const bp = checkBackpressure(client, d.logger);
      if (bp === 'close') { client.leave(4002); continue; }
      if (bp === 'drop') continue;

      const playerId = d.sessionToPlayer.get(client.sessionId);
      const slot = playerId !== undefined ? d.playerToSlot.get(playerId) : undefined;
      let inInterest: Set<number> | undefined;
      if (slot !== undefined) {
        const b = slotBase(slot);
        const sx = d.sabF32[b + SLOT_X_OFF]!;
        const sy = d.sabF32[b + SLOT_Y_OFF]!;
        const { cx, cy } = d.interestGrid.cellOf(sx, sy);
        let scratch = d.snapshotBroadcaster.interestScratch.get(client.sessionId);
        if (!scratch) {
          scratch = new Set<number>();
          d.snapshotBroadcaster.interestScratch.set(client.sessionId, scratch);
        }
        d.interestGrid.query9(cx, cy, scratch);
        inInterest = scratch;
      }
      const swarmPacket = d.swarmEncoder.encode(d.swarmRegistry, d.sabF32, d.sabU32, serverTick, inInterest);
      if (swarmPacket) client.send('swarm', swarmPacket);
    }
  }
}
