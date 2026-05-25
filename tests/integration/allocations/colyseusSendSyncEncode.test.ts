/**
 * PROOF GATE — load-bearing assumption for Phase 1 server snapshot pooling.
 *
 * The `SnapshotScratch` design (one shared `states`/`projectiles`/`drones`/
 * `wrecks` scratch object, mutated through `client.send('snapshot', snap)`
 * for each recipient within a tick) is only safe if Colyseus's `send()`
 * serialises the payload SYNCHRONOUSLY into the WebSocket buffer before
 * returning.
 *
 * This test verifies that. If it fails (i.e., Colyseus retains the object
 * reference), the shared-scratch design collapses and fixes #4-#9 fall back
 * to per-recipient scratch (Map<sessionId, SnapshotScratch>) — 10× the
 * memory at typical room size, still bounded, fully recoverable.
 *
 * Recipe: server calls `client.send('foo', sharedObj)`, then IMMEDIATELY
 * mutates `sharedObj.serverTick = 9999`. Client asserts the original value
 * arrived.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  bootSectorTestServer,
  type SectorTestHarness,
} from '../sectorRoom/harness.js';

describe('Colyseus client.send synchronous encoding', () => {
  let harness: SectorTestHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it('serialises snapshot payloads synchronously into the wire buffer (post-send mutation invisible to client)', async () => {
    harness = await bootSectorTestServer();
    const room = await harness.connectAs('proof-player');
    const serverRoom = harness.getServerRoom();
    expect(serverRoom).not.toBeNull();

    const received: Array<{ serverTick: number; sentinel?: number }> = [];
    room.onMessage<{ serverTick: number; sentinel?: number }>('alloc-probe', (msg) => {
      received.push(msg);
    });

    // The shared scratch — exactly the design we use in SnapshotScratch.
    const sharedScratch: { serverTick: number; sentinel?: number } = { serverTick: 0, sentinel: 100 };

    // Drive 5 round trips. After each `client.send`, mutate the SAME object
    // and confirm the receiver got the pre-mutation value.
    for (let i = 0; i < 5; i++) {
      sharedScratch.serverTick = i;
      sharedScratch.sentinel = i * 10;
      for (const c of serverRoom!.clients) {
        c.send('alloc-probe', sharedScratch);
      }
      // POST-SEND MUTATION — if Colyseus retained the reference, the client
      // would receive 9999, not `i`.
      sharedScratch.serverTick = 9999;
      sharedScratch.sentinel = 9999;
    }

    // Wait for the messages to flush over localhost websocket.
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(received[i]!.serverTick).toBe(i);
      expect(received[i]!.sentinel).toBe(i * 10);
    }
  }, 10_000);
});
