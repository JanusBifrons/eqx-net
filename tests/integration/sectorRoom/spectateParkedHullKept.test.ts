/**
 * Spectate: the parked hull stays in the client's lingering list.
 *
 * Context (CI, train #528 and #529, `spectator-mode.spec.ts`, every retry,
 * never locally): in `test-sector-fast` the own parked hull appeared in
 * `mirror.lingeringShips` 10 ms after Spectate and was gone 600 ms later.
 * The client's snapshot router evicts any lingering hull missing from ONE
 * snapshot, so this locks both sides of the wire in a live room: every
 * server snapshot after Spectate carries the parked hull (isActive=false) and
 * the REAL client router keeps it listed. Read snap.states BEFORE
 * handleSnapshot: the router moves parked hulls out of it in place.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import { ColyseusGameClient } from '../../../src/client/net/ColyseusClient.js';
import { PhysicsWorld } from '../../../src/core/physics/World.js';
import { useUIStore } from '../../../src/client/state/store.js';

interface ClientInternals {
  predWorld: PhysicsWorld | null;
  room: unknown;
  mirror: {
    localPlayerId: string | null;
    localShipInstanceId?: string | null;
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    lingeringShips?: Map<string, { ownerPlayerId?: string }>;
  };
  syncMirror(state: unknown): void;
  handleSnapshot(snap: SnapshotMessage): void;
  tryInitPredWorld(playerId: string): void;
}

describe('spectate: the parked hull stays listed', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('every snapshot after Spectate carries the parked hull, and the client keeps it', { timeout: 40_000 }, async () => {
    // One distant drone keeps the room ticking: in this harness a room with
    // no drones and no rocks advances only ~45 ticks in 4 s and sends no
    // snapshots at all (pre-dates the time-scale stream; harness quirk).
    harness = await bootSectorTestServer({ asteroidConfig: [], dronePoses: [{ kind: 'robot-circle', x: 0, y: 3000, hullExposed: true }] });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {});

    useUIStore.setState({ pilotMode: 'pilot' });
    const client = new ColyseusGameClient();
    const c = client as unknown as ClientInternals;
    c.predWorld = await PhysicsWorld.create();
    c.room = cr;
    if (!c.mirror.lingeringShips) c.mirror.lingeringShips = new Map();
    const state = cr.state as unknown as { ships: Map<string, { playerId: string; kind: string }> };
    let instanceId = '';
    let kind = 'fighter';
    for (const [key, ship] of state.ships) if (ship.playerId === pid) { instanceId = key; kind = ship.kind; }
    expect(instanceId, 'own schema entry').not.toBe('');
    c.mirror.localPlayerId = pid;
    c.mirror.localShipInstanceId = instanceId;
    c.mirror.ships.set(pid, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind });
    c.tryInitPredWorld(pid);

    let spectated = false;
    let snapsAfter = 0;
    const missingFromSnap: number[] = [];
    const missingOnClient: number[] = [];
    let snapsTotal = 0;
    const throws: string[] = [];
    cr.onStateChange((s) => { try { c.syncMirror(s); } catch (e) { if (throws.length < 3) throws.push('sync: ' + String((e as Error).stack ?? e).slice(0, 400)); } });
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      snapsTotal++;
      // Read the wire BEFORE the client router: handleSnapshot moves parked
      // hulls out of snap.states in place.
      let inSnap = false;
      if (spectated) for (const id in snap.states) if (snap.states[id]!.playerId === pid && snap.states[id]!.isActive === false) inSnap = true;
      try { c.handleSnapshot(snap); } catch (e) { if (throws.length < 3) throws.push(String((e as Error).stack ?? e).slice(0, 400)); }
      if (!spectated) return;
      snapsAfter++;
      if (!inSnap) missingFromSnap.push(snap.serverTick);
      let listed = false;
      for (const e of c.mirror.lingeringShips!.values()) if (e.ownerPlayerId === pid) listed = true;
      if (!listed) missingOnClient.push(snap.serverTick);
    });

    useUIStore.setState({ pilotMode: 'spectator' });
    client.sendSpectate();
    await harness.advance(500); // the parking patch lands
    spectated = true;
    await harness.advance(3000);

    expect(throws, 'handleSnapshot threw').toEqual([]);
    expect(snapsAfter, `snapshots flowing (total ${snapsTotal})`).toBeGreaterThan(20);
    expect(missingFromSnap, 'server snapshots without the parked hull (ticks)').toEqual([]);
    expect(missingOnClient, 'client lost the parked hull after these snapshots (ticks)').toEqual([]);
  });
});
