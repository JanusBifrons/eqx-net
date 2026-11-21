/**
 * The client prediction step's per-frame passes, moved verbatim out of
 * `ColyseusClient.tickPhysics` (god-file split). Each takes the once-built
 * `PredictionStepCtx` (#14: no closures, literals or arrays per call) and runs
 * in the same order `tickPhysics` always ran them, so prediction stays
 * bit-identical.
 */
import type { Room } from 'colyseus.js';
import type { PredictionStepCtx, KeyboardBits } from './predictionStepCtx.js';
import { joystickToInput } from '../../input/joystickToInput';
import { aimInput } from '../../input/AimInput';
import { gateDisabledInput } from '@core/combat/disable';
import { canAfford, spendEnergy, regenEnergyStep, BOOST_TICK_COST } from '@core/combat/Energy';
import { RENDER_DUE_SLEW_MS, RENDER_DUE_SNAP_MS, slewTickDue, tickBoundaryDueMs } from '../renderTickPhase';
import { logEvent, isFullDiagMode } from '../../debug/ClientLogger';
import { getShipKind } from '@shared-types/shipKinds';
import { resolveInstanceMounts } from '@shared-types/shipKinds/slots';
import { helmStep, type HelmSpeed } from '@core/helm/helm';
import { resolveHelmCourseMark } from '../../helm/helmCourseMark.js';
import { useUIStore } from '../../state/store.js';

/** Idle-input heartbeat (network-discipline P4). When the control state has
 *  not changed for this long, we re-send the latest state once anyway, so the
 *  server can detect a missing client (idle != disconnected) and so a UDP
 *  restart-style replacement of the last-applied input still happens. 250 ms
 *  is well below `lastSentInput` perception lag for a held-key change but
 *  well above the per-tick 16.67 ms cadence — net result is a 60 → ~4 Hz
 *  drop on idle. */
export const INPUT_HEARTBEAT_MS = 250;

// The input loop's fixed step and caps (were locals of `tickPhysics`).
export const FIXED_MS = 1000 / 60;
export const MAX_CATCH_UP_TICKS = 4;
// Spiral fix (plan: spiral-fix, Phase 2): cap inputTick over-prediction
// at 60 ticks beyond ackedTick (~1 sec at 60 Hz). 2× the healthy-network
// CEILING_TICKS=30 ticksAhead ceiling, so the cap never engages on the
// healthy local profile but bounds bufferbloat-induced spiral on mobile
// networks. NOT capping inputTick itself (the 6e4d9c2 anti-pattern) —
// capping the CONDITION `inputTick - ackedTick`. Companion change:
// `keyboard.read()` hoisted out of the loop so cap-engaged RAFs still
// emit a sentinel input + diagnostic log.
export const MAX_OVER_PREDICTION_TICKS = 60;

/**
 * One catch-up tick of the input loop: resolve touch/keyboard/helm into the
 * gated control bits, predict + record + send the input, apply remote inputs,
 * step predWorld, then aim the local mounts. `tickPhysics` owns the loop.
 */
