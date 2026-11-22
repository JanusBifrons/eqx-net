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
 *   ✗ NOT replaying CAPTURED remote-player state — captures only have
 *     local serverState. A test can script ONE other player's ship
 *     instead (`ReplayOptions.remoteShip`, netgap S1-5): the harness puts
 *     it in every synthesised snapshot, can hold whole snapshots back to
 *     model a gap, and returns the ship's drawn pose per frame.
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
    projectiles?: Map<string, unknown>;
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
  /** Due time (game ms) of the latest predicted tick (renderTickPhase). */
  _lastLocalTickAtMs: number;
  gameClock: { at(wallMs: number): number };
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
function synthesizeSnapshot(
  playerId: string,
  ev: SnapshotEventData,
  remoteId?: string,
  remote?: RemoteShipWireState | null,
): SnapshotMessage {
  // The wire format is shipInstanceId-keyed but ColyseusGameClient's
  // translator at the top of handleSnapshot routes by playerId via the
  // `playerId` field on each ShipState entry. We use a placeholder
  // shipInstanceId — production C-ii strategy keys the internal mirror
  // by playerId regardless of the wire key, so this is correct.
  const shipInstanceId = `replay-ship-${playerId}`;
  const snap = {
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
    // Empty thrust/boost sets — captures don't carry them.
    boostingShips: [],
    thrustingShips: [],
  } as unknown as SnapshotMessage;
  if (remoteId !== undefined && remote) {
    // Another pilot's ACTIVE ship: wire-keyed by its shipInstanceId,
    // routed to its playerId by the client's real router.
    const remoteInstanceId = `replay-ship-${remoteId}`;
    (snap.states as Record<string, unknown>)[remoteInstanceId] = {
      playerId: remoteId,
      shipInstanceId: remoteInstanceId,
      isActive: true,
      alive: true,
      x: remote.x,
      y: remote.y,
      vx: remote.vx,
      vy: remote.vy,
      angle: remote.angle,
      angvel: remote.angvel,
      ...(remote.lastInput ? { lastInput: remote.lastInput } : {}),
    };
  }
  return snap;
}

/** What one snapshot carries for the scripted remote ship (wire fields). */
export interface RemoteShipWireState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
  /** The remote pilot's held input bits (drive the client's forward
   *  prediction). Absent = idle. */
  lastInput?: { thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean };
}

/** One other player's ship, scripted by the test (netgap S1-5). */
export interface RemoteShipFeed {
  /** The remote pilot's playerId (its mirror key). */
  id: string;
  /** Ship kind, e.g. 'fighter' (what the schema diff would supply). */
  kind: string;
  /** The state the snapshot stamped `serverTick` carries for this ship,
   *  or null to leave the ship out of that snapshot. Called once per
   *  captured snapshot, at the snapshot's capture time `atMs`. Corrections
   *  and teleports are just states off the ship's true path. */
  stateAt(serverTick: number, atMs: number): RemoteShipWireState | null;
  /** When the WHOLE snapshot (local + remote) reaches the client, in the
   *  capture's ms. Default: `atMs` (applied at its own event, exactly as
   *  without a feed). A later time holds it; held snapshots are applied in
   *  order (a later snapshot never overtakes an earlier one) on the first
   *  frame (rafTick) at or after their time, before that frame's physics. */
  deliverAtMs?(serverTick: number, atMs: number): number;
}

/** The remote ship's drawn pose on one frame, read as the renderer reads
 *  it: `mirror.ships.get(id)` after `updateMirror()`. */
