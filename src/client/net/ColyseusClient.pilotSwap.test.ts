/**
 * Phase 4 WS-A2 — client-side SAME-SECTOR pilot-swap state machine.
 *
 * `pilotInSectorShip(shipId)` sends `pilot_ship` over the live room, despawns the
 * local predWorld body (so the fresh `welcome` re-anchors self-prediction at the
 * new pose — one ownership site, like `resetPredictionState`), and stashes the
 * target shipId. The generic `welcome` handler matches that shipId, leaves
 * spectator (`pilotMode='pilot'`), and arms the camera glide; the RAF loop reads
 * `consumePendingCameraGlide()` (one-shot) to fire the smooth lerp once the new
 * pose is mirrored.
 *
 * These locks exercise the public surface (no live room needed) + reach in for
 * the welcome-driven flags via a narrow structural cast (the same pattern as
 * `ColyseusClient.resetPredictionState.test.ts`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { useUIStore } from '../state/store.js';

type Internals = {
  room: { send: (t: string, p: unknown) => void } | null;
  mirror: {
    localPlayerId: string | null;
    ships: Map<string, { x: number; y: number; angle: number; vx: number; vy: number }>;
  };
  _pendingPilotSwapShipId: string | null;
  _pilotSwapGlidePending: boolean;
};

function asInternals(c: ColyseusGameClient): Internals {
  return c as unknown as Internals;
}

describe('ColyseusGameClient — WS-A2 pilot swap', () => {
  beforeEach(() => {
    useUIStore.setState({ pilotMode: 'pilot' });
  });

  it('pilotInSectorShip is a no-op (false) with no live room', () => {
    const client = new ColyseusGameClient();
    expect(client.pilotInSectorShip('ship-1')).toBe(false);
  });

  it('pilotInSectorShip sends pilot_ship + records the pending swap id', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    const sent: Array<{ t: string; p: unknown }> = [];
    internals.room = { send: (t, p) => sent.push({ t, p }) };

    const ok = client.pilotInSectorShip('ship-target');
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.t).toBe('pilot_ship');
    expect(sent[0]!.p).toEqual({ type: 'pilot_ship', shipId: 'ship-target' });
    expect(internals._pendingPilotSwapShipId).toBe('ship-target');
  });

  it('consumePendingCameraGlide returns the new ship pose ONCE after a swap lands, then null', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    // Simulate the welcome-driven arm: glide pending + the new ship is mirrored.
    internals._pilotSwapGlidePending = true;
    internals.mirror.localPlayerId = 'p1';
    internals.mirror.ships.set('p1', { x: 1234, y: -56, angle: 0, vx: 0, vy: 0 });

    const first = client.consumePendingCameraGlide();
    expect(first).toEqual({ x: 1234, y: -56 });
    // One-shot: the flag is cleared, so a second read is null.
    expect(client.consumePendingCameraGlide()).toBeNull();
  });

  it('consumePendingCameraGlide waits (null) until the new pose is mirrored', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    internals._pilotSwapGlidePending = true;
    internals.mirror.localPlayerId = 'p1';
    // No mirror entry yet → wait (flag stays armed so a later frame fires it).
    expect(client.consumePendingCameraGlide()).toBeNull();
    expect(internals._pilotSwapGlidePending).toBe(true);
    internals.mirror.ships.set('p1', { x: 5, y: 6, angle: 0, vx: 0, vy: 0 });
    expect(client.consumePendingCameraGlide()).toEqual({ x: 5, y: 6 });
  });

  it('returns null with no pending swap', () => {
    const client = new ColyseusGameClient();
    expect(client.consumePendingCameraGlide()).toBeNull();
  });
});