export function stepInputTick(ctx: PredictionStepCtx, room: Room, kb: KeyboardBits): void {
  let tcThrust = false, tcTurnLeft = false, tcTurnRight = false, tcFire = false;
  if (ctx.touchInput) {
    tcFire = ctx.touchInput.getFireHeld();
    const v = ctx.touchInput.getJoystickVector();
    const localId = ctx.mirror.localPlayerId;
    // Render-jitter-fix Phase 1: read REAL-TIME predWorld angle for
    // the joystick hysteresis. The mirror angle now carries the
    // dead-reckon term (up to 32 ms × angvel ≈ 0.08 rad at max
    // turn rate), which is 2× the joystick hysteresis band
    // (TURN_OFF_RAD=0.04 in joystickToInput). Reading the mirror
    // could perturb the engaged/disengaged crossing and cause
    // phantom turn-direction reversal under sustained held input —
    // exactly the spiral-fix bug class the joystick hysteresis was
    // built to prevent. Mirror fallback covers the boot window
    // before predWorld has a ship body.
    const predState = localId ? ctx.predWorld?.getShipState(localId) ?? null : null;
    const localShip = localId ? ctx.mirror.ships.get(localId) : null;
    const realAngle = predState?.angle ?? localShip?.angle ?? null;
    if (realAngle !== null) {
      // 2026-05-20 spiral fix: pure resolver with HYSTERESIS bands.
      // Pre-fix `delta > TOUCH_TURN_TOLERANCE` had no off-threshold;
      // as the ship rotated toward target, delta crossed 0.08 rad,
      // turn toggled — analog stick noise then nudged it back across,
      // toggled again. Empirical ~10 Hz state-change rate → sustained
      // ~45-70 % rollingCorrRate spiral. Unit-locked in
      // src/client/input/joystickToInput.test.ts.
      // The hull's per-tick turn step widens the stop band (else a fast-
      // turning hull overshoots and wobbles left/right every tick).
      const turnStep = localId ? ctx.predWorld?.maxTurnPerTick(localId) ?? 0 : 0;
      const next = joystickToInput(v, realAngle, ctx.joystickInputState, turnStep);
      ctx.joystickInputState = next;
      tcTurnLeft = next.turnLeft;
      tcTurnRight = next.turnRight;
      tcThrust = next.thrust;
    }
  }
  // v4 A — a disabled ship's engines and weapons are off: the SAME shared
  // gate the server applies to our input (#15), so prediction agrees.
  // Helm orders: WASD / the stick override (and cancel) a course.
  if (ctx.helmOrder.active) {
    if (kb.thrust || kb.turnLeft || kb.turnRight || kb.reverse || tcThrust || tcTurnLeft || tcTurnRight) ctx.clearHelm();
    else ctx.stepHelm();
  }
  const helm = ctx.helmOrder.active ? ctx.helmOut : null;
  const db = ctx.disableBits;
  db.thrust = kb.thrust || tcThrust || (helm?.thrust ?? false);
  db.turnLeft = kb.turnLeft || tcTurnLeft || (helm?.turnLeft ?? false);
  db.turnRight = kb.turnRight || tcTurnRight || (helm?.turnRight ?? false);
  db.boost = kb.boost || (ctx.touchInput?.getBoostHeld() ?? false) || aimInput.getBoostHeld();
  // Reverse is keyboard-only in v1 — no on-screen button on touch yet.
  db.reverse = kb.reverse;
  const disabledNow = gateDisabledInput(ctx.isLocallyDisabled(), db);
  const thrust    = db.thrust;
  const turnLeft  = db.turnLeft;
  const turnRight = db.turnRight;
  const fireHeld  = !disabledNow && (kb.fireHeld || tcFire);
  const boost     = db.boost;
  const reverse   = db.reverse ?? false;
  const tick = ctx.inputTick++;

  // Replay-grade input-intent capture (plan: replay infra Phase A).
  // This is the EXACT raw input state for this tick — what the user
  // pressed at this client-side wall-clock moment. Required by the
  // deterministic replay harness to drive the same input stream into
  // a Node-side ColyseusGameClient instance. Logged BEFORE the
  // throttle check (`inputSent` is sampled / state-change-gated; this
  // is the ground truth of what the loop SAW). Joystick vector pulled
  // raw via `getJoystickVector()` so the replay can reconstruct
  // analog stick motion (not just the booleans it resolved to).
  // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). Skip the
  // joystick-vector read + object literal when not in diag mode.
  if (isFullDiagMode()) {
    const _jv = ctx.touchInput?.getJoystickVector() ?? null;
    logEvent('input_intent', {
      tick,
      thrust,
      turnLeft,
      turnRight,
      boost,
      reverse,
      fireHeld,
      joystickX: _jv ? Math.round(_jv.x * 1000) / 1000 : null,
      joystickY: _jv ? Math.round(_jv.y * 1000) / 1000 : null,
    });
  }

  // No client-side drone AI tick (drone-snapshot-interpolation pivot,
  // 2026-05-18). Drones are pure snapshot-interpolated from the binary
  // swarm wire; the server simulates every drone authoritatively. No
  // client brain ⇒ no divergent inputs ⇒ nothing to reconcile/snap.
  if (!ctx.localDead && ctx.predWorld && ctx.reconciler && ctx.mirror.localPlayerId) {
    const nowMs = ctx.clock.now();
    // Boost is now an independent every-tick forward impulse (no longer
    // gated on thrust), so it MUST be energy-gated to match the server:
    // `InputHandler` strips the boost bit when the pool can't afford
    // BOOST_TICK_COST. Predicting an un-gated boost while the server
    // applies none = continuous per-tick velocity divergence once the
    // pool empties (the netgate's rollingCorrRate / maxDriftUnits class).
    // `predEnergy` is hard-reconciled to server energy each snapshot, so
    // this gate tracks the server's; the fire path gates the same way.
    // We predict, record, SEND and drain on the SAME gated value so client
    // and server stay byte-aligned (minimises corrections).
    const boostApplied = boost && canAfford(ctx.predEnergy, BOOST_TICK_COST);
    // Pooled per-tick scratches (data-driven from the 2026-05-30 CDP
    // profile — `tickPhysics` was rank-2 at 81 KB / 7.5 %). The
    // Reconciler copies `rec` into its own ring buffer; predWorld
    // applyInput reads the fields into Rapier. Both safe to reuse.
    const rec = ctx.inputRecScratch;
    rec.tick = tick;
    rec.thrust = thrust;
    rec.turnLeft = turnLeft;
    rec.turnRight = turnRight;
    rec.boost = boostApplied;
    rec.reverse = reverse;
    rec.sentAt = nowMs;
    const wx = ctx.warpRequest?.x, wy = ctx.warpRequest?.y;
    rec.warpX = wx;
    rec.warpY = wy;
    const applyArg = ctx.applyInputScratch;
    applyArg.thrust = thrust;
    applyArg.turnLeft = turnLeft;
    applyArg.turnRight = turnRight;
    applyArg.boost = boostApplied;
    applyArg.reverse = reverse;
    applyArg.warpX = wx;
    applyArg.warpY = wy;
    ctx.predWorld.applyInput(ctx.mirror.localPlayerId, applyArg);
    ctx.reconciler.recordInput(rec);
    // Arrived: stop asking (the next input carries none, which also
    // releases the server's latch on this target).
    if (ctx.warpRequest !== null && ctx.predWorld.warpArrived(ctx.mirror.localPlayerId)) ctx.warpRequest = null;
    // Idle-suppression — narrowed (2026-05-06): throttle ONLY when current
    // AND last-sent state are both fully idle (all-false). Why: when ANY
    // key is held, the server's worker queue stays populated and the
    // held-input branch never fires; if we throttled in that state, the
    // worker would synthesise an ack trail across held re-applications,
    // and a subsequent state-change message would jump the ack past the
    // intermediate synthesised ticks — skipping a tick of physics
    // application that the client's prediction DID apply locally. Result:
    // ~8 u of drift per release event on a fast-moving ship. The
    // all-idle restriction keeps throttling safe because held all-idle
    // adds zero impulse, so a skipped tick is physically equivalent.
    const last = ctx.lastSentInputState;
    // A held warp request is never idle (the server must keep receiving it).
    const allIdle = !thrust && !turnLeft && !turnRight && !boostApplied && !reverse && wx === undefined;
    const lastAllIdle = !!last && !last.thrust && !last.turnLeft && !last.turnRight && !last.boost && !last.reverse && last.warpX === undefined;
    const stateChanged = !last
      || last.thrust !== thrust
      || last.turnLeft !== turnLeft
      || last.turnRight !== turnRight
      || last.boost !== boostApplied
      || last.reverse !== reverse
      || last.warpX !== wx
      || last.warpY !== wy;
    const heartbeatDue = nowMs - ctx.lastSentInputAtMs >= INPUT_HEARTBEAT_MS;
    const throttle = allIdle && lastAllIdle && !stateChanged && !heartbeatDue;
    if (!throttle) {
      // Pooled send payload — colyseus.js serialises the literal
      // before returning so reusing the scratch ref is safe.
      if (wx !== undefined && wy !== undefined) {
        const w = ctx.sendWarpInputScratch;
        w.tick = tick; w.thrust = thrust; w.turnLeft = turnLeft; w.turnRight = turnRight;
        w.boost = boostApplied; w.reverse = reverse; w.warpX = wx; w.warpY = wy;
        room.send('input', w);
      } else {
      const sendArg = ctx.sendInputScratch;
      sendArg.tick = tick;
      sendArg.thrust = thrust;
      sendArg.turnLeft = turnLeft;
      sendArg.turnRight = turnRight;
      sendArg.boost = boostApplied;
      sendArg.reverse = reverse;
      room.send('input', sendArg);
      }
      // lastSentInputState retains state ACROSS ticks — must NOT
      // alias the per-tick scratch (would mutate the stored
      // last-state on the next tick). Reuse the existing record if
      // present (first-tick falls through to fresh alloc).
      const stored = ctx.lastSentInputState;
      if (stored) {
        stored.thrust = thrust;
        stored.turnLeft = turnLeft;
        stored.turnRight = turnRight;
        stored.boost = boostApplied;
        stored.reverse = reverse;
        stored.warpX = wx;
        stored.warpY = wy;
      } else {
        ctx.lastSentInputState = { thrust, turnLeft, turnRight, boost: boostApplied, reverse, warpX: wx, warpY: wy };
      }
      ctx.lastSentInputAtMs = nowMs;
      if ((stateChanged || (tick % 60) === 0) && isFullDiagMode()) {
        logEvent('inputSent', { tick, thrust, turnLeft, turnRight, boost: boostApplied, reverse });
      }
    }
    // Show the local exhaust trail without waiting an RTT for the server
    // to confirm — the next snapshot will overwrite from server truth.
    // Boost is now thrust-independent, so the trail shows whenever boost is
    // actually applied (energy-affordable), matching the server's
    // `boostingPlayers` membership + the predEnergy drain below.
    if (ctx.mirror.boostingShips) {
      if (boostApplied) ctx.mirror.boostingShips.add(ctx.mirror.localPlayerId);
      else ctx.mirror.boostingShips.delete(ctx.mirror.localPlayerId);
    }
    if (ctx.mirror.thrustingShips) {
      if (thrust) ctx.mirror.thrustingShips.add(ctx.mirror.localPlayerId);
      else ctx.mirror.thrustingShips.delete(ctx.mirror.localPlayerId);
    }
  }
  // Stage 3 — apply each remote ship's last-known input before advancing
  // physics, so remote bodies forward-predict in lockstep with the local
  // input loop. Bounded by STAGE_3_MAX_LOOKAHEAD_TICKS per snapshot;
  // remotes whose intent isn't tracking (3 consecutive corrections > 5 u)
  // skip this and integrate with damping only.
  ctx.applyRemoteInputs();
  // (Phase 3 AI tick now runs at the TOP of this iteration, before
  // applyInput, to match the server's "post-step state → AI" ordering.)
  // Always advance physics — remote ships and obstacles must keep moving even while dead.
  if (ctx.predWorld) {
    // Structure rig parts (structure-restyle 2d): pose for the tick this
    // step produces, as the server worker does (`stepRigs(tick + 1)`).
    ctx.predWorld.stepRigs(tick + 1);
    ctx.predWorld.tick(1 / 60);
    // Stamp the wall-clock time this state STANDS FOR (when its tick
    // boundary was due), so `updateMirror`'s dead-reckon is measured
    // from there. Stamping the processing time drew the ship a tick
    // ahead after a 2-tick frame and then stalled it: the fly-by judder
    // (renderTickPhase.ts; lock: capital-flyby-smooth.spec.ts).
    // ...advanced one tick per tick and only SLEWED toward the anchor-based
    // due time: the anchor follows snapshot arrival, and a late snapshot
    // moved it a whole tick, lurching the drawn ship (slewTickDue).
    const due = tickBoundaryDueMs(
      ctx.clockAnchorPerfNow, ctx.clockAnchorServerTick, ctx.gameLeadTicks(), ctx.inputTick, FIXED_MS,
    );
    ctx.lastLocalTickAtMs = ctx.lastLocalTickAtMs < 0
      ? due
      : slewTickDue(ctx.lastLocalTickAtMs, due, FIXED_MS, RENDER_DUE_SLEW_MS, RENDER_DUE_SNAP_MS);
  }

  // Replay-grade per-tick predicted-pose capture (plan: replay infra
  // Phase A). After `applyInput` + `world.tick`, the local ship's
  // predWorld pose IS the prediction for this tick. The replay harness
  // re-runs the same predWorld through the same input stream and
  // compares against THIS value to confirm bit-identical simulation
  // (the ground-truth check that makes the harness a faithful
  // surrogate for on-device behaviour). Skip-safe when localDead /
  // pre-init: predWorld may not have a ship body yet.
  // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). Skip the
  // predWorld read + object literal when not in diag mode.
  if (!ctx.localDead && ctx.predWorld && ctx.mirror.localPlayerId && isFullDiagMode()) {
    const _ps = ctx.predWorld.getShipState(ctx.mirror.localPlayerId);
    if (_ps) {
      logEvent('local_pose_predicted', {
        tick,
        x: Math.round(_ps.x * 1000) / 1000,
        y: Math.round(_ps.y * 1000) / 1000,
        vx: Math.round(_ps.vx * 1000) / 1000,
        vy: Math.round(_ps.vy * 1000) / 1000,
        angle: Math.round(_ps.angle * 10000) / 10000,
        angvel: _ps.angvel !== undefined ? Math.round(_ps.angvel * 10000) / 10000 : 0,
      });
    }
  }

  // Multi-mount/turret refactor (Phase 4b.2): client-side turret aim
  // update for the local ship. Runs every physics tick so the
  // rotation stays continuous and the beams emerge from the slewed
  // mount direction. Skipped while dead (no aim to compute) and when
  // the player has no predWorld state yet.
  ctx.tickLocalMountAim(1 / 60);

  // (Fire dispatch HOISTED out of this loop — see below. It gates on
  //  wall-clock cooldown so a stalled inputTick can't suppress fires
  //  the user feels they've earned. Loop body kept lean.)

  // beam-attach fix (capture pe6rdt): NO hard-clear when fire isn't
  // held. The local hitscan beam persists ~LIVE_BEAM_PERSIST_MS past
  // the last shot (expired in updateMirror) and is redrawn from
  // `mirror.ships` every frame, so a tap / held burst reads as ONE
  // continuous SHIP-ATTACHED beam — server lag/correction invisible.
  // Death still clears it via killEntity's liveBeams.clear().
}