export interface RemoteDrawnPoseSample {
  atMs: number;
  /** Client `inputTick` when this frame completed. */
  inputTick: number;
  /** Server tick of the latest snapshot APPLIED (held ones excluded); -1 before any. */
  lastAppliedServerTick: number;
  /** Game ms this frame sits past the due time of the latest predicted tick,
   *  UNCLAMPED (the drawn pose moves by velocity × this, clamped to
   *  `DEAD_RECKON_CAP_MS`); NaN before the first tick. */
  tickElapsedMs: number;
  x: number;
  y: number;
  angle: number;
  /** Physics (predWorld) pose under the drawn one; NaN before the body exists. */
  physX: number;
  physY: number;
  physAngle: number;
  /** Correction offset drawn this frame: drawn − physics (0 without a body). */
  offsetX: number;
  offsetY: number;
  offsetAngle: number;
}

/** `replayCapture`'s result: the trace plus the remote ship's frames
 *  (empty without `ReplayOptions.remoteShip`). */
export interface ReplayResult extends ReplayTrace {
  remoteDrawnPoses: RemoteDrawnPoseSample[];
}

/** The lead the replay starts at (the production default at construction).
 *  The lead is sized only from the server's snapshot `inputMargin`; captures
 *  recorded before that field existed carry none, so on them the lead holds
 *  here for the whole replay (`leadHeldWithoutMargin`). */
export const HARNESS_START_LEAD_TICKS = 5;

/** Pre-margin capture check: with no `inputMargin` in the capture, nothing may
 *  move the lead, so final ticksAhead stays within `slack` of the start lead.
 *  A replay that drifts far above it means something other than the server
 *  margin is sizing the lead again, such as the blind lastRtt sample #1099
 *  removed (it took these replays to 16 and 24 ticks). */
export function leadHeldWithoutMargin(finalTicksAhead: number, slack = 3): boolean {
  return finalTicksAhead >= HARNESS_START_LEAD_TICKS - slack
    && finalTicksAhead <= HARNESS_START_LEAD_TICKS + slack;
}

export interface ReplayOptions {
  /** Hard cap on synthesised rafTicks per inter-snapshot gap so a
   *  multi-second pause doesn't try to spin millions of frames. */
  maxRafsPerGap?: number;
  /** Optional per-event probe — invoked AFTER each event is processed.
   *  Used by the d54fne heap-spike measurement test to sample
   *  `process.memoryUsage().heapUsed` at intervals during the replay.
   *  Pure observation; must not mutate harness state. Returning a
   *  promise is supported but not awaited (perf-sensitive in tight
   *  inner loops — callers should keep the probe synchronous).
   *  `eventIndex` is 0-based across the entire timeline. */
  onEvent?: (eventIndex: number, ev: TimelineEvent) => void;
  /** Script one other player's ship into the snapshots (netgap S1-5). */
  remoteShip?: RemoteShipFeed;
}

/**
 * Replay a captured session through the real `ColyseusGameClient`.
 * Returns a `ReplayTrace` with per-RAF reconstructed state ready for
 * user-contract assertions.
 */
