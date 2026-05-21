/**
 * Capture-driven replay harness — drives the REAL `ColyseusGameClient`
 * through a captured session deterministically. Plan: capture-driven
 * replay infra Phase C (2026-05-21).
 *
 * What this is and isn't:
 *
 *   ✓ Uses real `ColyseusGameClient` (`src/client/net/ColyseusClient.ts`)
 *   ✓ Uses real `Reconciler`, `PhysicsWorld`, all the production pure modules
 *   ✓ Time is `MockClock`-driven from captured `ts` timestamps
 *   ✓ Inputs are replayed from captured `input_intent` events (the exact
 *     keystrokes/joystick vectors the user pressed on-device)
 *   ✓ Snapshots are synthesised from captured fields and fed into
 *     `internals.handleSnapshot(snap)` directly
 *
 *   ✗ NOT going through `room.onMessage(...)` registration — we bypass
 *     `connect()` to avoid mocking the entire `colyseus.js` Client flow
 *   ✗ NOT replaying remote-player state — captures only have local
 *     serverState. Replay is local-player-pose focused (which is what
 *     the user contracts assert on anyway).
 *   ✗ NOT replaying drones/projectiles — the captures' snapshot stream
 *     doesn't include full drone[] / projectile arrays; the harness
 *     synthesises an empty drone slice. Collision effects on the local
 *     ship from drones won't be reproduced. For an idle or no-drone-
 *     contact session this is exact; for combat replays this is a known
 *     limit and Phase E will verify whether ground-truth still matches
 *     within tolerance.
 *
 * The harness is the substrate Phase D's user-contract assertions and
 * Phase E's ground-truth verification both consume.
 */
import { ColyseusGameClient } from '../../src/client/net/ColyseusClient';
import { PhysicsWorld } from '../../src/core/physics/World';
import { MockClock } from '../../src/core/clock/Clock';
import type { SnapshotMessage } from '../../src/shared-types/messages';
import { MockKeyboard } from './mockKeyboard';
import { MockRoom } from './mockRoom';
import {
  loadCapture,
  type LoadedCapture,
  type SnapshotEventData,
  type TimelineEvent,
} from './captureLoader';
import type {
  ReplayTrace,
  RenderedPoseSample,
  PredictedPoseSample,
} from './ReplayTrace';

/** ColyseusGameClient private surface the harness touches. Mirrors the
 *  pattern in src/client/net/ColyseusClient.lingeringJitter.test.ts. */
interface Internals {
  predWorld: PhysicsWorld | null;
  reconciler: import('../../src/core/prediction/Reconciler').Reconciler | null;
  room: MockRoom | null;
  keyboard: MockKeyboard | null;
  mirror: {
    localPlayerId: string | null;
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    swarm?: Map<number, unknown>;
    boostingShips?: Set<string>;
    thrustingShips?: Set<string>;
    lingeringShips?: Map<string, unknown>;
    projectiles?: Map<string, unknown>;
    wrecks?: Map<string, unknown>;
    liveBeams?: Map<number, unknown>;
    remoteLasers?: Map<string, unknown>;
    pendingDamageNumbers?: unknown[];
    pendingHealthBarHits?: unknown[];
    explodingShips?: Set<string>;
  };
  serverTickAtWelcome: number;
  welcomePerfNow: number;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
  _anchorInitialised: boolean;
  inputTick: number;
  leadTicks: number;
  lastFrameMs: number;
  localDead: boolean;
  lastSentInputState: unknown;
  lastSentInputAtMs: number;
  stats: {
    snapshotCount: number;
    significantCorrectionCount: number;
    ticksAhead: number;
    maxDriftUnits: number;
    rollingCorrRate: number;
  };
  handleSnapshot(snap: SnapshotMessage): void;
  tickPhysics(elapsedMs: number): void;
  updateMirror(): void;
  tryInitPredWorld(playerId: string): void;
}

/** A SnapshotMessage shape sufficient for handleSnapshot's local-ship
 *  reconcile + RTT update path. Remote/drone/projectile arrays are
 *  empty by design (captures don't carry them; see header). */
function synthesizeSnapshot(playerId: string, ev: SnapshotEventData): SnapshotMessage {
  // The wire format is shipInstanceId-keyed but ColyseusGameClient's
  // translator at the top of handleSnapshot routes by playerId via the
  // `playerId` field on each ShipState entry. We use a placeholder
  // shipInstanceId — production C-ii strategy keys the internal mirror
  // by playerId regardless of the wire key, so this is correct.
  const shipInstanceId = `replay-ship-${playerId}`;
  return {
    type: 'snapshot',
    serverTick: ev.serverTick,
    ackedTick: ev.ackedTick,
    states: {
      [shipInstanceId]: {
        playerId,
        shipInstanceId,
        isActive: true,
        alive: true,
        x: ev.serverX,
        y: ev.serverY,
        vx: ev.serverVx ?? 0,
        vy: ev.serverVy ?? 0,
        angle: ev.serverAngle ?? 0,
        angvel: ev.serverAngvel ?? 0,
      },
    },
    drones: [],
    projectiles: [],
    wrecks: [],
    // Empty thrust/boost sets — captures don't carry them.
    boostingShips: [],
    thrustingShips: [],
  } as unknown as SnapshotMessage;
}

