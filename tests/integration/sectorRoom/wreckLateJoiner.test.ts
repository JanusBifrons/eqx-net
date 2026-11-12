/**
 * Capital destruction S2b — a client that joins AFTER a capital died still
 * sees every wreck (#16: client state is reconstructible from snapshot ∪ join
 * payload; there is no death event to have missed).
 *
 * Real room, real colyseus.js connection: the late joiner's binary `swarm`
 * packets go through the real `decodeSwarmPacket`, its snapshots' `wrecks[]`
 * through the real `WreckGeometryStore`. Every server wreck body must arrive
 * as a kind-4 record and rebuild to the server's exact convex parts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { decodeSwarmPacket } from '../../../src/client/net/BinarySwarmDecoder.js';
import { WreckGeometryStore } from '../../../src/client/net/wreckGeometryStore.js';
import type { RenderMirror } from '../../../src/core/contracts/IRenderer.js';
import type { WreckDescriptor } from '../../../src/shared-types/messages/snapshotMessages.js';

const WRECK_KIND = 4;

describe('SectorRoom integration — late joiner rebuilds capital wrecks (S2b)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a client joining after a capital died receives wrecks[] and rebuilds N pieces matching the server', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true,
    });
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -20_000, spawnY: -20_000 });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    internal.setWreckSeed(7);
    expect(internal.spawnTestDrone('bb', 0, 3000, 'battleship')).toBe(true);
    await harness.advance(100);
    const at = internal.wreckState('bb')!;
    internal.applyDamage('bb', 'shooter-x', 1e7, at.x + 50, at.y);
    const serverPieces = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
    expect(serverPieces.length).toBeGreaterThanOrEqual(2);
    expect(internal.wreckDescriptors()).toHaveLength(1);
    await harness.advance(1500); // well past the change window: only the 2 Hz cadence remains

    // The late joiner, near the wreck so its pieces are in interest.
    const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
    const store = new WreckGeometryStore();
    let gotWrecks: WreckDescriptor[] | undefined;
    const late = await harness.connectAs(randomUUID(), { shipKind: 'fighter', spawnX: 0, spawnY: -500 });
    late.onMessage('swarm', (buf: Uint8Array) => decodeSwarmPacket(buf, mirror));
    late.onMessage('snapshot', (snap: { wrecks?: WreckDescriptor[] }) => {
      if (snap.wrecks !== undefined) {
        gotWrecks = snap.wrecks;
        store.apply(snap.wrecks);
      }
    });
    late.send('client_ready', { type: 'client_ready' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      harness.sendThrust(late); // keep the sector awake so snapshots flow
      const seen = [...(mirror.swarm?.values() ?? [])].filter((e) => e.kind === WRECK_KIND).length;
      if (gotWrecks !== undefined && seen === serverPieces.length) break;
      await harness.advance(100);
    }
    expect(gotWrecks, 'the late joiner got the wrecks[] descriptor').toBeDefined();
    expect(gotWrecks).toHaveLength(1);

    const clientPieces = [...mirror.swarm!.values()].filter((e) => e.kind === WRECK_KIND);
    expect(clientPieces.length, 'every wreck piece rides the binary wire').toBe(serverPieces.length);
    for (const r of serverPieces) {
      const e = mirror.swarm!.get(r.entityId)!;
      expect(e.kind).toBe(WRECK_KIND);
      expect(e.shipKind).toBe('battleship');
      expect(e.wreckId).toBe(gotWrecks![0]!.wreckId);
      expect(e.componentIndex).toBe(r.componentIndex);
      const g = store.piece(e.wreckId!, e.componentIndex!);
      expect(g, `piece ${e.componentIndex} rebuilt on the client`).not.toBeNull();
      expect(g!.parts).toStrictEqual(r.wreckParts);
      expect(Math.fround(g!.radius)).toBe(Math.fround(r.radius));
    }
  }, 20_000);

  it('the test_kill_capitals trigger kills a shielded capital and leaves its wreck', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true,
    });
    const room = await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: 0, spawnY: -1500 });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    expect(internal.spawnTestDrone('bb', 0, 2500, 'battleship')).toBe(true);
    await harness.advance(100);
    room.send('test_kill_capitals', { type: 'test_kill_capitals' });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && internal.swarmRegistry.get('bb')) await harness.advance(50);
    expect(internal.swarmRegistry.get('bb')).toBeFalsy();
    expect(internal.wreckDescriptors()).toHaveLength(1);
  }, 20_000);
});