export async function replayCapture(
  capturePath: string,
  _opts: ReplayOptions = {},
): Promise<ReplayResult> {
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
  internals.mirror.projectiles = internals.mirror.projectiles ?? new Map();
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
  internals.leadTicks = HARNESS_START_LEAD_TICKS;
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

  // 4b. The scripted remote ship's mirror entry, as the schema diff
  //     (syncMirror) creates it: identity only, no pose. Its body spawns
  //     from the first snapshot that carries it (spawnRemoteShipBodies).
  const remoteFeed = _opts.remoteShip;
  if (remoteFeed) {
    internals.mirror.ships.set(remoteFeed.id, {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: remoteFeed.kind,
    });
  }

  // 5. Spawn predWorld body + create Reconciler.
  internals.tryInitPredWorld(playerId);
  if (!internals.reconciler) {
    throw new Error(`tryInitPredWorld did not create a Reconciler — predWorld or mirror state malformed`);
  }

  // 6. Drive the timeline.
  const trace: ReplayResult = {
    source: { path: capturePath, playerId },
    renderedPoses: [],
    capturedRenderedPoses: [],
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
    remoteDrawnPoses: [],
  };

  // Snapshots held back by `remoteShip.deliverAtMs`, in arrival order.
  const held: { snap: SnapshotMessage; serverTick: number; deliverAtMs: number }[] = [];
  let lastAppliedServerTick = -1;
  const applySnap = (snap: SnapshotMessage, serverTick: number): void => {
    internals.handleSnapshot(snap);
    lastAppliedServerTick = serverTick;
  };

  // Track the current input-intent state. The captured `input_intent`
  // events occur at every inner tick; we update the mock keyboard's
  // state whenever a new intent fires, and tickPhysics() reads it during
  // its inner-while loop.
  // (Capture cadence: one input_intent per inner tick, so the harness's
  // keyboard always reflects the captured user intent at the moment of
  // the production code's keyboard.read() call.)
  const onEventProbe = _opts.onEvent;
  let eventIndex = 0;
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
        const tick = ev.data.serverTick;
        const snap = remoteFeed
          ? synthesizeSnapshot(playerId, ev.data, remoteFeed.id, remoteFeed.stateAt(tick, ev.ts))
          : synthesizeSnapshot(playerId, ev.data);
        let deliverAtMs = remoteFeed?.deliverAtMs?.(tick, ev.ts) ?? ev.ts;
        const last = held[held.length - 1];
        if (last && last.deliverAtMs > deliverAtMs) deliverAtMs = last.deliverAtMs;
        if (held.length === 0 && deliverAtMs <= ev.ts) applySnap(snap, tick);
        else held.push({ snap, serverTick: tick, deliverAtMs });
        break;
      }

      case 'rafTick': {
        // Held snapshots due by this frame apply first (on the frame tick).
        while (held.length > 0 && held[0]!.deliverAtMs <= ev.ts) {
          const h = held.shift()!;
          applySnap(h.snap, h.serverTick);
        }
        // Drive a real tickPhysics with the captured elapsedMs.
        internals.tickPhysics(ev.data.elapsedMs);
        // Run updateMirror to refresh the mirror's rendered pose (in
        // production this fires from React; we call it once per RAF here).
        internals.updateMirror();
        if (remoteFeed) {
          // Read the remote ship the way the renderer does: its mirror
          // entry, written by updateRemoteShipsMirror (physics + offset).
          const drawn = internals.mirror.ships.get(remoteFeed.id);
          if (drawn) {
            const phys = internals.predWorld?.getShipState(remoteFeed.id);
            trace.remoteDrawnPoses.push({
              atMs: ev.ts,
              inputTick: internals.inputTick,
              lastAppliedServerTick,
              tickElapsedMs: internals._lastLocalTickAtMs >= 0
                ? internals.gameClock.at(ev.ts) - internals._lastLocalTickAtMs
                : NaN,
              x: drawn.x,
              y: drawn.y,
              angle: drawn.angle,
              physX: phys ? phys.x : NaN,
              physY: phys ? phys.y : NaN,
              physAngle: phys ? phys.angle : NaN,
              offsetX: phys ? drawn.x - phys.x : 0,
              offsetY: phys ? drawn.y - phys.y : 0,
              offsetAngle: phys ? drawn.angle - phys.angle : 0,
            });
          }
        }
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
        // Capture's ground-truth pose for this RAF.
        const captured = ev.data;
        // Render-jitter-fix Phase 0a: also append to capturedRenderedPoses
        // so frame-pacing assertions can read the ON-DEVICE stream
        // directly (sidesteps harness drift on long combat captures).
        trace.capturedRenderedPoses.push({
          atMs: ev.ts,
          inputTick: captured.inputTick,
          x: captured.x,
          y: captured.y,
          angle: captured.angle,
          lerpOffsetX: captured.lerpOffsetX ?? 0,
          lerpOffsetY: captured.lerpOffsetY ?? 0,
          lerpAngleOffset: captured.lerpAngleOffset ?? 0,
        });
        // Pair with the closest replayed-rendered sample (same ts).
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
    if (onEventProbe !== undefined) onEventProbe(eventIndex, ev);
    eventIndex++;
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
