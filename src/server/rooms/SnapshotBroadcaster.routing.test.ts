/**
 * Phase 1 step 4 — SnapshotBroadcaster routing seam (failing-first).
 *
 * The Phase 1 routing decision lives in WebRtcChannelManager. The seam
 * inside SnapshotBroadcaster is small: the per-recipient hot loop must
 * call the dep-injected `sendSnapshot` callback for each client; the
 * callback is responsible for choosing DC vs WS. When the callback is
 * not provided, the broadcaster falls back to `client.send('snapshot', snap)`
 * — that's the pre-Phase-1 behaviour.
 *
 * Coverage:
 *   - Default behaviour (no callback): per-client `client.send` is invoked.
 *   - With callback (Phase 1 wiring): the callback receives each recipient
 *     + the same snap message that would have gone to `client.send`.
 *   - Callback never throws into the broadcast loop — wrapping is the
 *     broadcaster's responsibility, not the caller's.
 *
 * Plan: swift-otter (Phase 1).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from './SnapshotBroadcaster.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface FakeClient {
  sessionId: string;
  socket?: { bufferedAmount?: number };
  send: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
}

function makeFakeClient(sessionId: string): FakeClient {
  return {
    sessionId,
    socket: { bufferedAmount: 0 },
    send: vi.fn(),
    leave: vi.fn(),
  };
}

function makeBaseDeps(playerCount: number): { deps: SnapshotBroadcasterDeps; clients: FakeClient[] } {
  const sabU32 = new Uint32Array(1024);
  const playerToSlot = new Map<string, number>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const ships = new Map<string, ShipState>();
  const sessionToPlayer = new Map<string, string>();
  const clients: FakeClient[] = [];

  for (let i = 0; i < playerCount; i++) {
    const pid = `p${i}`;
    const sid = `s${i}`;
    playerToSlot.set(pid, i);
    sessionToPlayer.set(sid, pid);
    const pose: ShipPhysicsState = { x: i * 10, y: i * 10, vx: 0, vy: 0, angle: 0, angvel: 0 };
    shipPoseCache.set(pid, pose);
    ships.set(pid, {
      alive: true,
      isActive: true,
      shipInstanceId: `inst-${pid}`,
      playerId: pid,
    } as unknown as ShipState);
    clients.push(makeFakeClient(sid));
  }

  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {},
    child: () => stubLogger,
  } as unknown as Logger;

  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => 100,
    sabU32,
    clients: clients as unknown as ClientArray<Client>,
    sessionToPlayer,
    playerToSlot,
    getActiveShip: (pid: string) => ships.get(pid),
    shipPoseCache,
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    shipsMap: ships as unknown as MapSchema<ShipState>,
    liveProjectiles: new Map() as unknown as SnapshotBroadcasterDeps['liveProjectiles'],
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    swarmRegistry: { getByEntityId: () => null },
    playerMountAngles: new Map(),
    droneMountAngles: new Map(),
    missileSim: { live: function* () { /* empty */ } },
    logger: stubLogger,
    serverLogEvent: () => {},
  };

  return { deps, clients };
}

// Drive enough broadcasts that at least one recipient passes the
// 20 Hz per-client phase gate.
function runUntilSent(broadcaster: SnapshotBroadcaster, maxCalls = 60): void {
  for (let i = 0; i < maxCalls; i++) broadcaster.broadcast(false);
}

describe('SnapshotBroadcaster routing seam (Phase 1)', () => {
  it('default behaviour: client.send is called for each recipient', () => {
    const { deps, clients } = makeBaseDeps(2);
    const broadcaster = new SnapshotBroadcaster(deps);
    runUntilSent(broadcaster);
    expect(clients[0]!.send).toHaveBeenCalled();
    expect(clients[1]!.send).toHaveBeenCalled();
    const args = clients[0]!.send.mock.calls[0];
    expect(args?.[0]).toBe('snapshot');
    expect((args?.[1] as SnapshotMessage)?.type).toBe('snapshot');
  });

  it('with sendSnapshot dep: callback is invoked per recipient INSTEAD of client.send', () => {
    const { deps, clients } = makeBaseDeps(2);
    const sendSnapshot = vi.fn();
    const broadcaster = new SnapshotBroadcaster({ ...deps, sendSnapshot });
    runUntilSent(broadcaster);
    expect(sendSnapshot).toHaveBeenCalled();
    expect(clients[0]!.send).not.toHaveBeenCalled();
    expect(clients[1]!.send).not.toHaveBeenCalled();
    const firstCall = sendSnapshot.mock.calls[0];
    expect((firstCall?.[0] as { sessionId: string })?.sessionId).toMatch(/^s\d$/);
    expect((firstCall?.[1] as SnapshotMessage)?.type).toBe('snapshot');
  });

  it('sendSnapshot callback that throws does NOT crash the broadcast loop', () => {
    const { deps, clients } = makeBaseDeps(2);
    const sendSnapshot = vi.fn(() => { throw new Error('mock throw'); });
    const broadcaster = new SnapshotBroadcaster({ ...deps, sendSnapshot });
    expect(() => runUntilSent(broadcaster)).not.toThrow();
    // Even when the callback throws, BOTH recipients should have been
    // attempted (i.e. the loop continued after the first throw).
    expect(sendSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(clients[0]!.leave).not.toHaveBeenCalled();
  });
});