/** Predict the energy pool for the frame (regen per stepped tick, boost drain). */
export function predictFrameEnergy(ctx: PredictionStepCtx, stepsThisFrame: number): void {
  if (ctx.mirror.localPlayerId && stepsThisFrame > 0) {
    const localKindId = ctx.mirror.ships.get(ctx.mirror.localPlayerId)?.kind;
    const ek = getShipKind(localKindId ?? null);
    const emax = ek.energyMax ?? 100;
    // Before the server's first own-ship energy: start full, as the server
    // spawned it (only once the kind is known, or we'd seed another kind's max).
    if (!ctx.energySeeded && localKindId) {
      ctx.predEnergy = emax;
      ctx.energySeeded = true;
    }
    const eregen = ek.energyRegenRate ?? 0.25;
    const boosting = ctx.mirror.boostingShips?.has(ctx.mirror.localPlayerId) ?? false;
    for (let s = 0; s < stepsThisFrame; s++) {
      ctx.predEnergy = regenEnergyStep(ctx.predEnergy, emax, eregen);
      if (boosting) ctx.predEnergy = spendEnergy(ctx.predEnergy, BOOST_TICK_COST);
    }
  }
}

/** The cap-engaged zero-step sentinel input (plan: spiral-fix, Phase 2 step 3). */
export function sendCapSentinel(
  ctx: PredictionStepCtx, room: Room, kb: KeyboardBits, stepsThisFrame: number, capEngaged: boolean,
): void {
  if (
    stepsThisFrame === 0
    && capEngaged
    && !ctx.localDead
    && ctx.predWorld
    && ctx.reconciler
    && ctx.mirror.localPlayerId
  ) {
    let tcThrust2 = false, tcTurnLeft2 = false, tcTurnRight2 = false, tcFire2 = false;
    if (ctx.touchInput) {
      tcFire2 = ctx.touchInput.getFireHeld();
      const v = ctx.touchInput.getJoystickVector();
      // Render-jitter-fix Phase 1: same rule as the in-loop joystick
      // read — hysteresis MUST track REAL-TIME predWorld angle, not
      // the dead-reckoned mirror angle.
      const predState = ctx.predWorld?.getShipState(ctx.mirror.localPlayerId) ?? null;
      const localShip = ctx.mirror.ships.get(ctx.mirror.localPlayerId);
      const realAngle = predState?.angle ?? localShip?.angle ?? null;
      if (realAngle !== null) {
        const next = joystickToInput(v, realAngle, ctx.joystickInputState, ctx.predWorld.maxTurnPerTick(ctx.mirror.localPlayerId));
        ctx.joystickInputState = next;
        tcTurnLeft2 = next.turnLeft;
        tcTurnRight2 = next.turnRight;
        tcThrust2 = next.thrust;
      }
    }
    // Helm: the sentinel re-sends the last helm bits (no new tick to step).
    const helm2 = ctx.helmOrder.active ? ctx.helmOut : null;
    const db2 = ctx.disableBits;
    db2.thrust = kb.thrust || tcThrust2 || (helm2?.thrust ?? false);
    db2.turnLeft = kb.turnLeft || tcTurnLeft2 || (helm2?.turnLeft ?? false);
    db2.turnRight = kb.turnRight || tcTurnRight2 || (helm2?.turnRight ?? false);
    db2.boost = kb.boost || (ctx.touchInput?.getBoostHeld() ?? false) || aimInput.getBoostHeld();
    db2.reverse = kb.reverse;
    gateDisabledInput(ctx.isLocallyDisabled(), db2);
    const thrust    = db2.thrust;
    const turnLeft  = db2.turnLeft;
    const turnRight = db2.turnRight;
    // tcFire2 is sampled for parity with the in-loop block but the
    // sentinel never spawns a fire — fire is per-tick and we're not
    // advancing inputTick. Reading it (rather than dropping the var)
    // keeps the touch state machine consistent with the in-loop path.
    void tcFire2;
    const boost     = db2.boost;
    // Energy-gate boost identically to the per-tick path so the sentinel
    // re-send carries the same value the server will apply (and that the
    // per-tick path predicted) — keeps `lastSentInputState` consistent.
    const boostApplied = boost && canAfford(ctx.predEnergy, BOOST_TICK_COST);
    const reverse   = db2.reverse ?? false;
    const tick = ctx.inputTick; // NOT incremented; sentinel rides at the last-sent tick
    const nowMs = ctx.clock.now();
    const last = ctx.lastSentInputState;
    const wx = ctx.warpRequest?.x, wy = ctx.warpRequest?.y;
    const allIdle = !thrust && !turnLeft && !turnRight && !boostApplied && !reverse && wx === undefined;
    const lastAllIdle = !!last && !last.thrust && !last.turnLeft && !last.turnRight && !last.boost && !last.reverse && last.warpX === undefined;
    const stateChanged = !last
      || last.thrust !== thrust
      || last.turnLeft !== turnLeft
      || last.turnRight !== turnRight
      || last.boost !== boostApplied
      || last.reverse !== reverse
      || last.warpX !== wx
      || last.warpY !== wy;
    const heartbeatDue = nowMs - ctx.lastSentInputAtMs >= INPUT_HEARTBEAT_MS;
    const throttle = allIdle && lastAllIdle && !stateChanged && !heartbeatDue;
    if (!throttle) {
      // Pooled send payload — reuses the same scratch as the per-tick
      // path. cap-engaged sentinel fires at-most-once per RAF (60-120
      // /sec) so the alloc rate here is lower than the per-tick path,
      // but the pattern duplicates — keep the pool consistent.
      if (wx !== undefined && wy !== undefined) {
        const w = ctx.sendWarpInputScratch;
        w.tick = tick; w.thrust = thrust; w.turnLeft = turnLeft; w.turnRight = turnRight;
        w.boost = boostApplied; w.reverse = reverse; w.warpX = wx; w.warpY = wy;
        room.send('input', w);
      } else {
      const sendArg = ctx.sendInputScratch;
      sendArg.tick = tick;
      sendArg.thrust = thrust;
      sendArg.turnLeft = turnLeft;
      sendArg.turnRight = turnRight;
      sendArg.boost = boostApplied;
      sendArg.reverse = reverse;
      room.send('input', sendArg);
      }
      // lastSentInputState retains state across ticks — mutate in
      // place to avoid aliasing the per-tick scratch.
      const stored = ctx.lastSentInputState;
      if (stored) {
        stored.thrust = thrust;
        stored.turnLeft = turnLeft;
        stored.turnRight = turnRight;
        stored.boost = boostApplied;
        stored.reverse = reverse;
        stored.warpX = wx;
        stored.warpY = wy;
      } else {
        ctx.lastSentInputState = { thrust, turnLeft, turnRight, boost: boostApplied, reverse, warpX: wx, warpY: wy };
      }
      ctx.lastSentInputAtMs = nowMs;
      // Always log on sentinel send (no stateChanged / tick%60 gate) so
      // `assertInputFlowMaintained` sees the per-RAF cadence during a
      // sustained cap engagement — this is the explicit anti-regression
      // for the 6e4d9c2 class. Gated by full-diag-mode at the callsite
      // (Phase 5e — invariant #14); the assertion only runs under diag.
      if (isFullDiagMode()) {
        logEvent('inputSent', { tick, thrust, turnLeft, turnRight, boost: boostApplied, reverse });
      }
    }
  }
}

