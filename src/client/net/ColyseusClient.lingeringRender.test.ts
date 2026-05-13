/**
 * User report 2026-05-13 (diagnostic 18-43-02-926Z-ktiqcd, refined
 * by chat clarification):
 *   "I still don't collide with the lingering ships."
 *   "It's rendered wrong then obviously."
 *   "The entire bug was that the ship didn't move, and it should. I
 *    could just fly through it."
 *
 * Root cause (Invariant #13 — repro test goes in BEFORE the fix):
 *
 * `mirror.lingeringShips[id].x, y` is only ever written from
 * `handleSnapshot` / `syncMirror` — snapshot pose, ~20 Hz. The
 * predWorld body for `linger-${id}` integrates physics at the 60 Hz
 * frame rate (it's a dynamic body — and lingering hulls SHOULD be
 * pushable like any other ship; that's how players interact with
 * abandoned hulls in space). Between snapshots, the body's position
 * diverges from the mirror entry: the sprite stays at the last
 * snapshot pose while the body moves under physics. Collision
 * detection uses the BODY position; the player visually navigates
 * toward the SPRITE position. They diverge → the player flies
 * "through" where the sprite is and the body is somewhere else.
 *
 * Contrast: ACTIVE ships' mirror entries ARE rewritten from
 * predWorld every frame (see `ColyseusClient.updateMirror`'s
 * `this.mirror.ships.set(localId, { x: state.x + ox, ... })` block
 * around line 2310). Lingering hulls need the same pattern — their
 * mirror entry must reflect the body's CURRENT physics-integrated
 * position, not the stale snapshot pose.
 *
 * This test asserts the contract:
 *
 *   After `updateMirror()` runs, `mirror.lingeringShips[id].x, y`
 *   must equal `predWorld.getShipState(\`linger-${id}\`).x, y`.
 *
 * The test FAILS on current code (no such sync happens) and PASSES
 * once `updateMirror` is taught to read predWorld positions for
 * lingering hulls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface Internals {
  handleSnapshot(snap: SnapshotMessage): void;
  updateMirror(): void;
  predWorld: PhysicsWorld | null;
  mirror: {
    lingeringShips?: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function makeSnapshot(states: SnapshotMessage['states']): SnapshotMessage {
  return { type: 'snapshot', serverTick: 100, states, ackedTick: 0 };
}

function lingeringEntry(playerId: string, x: number, y: number): SnapshotMessage['states'][string] {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    playerId, isActive: false,
  };
}

describe('lingering hull render-vs-body sync (Invariant #13 repro)', () => {
  let client: ColyseusGameClient;
  let internals: Internals;

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    // The class doesn't expose a way to inject a predWorld at
    // construction; assign directly through the internals cast.
    internals.predWorld = await PhysicsWorld.create();
    // The mirror is initialised internally; ensure the lingeringShips
    // map exists for the snapshot routing to populate.
    if (!internals.mirror.lingeringShips) {
      internals.mirror.lingeringShips = new Map();
    }
    // Lingering routing requires the entry to have a `kind` before the
    // body is spawned (`tryEnsureLingerPredBody` bails if kind missing).
    // Pre-populate via syncMirror's path: just seed the kind directly.
    internals.mirror.lingeringShips.set('SHIP_A', {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter',
    });
  });

  it('FAILS today: lingering hull body drifts but mirror entry stays put after physics step', () => {
    // Seed the snapshot path so the body gets spawned.
    internals.handleSnapshot(makeSnapshot({
      'SHIP_A': lingeringEntry('player-A', 100, 100),
    }));
    expect(internals.predWorld!.hasShip('linger-SHIP_A')).toBe(true);

    // Apply a velocity to the lingering body (simulating having been
    // pushed by a collision in a previous tick).
    internals.predWorld!.setShipState('linger-SHIP_A', {
      x: 100, y: 100, vx: 50, vy: 0, angle: 0, angvel: 0,
    });

    // Integrate physics for ~500 ms (30 frames at 60 Hz). The body
    // moves under its own velocity; with default damping it should
    // travel many units.
    for (let i = 0; i < 30; i++) internals.predWorld!.tick(1 / 60);

    // Where the BODY ended up (collision-relevant position).
    const bodyState = internals.predWorld!.getShipState('linger-SHIP_A')!;
    expect(bodyState.x).toBeGreaterThan(101); // sanity: body actually moved

    // Where the MIRROR entry is — drives the sprite.
    // BEFORE updateMirror sync: still at snapshot pose (100, 100).
    const mirrorEntryBefore = internals.mirror.lingeringShips!.get('SHIP_A')!;
    expect(mirrorEntryBefore.x).toBeCloseTo(100, 1);

    // Run the per-frame mirror update. ACTIVE-ship loops read predWorld
    // and write back to the mirror — lingering hulls should follow the
    // same pattern, otherwise the renderer draws the sprite at a stale
    // position and players can't collide with what they see.
    internals.updateMirror();

    const mirrorEntryAfter = internals.mirror.lingeringShips!.get('SHIP_A')!;

    // THE LOAD-BEARING ASSERTION: sprite position must equal body
    // position so the visible silhouette is the same thing collision
    // touches.
    expect(
      Math.abs(mirrorEntryAfter.x - bodyState.x),
      `Sprite-body desync: mirror.x=${mirrorEntryAfter.x.toFixed(2)} but body.x=${bodyState.x.toFixed(2)}. ` +
        `Lingering hull sprite is drawn at the stale snapshot pose while the body has integrated physics. ` +
        `Player navigates toward the visible sprite but collision body is elsewhere → fly-through.`,
    ).toBeLessThan(0.5);
    expect(Math.abs(mirrorEntryAfter.y - bodyState.y)).toBeLessThan(0.5);
  });
});
