/**
 * User-contract assertions for replay traces. These are the things the
 * USER sees and reasons about — independent of which fix is being
 * evaluated. Plan: capture-driven replay infra, Phase D (2026-05-21).
 *
 * **The anti-pattern these prevent**: every fix attempt over the past 5
 * days defined a metric that the fix moves and asserted the metric was
 * bounded. That's circular — the test passes iff the fix engages, not
 * iff the user's experience is correct. These assertions are
 * fix-agnostic: they describe the SHIP's behaviour as the user perceives
 * it ("no teleport", "input gets to the server", "drift recovers"), not
 * the internal state machine's bookkeeping.
 *
 * Each assertion takes a `ReplayTrace` (produced by `captureHarness.ts`)
 * and returns a `ContractResult` listing all violations with
 * timestamps. Tests fail with the FIRST violation, but the result
 * carries all violations so debugging shows the whole picture.
 */
import type { ReplayTrace } from './ReplayTrace';

export interface ContractViolation {
  /** Wall-clock ms at the violation (from MockClock at the offending RAF). */
  atMs: number;
  /** Short kind label — "teleport" / "input_starvation" / "drift_unrecovered" / "ticksAhead_unbounded". */
  kind: string;
  /** Human-readable detail with the offending numbers inline. */
  detail: string;
}

export interface ContractResult {
  pass: boolean;
  violations: ContractViolation[];
}

const FIXED_HZ = 60;
const MS_PER_TICK = 1000 / FIXED_HZ;

/**
 * Maximum credible per-frame movement for the local ship. Derived from
 * the catalogue's fastest kind: an interceptor at full burn + boost is
 * ~600 u/s — that's 10 u per RAF at 60 Hz. A 50 u/frame delta would be
 * 3000 u/s, well past any ship's top speed, and is the signature of a
 * reconciler snap-back ("teleport") that the user sees as the ship
 * jumping rather than gliding.
 *
 * The cap-fix bug (6e4d9c2) produced exactly this signature: cap
 * disengaged, catch-up loop fired 4 ticks at once → 4× the normal
 * per-frame motion vector → ~40-60 u jumps. The user reported
 * "teleporting all over the place" — this assertion catches it.
 */
const TELEPORT_DELTA_UNITS = 30;

/**
 * Frame-to-frame discontinuity check. Iterates `renderedPoses` and
 * flags any consecutive pair with position delta > maxDeltaUnits.
 */
export function assertNoTeleport(
  trace: ReplayTrace,
  opts?: { maxDeltaUnits?: number },
): ContractResult {
  const maxDeltaUnits = opts?.maxDeltaUnits ?? TELEPORT_DELTA_UNITS;
  const violations: ContractViolation[] = [];
  const samples = trace.renderedPoses;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    // Skip pairs that span more than ~2 RAFs of wall-clock — the
    // intervening frames may have been below the rafTick log cadence
    // (long pause / focus loss). Real on-device captures have these
    // gaps; a true teleport is between ADJACENT rendered frames.
    if (cur.atMs - prev.atMs > 3 * MS_PER_TICK + 5) continue;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDeltaUnits) {
      violations.push({
        atMs: cur.atMs,
        kind: 'teleport',
        detail: `frame-to-frame position delta ${dist.toFixed(1)}u (> ${maxDeltaUnits}u) at inputTick=${cur.inputTick} between (${prev.x.toFixed(1)}, ${prev.y.toFixed(1)}) and (${cur.x.toFixed(1)}, ${cur.y.toFixed(1)}) over ${(cur.atMs - prev.atMs).toFixed(1)} ms`,
      });
    }
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Input-flow assertion. Under a sustained held-input window in the
 * captured intent stream, the production code MUST send at least
 * `minPerSecond` `room.send('input', ...)` calls per second. Fewer
 * means the inner-loop in tickPhysics stopped running keyboard.read()
 * — exactly the cap-fix bug from 6e4d9c2 (capture lywvpj: 27
 * consecutive seconds of zero inputs sent while keys were held).
 *
 * Default threshold 30/s — well below the steady-state 60/s but well
 * above 0. Production throttling drops idle frames to ~4 Hz, so the
 * assertion only fires inside windows where the captured input intent
 * was NON-idle (some key pressed).
 */