// ── Helm orders + local mount aim (moved verbatim out of ColyseusClient) ──

/** Helm orders: set the course point (game space); the autopilot asks for a way there. */
export function setHelmCourse(ctx: PredictionStepCtx, x: number, y: number): void {
  if (!ctx.helmAvailable) return;
  ctx.helmOrder.tx = x;
  ctx.helmOrder.ty = y;
  ctx.helmOrder.active = true;
  ctx.helmRoute.course(ctx.helmOrder, ctx.gameClock.now());
  ctx.helmCourseSeq++;
  publishHelm(ctx);
}

/** Helm orders: stop, one third, two thirds or full. */
export function setHelmSpeed(ctx: PredictionStepCtx, speed: HelmSpeed): void {
  ctx.helmOrder.speed = speed;
  publishHelm(ctx);
}

/** Cancel the course (WASD does this too). */
export function clearHelm(ctx: PredictionStepCtx): void {
  if (!ctx.helmOrder.active) return;
  ctx.helmOrder.active = false;
  ctx.helmRoute.clear(ctx.helmOrder);
  ctx.helmOut.thrust = false; ctx.helmOut.turnLeft = false; ctx.helmOut.turnRight = false;
  publishHelm(ctx);
}

export function publishHelm(ctx: PredictionStepCtx): void {
  useUIStore.getState().setHelmState(ctx.helmAvailable, ctx.helmOrder.active, ctx.helmOrder.speed);
  syncHelmMark(ctx);
}

