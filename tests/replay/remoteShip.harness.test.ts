/**
 * Netgap S1-5: the replay harness carries ONE other player's ship.
 *
 * The real `ColyseusGameClient` replays a captured idle session under the
 * mock clock while the test scripts a remote fighter into every snapshot:
 * a ship flying a straight line on an authoritative "server" PhysicsWorld
 * with thrust held (its input bits ride the snapshot, as on the wire). The
 * harness returns the ship's drawn pose per frame, read as the renderer
 * reads it (the mirror entry: physics pose plus the decaying offset).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type ShipInput } from '../../src/core/physics/World';
import { loadCapture, type TimelineEvent } from './captureLoader';
import { replayCapture, type RemoteShipFeed, type RemoteShipWireState, type ReplayResult } from './captureHarness';

const VG9HON = 'diag/captures/2026-05-20T22-37-34-348Z-vg9hon';
const REMOTE_ID = 'remote-pilot';
const KIND = 'fighter';
/** Off every axis, so a lateral error shows in both x and y. */
const HEADING = 0.6;
/** Far from the local ship, so the two never touch. */
const REMOTE_OFFSET_Y = 3000;
const TICK_S = 1 / 60;
const THRUST: ShipInput = { thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false };
/** The done-when bound: the drawn track stays within one unit of the line. */
const TRACK_TOLERANCE_UNITS = 1;

/** A straight flight on its own server world, stepped lazily to any tick. */
class StraightFlight {
  private tick: number;
  /** The latest true position sent (the far end of the true line). */
  lastX = 0;
  lastY = 0;
  constructor(private readonly server: PhysicsWorld, startTick: number) {
    this.tick = startTick;
  }

  stateAt(serverTick: number): RemoteShipWireState {
    while (this.tick < serverTick) {
      this.server.applyInput(REMOTE_ID, THRUST);
      this.server.tick(TICK_S);
      this.tick++;
    }
    const s = this.server.getShipState(REMOTE_ID)!;
    this.lastX = s.x;
    this.lastY = s.y;
    return {
      x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel ?? 0,
      lastInput: { thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false },
    };
  }
}

describe('replay harness — a remote ship in the snapshots (netgap S1-5)', () => {
  let result: ReplayResult;
  let startX = 0;
  let startY = 0;
  let dirX = 0;
  let dirY = 0;

  beforeAll(async () => {
    await RAPIER.init();
    const cap = loadCapture(VG9HON);
    const first = cap.events.find((e): e is Extract<TimelineEvent, { kind: 'snapshot' }> => e.kind === 'snapshot')!;
    startX = first.data.serverX;
    startY = first.data.serverY + REMOTE_OFFSET_Y;
    const server = await PhysicsWorld.create();
    server.spawnShip(REMOTE_ID, startX, startY, KIND);
    server.setShipState(REMOTE_ID, { x: startX, y: startY, vx: 0, vy: 0, angle: HEADING, angvel: 0 });
    const flight = new StraightFlight(server, first.data.serverTick);
    const feed: RemoteShipFeed = {
      id: REMOTE_ID,
      kind: KIND,
      stateAt: (serverTick) => flight.stateAt(serverTick),
    };
    result = await replayCapture(VG9HON, { remoteShip: feed });
    // The true line: from the start to the last true position, so the test
    // assumes nothing about which way a ship's nose points at an angle.
    const len = Math.hypot(flight.lastX - startX, flight.lastY - startY);
    dirX = (flight.lastX - startX) / len;
    dirY = (flight.lastY - startY) / len;
    server.dispose();
  });

  it('a ship flying straight is drawn within one unit of its line, every frame', () => {
    const frames = result.remoteDrawnPoses.filter((p) => !Number.isNaN(p.physX));
    expect(frames.length).toBeGreaterThan(100);

    let maxLateral = 0;
    let firstAlong = Infinity;
    let lastAlong = -Infinity;
    for (const p of frames) {
      const dx = p.x - startX;
      const dy = p.y - startY;
      maxLateral = Math.max(maxLateral, Math.abs(dx * -dirY + dy * dirX));
      const along = dx * dirX + dy * dirY;
      firstAlong = Math.min(firstAlong, along);
      lastAlong = Math.max(lastAlong, along);
    }
    expect(maxLateral).toBeLessThanOrEqual(TRACK_TOLERANCE_UNITS);
    // It really flew: the drawn track covers a real distance along the line.
    expect(lastAlong - firstAlong).toBeGreaterThan(100);
  });

  it('deliverAtMs holds whole snapshots through a gap and applies them in order on the next frame', async () => {
    const GAP_MS = 400;
    const frames0 = result.remoteDrawnPoses;
    const gapStart = frames0[Math.floor(frames0.length / 2)]!.atMs;
    const gapEnd = gapStart + GAP_MS;
    const server = await PhysicsWorld.create();
    server.spawnShip(REMOTE_ID, startX, startY, KIND);
    server.setShipState(REMOTE_ID, { x: startX, y: startY, vx: 0, vy: 0, angle: HEADING, angvel: 0 });
    const cap = loadCapture(VG9HON);
    const first = cap.events.find((e): e is Extract<TimelineEvent, { kind: 'snapshot' }> => e.kind === 'snapshot')!;
    const flight = new StraightFlight(server, first.data.serverTick);
    let heldCount = 0;
    let lastHeldTick = -1;
    const gapped = await replayCapture(VG9HON, {
      remoteShip: {
        id: REMOTE_ID,
        kind: KIND,
        stateAt: (serverTick) => flight.stateAt(serverTick),
        deliverAtMs: (serverTick, atMs) => {
          if (atMs < gapStart || atMs >= gapEnd) return atMs;
          heldCount++;
          lastHeldTick = serverTick;
          return gapEnd;
        },
      },
    });
    server.dispose();
    expect(heldCount).toBeGreaterThan(2);
    // No snapshot applies inside the gap.
    const inGap = gapped.remoteDrawnPoses.filter((p) => p.atMs >= gapStart && p.atMs < gapEnd);
    expect(inGap.length).toBeGreaterThan(0);
    for (const p of inGap) expect(p.lastAppliedServerTick).toBe(inGap[0]!.lastAppliedServerTick);
    // The first frame at the gap's end has applied every held snapshot.
    const after = gapped.remoteDrawnPoses.find((p) => p.atMs >= gapEnd)!;
    expect(after.lastAppliedServerTick).toBeGreaterThanOrEqual(lastHeldTick);
  });

  it('without a remote ship the trace has no remote frames', async () => {
    const plain = await replayCapture(VG9HON);
    expect(plain.remoteDrawnPoses.length).toBe(0);
    expect(plain.renderedPoses.length).toBe(result.renderedPoses.length);
  });
});