export function assertInputFlowMaintained(
  trace: ReplayTrace,
  opts?: { minPerSecond?: number; windowMs?: number },
): ContractResult {
  const minPerSecond = opts?.minPerSecond ?? 30;
  const windowMs = opts?.windowMs ?? 1000;
  const violations: ContractViolation[] = [];

  if (trace.inputs.length === 0) {
    // Pre-Phase-A captures have no input_intent stream — the harness
    // saw no held-input windows, so the contract is vacuously
    // satisfied. The replay's faithfulness is asserted by Phase E's
    // ground-truth check, not here.
    return { pass: true, violations };
  }

  // Find held-input windows: contiguous spans of input_intent events
  // where at least one boolean is true. For each window, count
  // inputSent events that fall inside it.
  type Window = { startMs: number; endMs: number };
  const heldWindows: Window[] = [];
  let curStart: number | null = null;
  for (let i = 0; i < trace.inputs.length; i++) {
    const inp = trace.inputs[i]!;
    const isHeld = inp.thrust || inp.turnLeft || inp.turnRight || inp.boost || inp.reverse || inp.fireHeld;
    if (isHeld && curStart === null) {
      curStart = inp.atMs;
    } else if (!isHeld && curStart !== null) {
      heldWindows.push({ startMs: curStart, endMs: trace.inputs[i - 1]!.atMs });
      curStart = null;
    }
  }
  if (curStart !== null) {
    heldWindows.push({ startMs: curStart, endMs: trace.inputs[trace.inputs.length - 1]!.atMs });
  }

  // For each held window, slide a `windowMs` sub-window and check
  // inputSent count.
  for (const w of heldWindows) {
    const duration = w.endMs - w.startMs;
    if (duration < windowMs) continue; // too short to assert on
    for (let t = w.startMs; t + windowMs <= w.endMs; t += windowMs) {
      const inWindow = trace.inputSent.filter((s) => s.atMs >= t && s.atMs < t + windowMs).length;
      // Production throttle skips all-idle frames; in a held window
      // EVERY tick is non-idle so every tick should send.
      if (inWindow < minPerSecond * (windowMs / 1000)) {
        violations.push({
          atMs: t,
          kind: 'input_starvation',
          detail: `held-input window [${t.toFixed(0)}, ${(t + windowMs).toFixed(0)}) ms saw only ${inWindow} inputSent events (< ${minPerSecond}/s) — the input loop stalled while the user was pressing keys (user-perceived "ship ignored my inputs"). Held-window total: ${(w.endMs - w.startMs).toFixed(0)} ms.`,
        });
        // One violation per window is enough for the contract — bail
        // out of the inner loop so a multi-second window doesn't
        // report 30+ violations.
        break;
      }
    }
  }

  return { pass: violations.length === 0, violations };
}

/**
 * ticksAhead-bounded assertion. Under sustained load, the client's
 * lookahead (inputTick - ackedTick) should stay below a reasonable
 * ceiling. Currently asserts on the final stats; for finer-grained
 * assertions we can iterate snapshot events later.
 *
 * Sustained ticksAhead > 60 means the prediction window is > 1 second
 * in the future, which causes the per-snapshot replay window to bloat
 * (capped at BUFFER_SIZE=128 ticks of physics, but that's 200-1000ms
 * of CPU on mobile and saturates the main thread → rafP50 climbs →
 * input loop stalls more → spiral).
 */
export function assertTicksAheadBounded(
  trace: ReplayTrace,
  opts?: { maxFinalTicks?: number },
): ContractResult {
  const maxFinalTicks = opts?.maxFinalTicks ?? 60;
  if (trace.finalStats.ticksAhead <= maxFinalTicks) {
    return { pass: true, violations: [] };
  }
  return {
    pass: false,
    violations: [
      {
        atMs: trace.renderedPoses[trace.renderedPoses.length - 1]?.atMs ?? 0,
        kind: 'ticksAhead_unbounded',
        detail: `final ticksAhead = ${trace.finalStats.ticksAhead} (> ${maxFinalTicks}) — sustained spiral. Client is predicting > ${((trace.finalStats.ticksAhead * MS_PER_TICK) / 1000).toFixed(1)} s into the future relative to server's last ack.`,
      },
    ],
  };
}

/**
 * Ground-truth match assertion (Phase E). For replays produced from a
 * Phase-A-enriched capture, every captured `local_pose_rendered` event
 * should match the harness's replayed-rendered pose within tolerance.
 * If not, the harness is incomplete — fix the harness (more mock
 * surface, capture more fields) BEFORE asserting on production code.
 * This is the "is the harness lying?" check.
 *
 * Tolerance default 0.5 u — allows for float drift in the replay's
 * physics step vs the on-device one (Rapier should be deterministic
 * but the WASM build's float ordering may vary across versions / OSes).
 */
export function assertGroundTruthMatch(
  trace: ReplayTrace,
  opts?: { positionToleranceUnits?: number; angleToleranceRad?: number },
): ContractResult {
  const positionToleranceUnits = opts?.positionToleranceUnits ?? 0.5;
  const angleToleranceRad = opts?.angleToleranceRad ?? 0.01;
  const violations: ContractViolation[] = [];

  if (trace.groundTruth.length === 0) {
    return {
      pass: false,
      violations: [
        {
          atMs: 0,
          kind: 'no_ground_truth',
          detail: 'capture has no `local_pose_rendered` events — pre-Phase-A capture or capture format change. Re-record on the current commit.',
        },
      ],
    };
  }

  for (const gt of trace.groundTruth) {
    const posDelta = Math.hypot(gt.deltaX, gt.deltaY);
    if (posDelta > positionToleranceUnits) {
      violations.push({
        atMs: gt.atMs,
        kind: 'ground_truth_diverged',
        detail: `at inputTick=${gt.capturedInputTick} (atMs=${gt.atMs.toFixed(0)}): captured rendered=(${gt.captured.x.toFixed(2)},${gt.captured.y.toFixed(2)}) replayed=(${gt.replayed.x.toFixed(2)},${gt.replayed.y.toFixed(2)}) — Δpos=${posDelta.toFixed(2)}u (> ${positionToleranceUnits}u). The harness is NOT a faithful surrogate for on-device behaviour at this RAF; investigate before trusting any contract violation on this trace.`,
      });
      // First few violations are enough for diagnosis.
      if (violations.length >= 5) break;
    }
    if (Math.abs(gt.deltaAngle) > angleToleranceRad) {
      violations.push({
        atMs: gt.atMs,
        kind: 'ground_truth_diverged_angle',
        detail: `at inputTick=${gt.capturedInputTick}: angle Δ=${gt.deltaAngle.toFixed(4)}rad (> ${angleToleranceRad})`,
      });
      if (violations.length >= 5) break;
    }
  }

  return { pass: violations.length === 0, violations };
}