/** Helm move marker: show the course point only for the pilot's own
 *  capital under an active order, never while spectating. Alloc-free. */
export function syncHelmMark(ctx: PredictionStepCtx): void {
  const spectating = useUIStore.getState().pilotMode === 'spectator';
  const show = resolveHelmCourseMark(ctx.helmOrder, ctx.helmAvailable, spectating, ctx.helmCourseSeq, ctx.helmMark);
  const next = show ? ctx.helmMark : null;
  if (ctx.mirror.helmCourse !== next) ctx.mirror.helmCourse = next;
}

/** Helm availability follows the ship you fly (id compare; free when unchanged). */
export function updateHelmAvailability(ctx: PredictionStepCtx): void {
  const id = ctx.mirror.localPlayerId;
  const kindId = id ? ctx.mirror.ships.get(id)?.kind ?? null : null;
  if (kindId === ctx.helmKindId) return;
  ctx.helmKindId = kindId;
  ctx.helmAvailable = kindId !== null; // every hull takes helm orders (navigation slice 13)
  if (!ctx.helmAvailable) clearHelm(ctx);
  publishHelm(ctx);
}

/** One helm tick off the real-time predicted pose (same source the stick reads). */
export function stepHelm(ctx: PredictionStepCtx): void {
  const id = ctx.mirror.localPlayerId;
  const s = id ? ctx.predWorld?.getShipState(id) ?? null : null;
  if (s === null || ctx.helmKindId === null) return;
  const p = ctx.helmPose;
  p.x = s.x; p.y = s.y; p.angle = s.angle; p.vx = s.vx; p.vy = s.vy; p.angvel = s.angvel ?? 0;
  ctx.helmRoute.tick(ctx.gameClock.now());
  const idx = ctx.helmOrder.route?.idx ?? -1;
  helmStep(ctx.helmOrder, p, getShipKind(ctx.helmKindId), ctx.helmOut);
  if (ctx.helmOut.arrived) clearHelm(ctx);
  else if ((ctx.helmOrder.route?.idx ?? -1) !== idx) syncHelmMark(ctx); // a turn passed: the route line drops it
}

