/**
 * Regression: lingering hull "jitters between two locations" after
 * collision (2026-05-13 smoke-test bug, follow-up to commit `2578eda`).
 *
 * USER REPORTED (verbatim):
 *   "after I hit the lingering ship, it'll sort of jitters between two
 *   locations. We had exactly the same bug with the AI, and I think the
 *   fix was that when you're within the range of interest shedding, you
 *   just honor the pred or something along those lines."
 *
 * The user is pointing at the AI-lockstep dual-correction-path bug
 * (`docs/architecture/ai-lockstep.md`): two paths writing to the same
 * predicted state surface fight each other. For a parked hull the two
 * paths were the snapshot (20 Hz) and `syncMirror` (every Colyseus state
 * patch, ~60 Hz), both re-posing the predWorld body. `syncMirror`'s yank
 * back to the last snapshot pose every ~16 ms made the sprite oscillate.
 *
 * THE FIX (matching the AI lockstep chapter-2 fix): one correction path per
 * state surface. The snapshot owns spawn + ongoing reconcile; `syncMirror`
 * is identity only (kind, displayName, owner, isActive).
 *
 * RTS Part A S3 + blocker B2: a parked hull is an ordinary remote ship in
 * the ONE ship list, keyed by its bare shipInstanceId (no `linger-` body id
 * on the client), and EVERY remote body (other pilots' ships AND hulls)
 * spawns only from a real SNAPSHOT pose (`spawnRemoteShipBodies` →
 * `ensureRemoteShipBody`), never the schema's pose-less (0,0).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ShipRenderState } from '../../core/contracts/IRenderer.js';

interface Internals {
  handleSnapshot(snap: SnapshotMessage): void;
  syncMirror(state: unknown): void;
  predWorld: PhysicsWorld | null;
  mirror: {
    ships: Map<string, ShipRenderState>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function snapshotWith(shipInstanceId: string, x: number, y: number, playerId = 'player-owner', isActive = false): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick: 100,
    ackedTick: 0,
    states: {
      [shipInstanceId]: {
        x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
        playerId,
        isActive,
      },
    },
  };
}

/** A schema-shaped object that mimics Colyseus's `state.ships` map for
 *  `syncMirror`. The schema carries NO pose. */
function stateWith(shipInstanceId: string, playerId = 'player-owner', isActive = false): { ships: Map<string, Record<string, unknown>> } {
  const ships = new Map<string, Record<string, unknown>>();
  ships.set(shipInstanceId, {
    playerId,
    shipInstanceId,
    isActive,
    alive: true,
    kind: 'fighter',
    displayName: 'someone',
  });
  return { ships };
}

describe('lingering hull: snapshot is the sole correction path (no dual-path jitter)', () => {
  let client: ColyseusGameClient;
  let internals: Internals;

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    // Remote bodies spawn only once we know who we are (pre-welcome guard).
    internals.mirror.localPlayerId = 'local-player';
  });

  it('syncMirror does NOT reset body pose after the snapshot has spawned it', () => {
    // Identity first (kind known), then the snapshot spawns the body.
    internals.syncMirror(stateWith('SHIP_X'));
    internals.handleSnapshot(snapshotWith('SHIP_X', 50, 50));
    // The hull body is keyed by the bare shipInstanceId (no `linger-`).
    expect(internals.predWorld!.hasShip('SHIP_X')).toBe(true);
    expect(internals.predWorld!.hasShip('linger-SHIP_X')).toBe(false);
    const pose0 = internals.predWorld!.getShipState('SHIP_X')!;
    expect(pose0.x).toBeCloseTo(50, 1);
    expect(pose0.y).toBeCloseTo(50, 1);

    // The predicted body integrates forward under a collision push.
    internals.predWorld!.setShipState('SHIP_X', {
      x: 75, y: 50, vx: 50, vy: 0, angle: 0, angvel: 0,
    });

    // A state patch (any field) must not touch the body's pose.
    internals.syncMirror(stateWith('SHIP_X'));

    const poseAfterSync = internals.predWorld!.getShipState('SHIP_X')!;
    expect(
      poseAfterSync.x,
      'syncMirror reset the hull body pose: the dual-correction-path jitter bug. syncMirror is identity-only.',
    ).toBeCloseTo(75, 1);
    expect(poseAfterSync.y).toBeCloseTo(50, 1);
  });

  it('syncMirror does NOT spawn a hull body at origin before the first snapshot (no (0,0) ghost); the snapshot path spawns it at the real pose', () => {
    // INVERTED 2026-06-03 (laser "ghost at (0,0)" smoke bug): a body spawned
    // from the schema's pose-less (0,0) seed is an invisible, shootable ghost
    // at world origin that the local beam ray stops on.
    internals.syncMirror(stateWith('SHIP_X'));
    expect(
      internals.predWorld!.hasShip('SHIP_X'),
      'syncMirror spawned a hull body before any snapshot pose arrived (the "laser ghost at origin" bug)',
    ).toBe(false);

    internals.handleSnapshot(snapshotWith('SHIP_X', 120, 80));
    expect(internals.predWorld!.hasShip('SHIP_X')).toBe(true);
    const pose = internals.predWorld!.getShipState('SHIP_X')!;
    expect(pose.x).toBeCloseTo(120, 1);
    expect(pose.y).toBeCloseTo(80, 1);
    // The drawn entry starts at the snapshot pose too, never (0,0).
    const drawn = internals.mirror.ships.get('SHIP_X')!;
    expect(drawn.x).toBeCloseTo(120, 1);
    expect(drawn.isActive).toBe(false);
  });

  it('B2 — another pilot\'s ACTIVE ship also spawns only from its snapshot pose, never the schema (0,0)', () => {
    // The schema diff names the remote pilot first (no pose on the schema).
    internals.syncMirror(stateWith('SID_R', 'remote-pilot', true));
    expect(internals.mirror.ships.has('remote-pilot')).toBe(true);
    expect(
      internals.predWorld!.hasShip('remote-pilot'),
      'a remote pilot body was spawned from the schema diff at (0,0)',
    ).toBe(false);

    internals.handleSnapshot(snapshotWith('SID_R', -300, 40, 'remote-pilot', true));
    expect(internals.predWorld!.hasShip('remote-pilot')).toBe(true);
    const pose = internals.predWorld!.getShipState('remote-pilot')!;
    expect(pose.x).toBeCloseTo(-300, 1);
    expect(pose.y).toBeCloseTo(40, 1);
  });
});