export interface ReplayOptions {
  /** Hard cap on synthesised rafTicks per inter-snapshot gap so a
   *  multi-second pause doesn't try to spin millions of frames. */
  maxRafsPerGap?: number;
}

/**
 * Replay a captured session through the real `ColyseusGameClient`.
 * Returns a `ReplayTrace` with per-RAF reconstructed state ready for
 * user-contract assertions.
 */
export async function replayCapture(
  capturePath: string,
  _opts: ReplayOptions = {},
): Promise<ReplayTrace> {
  const cap: LoadedCapture = loadCapture(capturePath);

  // 1. Construct real client with mock clock.
  const clock = new MockClock(cap.welcome.ts);
  const client = new ColyseusGameClient(clock);
  const internals = client as unknown as Internals;

  // 2. Real PhysicsWorld + mocks.
  internals.predWorld = await PhysicsWorld.create();
  const keyboard = new MockKeyboard();
  internals.keyboard = keyboard;
  const room = new MockRoom();
  room.getTimeMs = () => clock.now();
  internals.room = room;

  // Initialise mirror collections the production code expects.
  internals.mirror.ships = internals.mirror.ships ?? new Map();
  internals.mirror.swarm = internals.mirror.swarm ?? new Map();
  internals.mirror.lingeringShips = internals.mirror.lingeringShips ?? new Map();
  internals.mirror.projectiles = internals.mirror.projectiles ?? new Map();
  internals.mirror.wrecks = internals.mirror.wrecks ?? new Map();
  internals.mirror.liveBeams = internals.mirror.liveBeams ?? new Map();
  internals.mirror.remoteLasers = internals.mirror.remoteLasers ?? new Map();
  internals.mirror.boostingShips = internals.mirror.boostingShips ?? new Set();
  internals.mirror.thrustingShips = internals.mirror.thrustingShips ?? new Set();
  internals.mirror.explodingShips = internals.mirror.explodingShips ?? new Set();
  internals.mirror.pendingDamageNumbers = internals.mirror.pendingDamageNumbers ?? [];
  internals.mirror.pendingHealthBarHits = internals.mirror.pendingHealthBarHits ?? [];

  // 3. Welcome bootstrap — mirror what room.onMessage('welcome', ...) does.
  const playerId = cap.welcome.playerId;
  internals.mirror.localPlayerId = playerId;
  internals.serverTickAtWelcome = cap.welcome.serverTick;
  internals.welcomePerfNow = clock.now();
  internals.clockAnchorServerTick = cap.welcome.serverTick;
  internals.clockAnchorPerfNow = clock.now();
  internals._anchorInitialised = true;
  internals.inputTick = cap.welcome.serverTick;
  internals.localDead = false;
  internals.leadTicks = 5; // production default at construction
  internals.lastFrameMs = 16.67;

  // 4. Bootstrap mirror.ships entry from the first snapshot's serverX/Y
  //    so tryInitPredWorld has somewhere to spawn the body.
  const firstSnap = cap.events.find((e): e is Extract<TimelineEvent, { kind: 'snapshot' }> => e.kind === 'snapshot');
  if (!firstSnap) {
    throw new Error(`capture has no snapshots — cannot bootstrap replay`);
  }
  internals.mirror.ships.set(playerId, {
    x: firstSnap.data.serverX,
    y: firstSnap.data.serverY,
    vx: firstSnap.data.serverVx ?? 0,
    vy: firstSnap.data.serverVy ?? 0,
    angle: firstSnap.data.serverAngle ?? 0,
  });

  // 5. Spawn predWorld body + create Reconciler.
  internals.tryInitPredWorld(playerId);
  if (!internals.reconciler) {
    throw new Error(`tryInitPredWorld did not create a Reconciler — predWorld or mirror state malformed`);
  }

  // 6. Drive the timeline.
  const trace: ReplayTrace = {
    source: { path: capturePath, playerId },
    renderedPoses: [],
    predictedPoses: [],
    inputSent: [],
    inputs: [],
    groundTruth: [],
    finalStats: {
      snapshotCount: 0,
      significantCorrectionCount: 0,
      ticksAhead: 0,
      maxDriftUnits: 0,
      rollingCorrRate: 0,
    },
    events: cap.events,
  };

  // Track the current input-intent state. The captured `input_intent`
  // events occur at every inner tick; we update the mock keyboard's
  // state whenever a new intent fires, and tickPhysics() reads it during
  // its inner-while loop.
  // (Capture cadence: one input_intent per inner tick, so the harness's
  // keyboard always reflects the captured user intent at the moment of
  // the production code's keyboard.read() call.)
  for (const ev of cap.events) {
    clock.set(ev.ts);

    switch (ev.kind) {
      case 'welcome':
        // Already handled in bootstrap — skip if it reappears.
        break;

      case 'input_intent': {
        keyboard.setState({
          thrust: ev.data.thrust,
          turnLeft: ev.data.turnLeft,
          turnRight: ev.data.turnRight,
          fireHeld: ev.data.fireHeld,
          boost: ev.data.boost,
          reverse: ev.data.reverse,
        });
        trace.inputs.push({
          atMs: ev.ts,
          tick: ev.data.tick,
          thrust: ev.data.thrust,
          turnLeft: ev.data.turnLeft,
          turnRight: ev.data.turnRight,
          boost: ev.data.boost,
          reverse: ev.data.reverse,
          fireHeld: ev.data.fireHeld,
        });
        break;
      }

      case 'snapshot': {
        const snap = synthesizeSnapshot(playerId, ev.data);
        internals.handleSnapshot(snap);
        break;
      }

      case 'rafTick': {
        // Drive a real tickPhysics with the captured elapsedMs.
        internals.tickPhysics(ev.data.elapsedMs);
        // Run updateMirror to refresh the mirror's rendered pose (in
        // production this fires from React; we call it once per RAF here).
        internals.updateMirror();
        // Capture the rendered pose.
        const renderedShip = internals.mirror.ships.get(playerId);
        if (renderedShip) {
          const lerpOffsetX = internals.reconciler?.lerpOffset.x ?? 0;
          const lerpOffsetY = internals.reconciler?.lerpOffset.y ?? 0;
          const lerpAngleOffset = (internals.reconciler as unknown as { lerpAngleOffset?: number } | null)?.lerpAngleOffset ?? 0;
          const sample: RenderedPoseSample = {
            atMs: ev.ts,
            inputTick: internals.inputTick,
            x: renderedShip.x,
            y: renderedShip.y,
            angle: renderedShip.angle,
            lerpOffsetX,
            lerpOffsetY,
            lerpAngleOffset,
          };
          trace.renderedPoses.push(sample);
        }
        // Capture predicted pose (predWorld) for diagnostic.
        const pred = internals.predWorld?.getShipState(playerId);
        if (pred) {
          const predSample: PredictedPoseSample = {
            atMs: ev.ts,
            tick: internals.inputTick,
            x: pred.x,
            y: pred.y,
            vx: pred.vx,
            vy: pred.vy,
            angle: pred.angle,
          };
          trace.predictedPoses.push(predSample);
        }
        break;
      }

      case 'local_pose_rendered': {
        // Capture's ground-truth pose for this RAF. Pair it with the
        // closest replayed-rendered sample (same ts).
        const captured = ev.data;
        // Find the replayed sample at the same atMs (rafTick events fire
        // at the same ts as the local_pose_rendered log).
        const replayed = trace.renderedPoses[trace.renderedPoses.length - 1];
        if (replayed && Math.abs(replayed.atMs - ev.ts) < 0.5) {
          trace.groundTruth.push({
            atMs: ev.ts,
            capturedInputTick: captured.inputTick,
            captured: { x: captured.x, y: captured.y, angle: captured.angle },
            replayed: { x: replayed.x, y: replayed.y, angle: replayed.angle },
            deltaX: replayed.x - captured.x,
            deltaY: replayed.y - captured.y,
            deltaAngle: replayed.angle - captured.angle,
          });
        }
        break;
      }

      case 'local_pose_predicted':
        // No-op for now — predictedPoses are recorded from the live
        // predWorld during rafTick; the captured version is for
        // diagnostic comparison if Phase E needs it.
        break;
    }
  }

  // 7. Capture sent messages from MockRoom into the trace.
  for (const m of room.sent) {
    if (m.type !== 'input') continue;
    const p = m.payload as Record<string, unknown>;
    trace.inputSent.push({
      atMs: m.atMs,
      tick: Number(p['tick']),
      thrust: !!p['thrust'],
      turnLeft: !!p['turnLeft'],
      turnRight: !!p['turnRight'],
      boost: !!p['boost'],
      reverse: !!p['reverse'],
    });
  }

  // 8. Final stats from internals.
  trace.finalStats = {
    snapshotCount: internals.stats.snapshotCount,
    significantCorrectionCount: internals.stats.significantCorrectionCount,
    ticksAhead: internals.stats.ticksAhead,
    maxDriftUnits: internals.stats.maxDriftUnits,
    rollingCorrRate: internals.stats.rollingCorrRate,
  };

  return trace;
}