/**
 * The local ship's predicted turret angles (#12): each mount slews toward
 * its weapon group's lock (first LOCKED target, else the one being
 * acquired, so the barrel pre-slews), or back to base when the group holds
 * none — `fcTickMountAngles`, the client mount-angle path, mirroring the
 * server's WeaponMountTicker (#15). Aims from the RENDERED (mirror) pose the
 * beam is drawn from, never the lagging predicted pose (locked by
 * ColyseusClient.liveBeamMountAimPose.test.ts).
 *
 * `mountAngles` is CATALOGUE-indexed everywhere it is read (the renderer
 * beam direction + the turret sprites): the array is sized by the full
 * per-instance mount list `[...kind.mounts, ...activated latent]` (WS-B3),
 * the same index space the server ticker writes.
 */
export function tickLocalMountAim(ctx: PredictionStepCtx, dtSec: number): void {
  const localId = ctx.mirror.localPlayerId;
  if (!localId || !ctx.predWorld) return;
  const ship = ctx.mirror.ships.get(localId);
  if (!ship) return;
  if (!ctx.predWorld.getShipState(localId)) return;
  const catalogueMounts = resolveInstanceMounts(getShipKind(ship.kind ?? null), ship.activatedMounts);
  if (catalogueMounts.length === 0) {
    if (ship.mountAngles) ship.mountAngles = undefined;
    return;
  }
  // number[] is fine — N is small (1–3) and the array survives many frames.
  let angles = ship.mountAngles;
  if (!angles || angles.length !== catalogueMounts.length) {
    angles = new Array<number>(catalogueMounts.length).fill(0);
    ship.mountAngles = angles;
  }
  ctx.fc.fcSyncKind(ship.kind ?? null);
  ctx.fc.fcTickMountAngles(angles, catalogueMounts, ship.x, ship.y, ship.angle, dtSec);
}
