/**
 * F-transit-instrument — gated, discrete client-ts timeline for the
 * inter-sector transit (warp-out → arrival → settle) path.
 *
 * Motivation (`docs/HANDOFF-warp-spool-perf-followup.md`, sections
 * "F3 HYPOTHESIS FALSIFIED" / "ROOM-SWAP HYPOTHESIS ALSO FALSIFIED" /
 * "NEXT (F-transit-instrument)"): on-device captures localised a
 * ~300 ms residual frame-stall to client-ts ≈ 17546–17852 — ~2 s AFTER
 * warp arrival, curtain already down, settled in the destination
 * sector. It is NOT CPU (F1 markers < 2.5 ms through it), NOT the warp
 * filters (same-device sandbox A/B), NOT the room-swap mechanics
 * (timing). The killer fact: there are ZERO client `logEvent` rows
 * anywhere near ts 17546 — the warp-out→arrival→settle path emits no
 * client diagnostics, so we are blind. This helper makes that window
 * NOT blind with a self-contained single-clock timeline.
 *
 * Boundary: the transit path is MAIN-THREAD (the `ColyseusGameClient`
 * room-swap handlers + the `App.tsx` phase machine / curtain effect /
 * rAF loop), so this uses `logEvent` DIRECTLY — NO protocol.ts /
 * worker / RendererFeedback change. The instance lives on
 * `ColyseusGameClient` (it survives the room hot-swap) and is reached
 * from `App.tsx` via `getGameClient()`.
 *
 * Gating: identical model to F1 — every method early-outs when
 * `isDiagEnabled()` is false (resolved ONCE at construction). When off:
 * no `performance.now()` spans, no `logEvent`, no array growth, no
 * counter mutation. Production pays ZERO cost.
 *
 * Tags (both routed to the `perf` bucket in
 * `src/server/routes/diagRouter.ts`, so they land in `perf.ndjson`
 * alongside `raf_gap` / `rafTick` for correlation):
 *   - `transit_mark  { phase, sinceEngageMs, stepMs?, ...extra }`
 *   - `transit_frame { idx, sinceCurtainMs, elapsedMs, spriteCount? }`
 *   - a final `transit_mark { phase: 'settled', ... }` closes the burst.
 *
 * Every row carries the client `performance.now()` ts (stamped by
 * `logEvent`) AND `sinceEngageMs`, so the timeline is self-contained:
 * no cross-clock arithmetic is needed to read it.
 *
 * This is a DATA tool, not a regression lock. It changes no transit
 * timing or logic.
 */
import { logEvent, isDiagEnabled } from './ClientLogger';

/** Hard cap on the post-reveal frame burst. After this many rendered
 *  frames the burst self-disables and emits `settled` exactly once.
 *  Never an unbounded per-frame logger. */
const FRAME_BURST_CAP = 40;

export class TransitInstrumentation {
  /** Resolved once — the whole document's diag state is fixed for its
   *  lifetime, so re-deriving per call would be waste (mirrors
   *  `ClientLogger.isDiagEnabled`'s own caching rationale). */
  private readonly enabled: boolean;

  /** `performance.now()` captured at `engage()` — the t0 every
   *  `sinceEngageMs` is measured against. -1 ⇒ no transit in flight. */
  private engageAt = -1;
  /** `performance.now()` of the previous mark, for `stepMs`. */
  private lastMarkAt = -1;

  /** `performance.now()` at the most recent `curtainDown()`; the
   *  post-reveal frame burst measures `sinceCurtainMs` against it.
   *  -1 ⇒ burst not armed. */
  private curtainDownAt = -1;
  /** Frames emitted in the current burst (0..FRAME_BURST_CAP). */
  private frameIdx = 0;
  /** Latched true once `settled` has been emitted for this burst, so
   *  the cap is a true one-shot even if extra frames arrive. */
  private burstClosed = false;

  /** Per-key one-shot "already fired" latch. */
  private readonly firedOnce = new Set<string>();
  /**
   * Per-key "armed" gate for `markOnce`. The repeating handlers that
   * back `first_state` (`onStateChange`) and `first_snapshot`
   * (`snapshot`) are bound on BOTH the source and destination rooms,
   * and the SOURCE room keeps emitting them between `engage()` and the
   * room swap. Without an explicit arm, `markOnce` would latch on a
   * SOURCE-room tick during spool — NOT the destination's first, which
   * is the timeline-meaningful one (the spec's "first … in the NEW
   * room"). So `markOnce` fires only after `arm(key)`; the room-swap
   * site arms these the instant the destination room is bound.
   */
  private readonly armed = new Set<string>();

  constructor() {
    this.enabled = isDiagEnabled();
  }

  /** True when diagnostics are active. Lets callers skip even
   *  assembling an `extra` object on the hot/normal path. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Transit initiated — this is t0. Resets all per-transit latches so
   * a second warp in the same session produces a fresh, independent
   * timeline. Safe to call when disabled (no-op).
   */
  engage(extra?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const now = performance.now();
    this.engageAt = now;
    this.lastMarkAt = now;
    this.curtainDownAt = -1;
    this.frameIdx = 0;
    this.burstClosed = false;
    this.firedOnce.clear();
    this.armed.clear();
    logEvent('transit_mark', {
      phase: 'engage',
      sinceEngageMs: 0,
      stepMs: 0,
      ...(extra ?? {}),
    });
  }

  /**
   * Emit a discrete transit lifecycle/span mark. `stepMs` is the time
   * since the previous mark (any phase). No-op when disabled or when
   * no transit is in flight (`engage()` not yet called / already
   * settled) — defensive so a stray late event can't emit a row with
   * a negative `sinceEngageMs`.
   */
  mark(phase: string, extra?: Record<string, unknown>): void {
    if (!this.enabled || this.engageAt < 0) return;
    const now = performance.now();
    const stepMs = this.lastMarkAt >= 0 ? now - this.lastMarkAt : 0;
    this.lastMarkAt = now;
    logEvent('transit_mark', {
      phase,
      sinceEngageMs: now - this.engageAt,
      stepMs,
      ...(extra ?? {}),
    });
  }

  /**
   * Arm a `markOnce` key so its NEXT occurrence emits. Called at the
   * room-swap site for `first_state` / `first_snapshot` so they bind to
   * the DESTINATION room's first tick, not a source-room tick that the
   * still-attached source handlers emit during spool. No-op when
   * disabled / no transit in flight / already armed.
   */
  arm(key: string): void {
    if (!this.enabled || this.engageAt < 0) return;
    this.armed.add(key);
  }

  /**
   * Like `mark`, but only the FIRST call for `key` AFTER it has been
   * `arm()`-ed emits, and only once per transit. Use for repeating
   * events whose first DESTINATION-room occurrence is the
   * timeline-interesting one (`first_state`, `first_snapshot`). The
   * arm gate is essential: the backing handlers are bound on the
   * source room too and keep firing between `engage()` and the swap.
   * `key` defaults to `phase`.
   */
  markOnce(phase: string, extra?: Record<string, unknown>, key = phase): void {
    if (!this.enabled || this.engageAt < 0) return;
    if (!this.armed.has(key)) return;
    if (this.firedOnce.has(key)) return;
    this.firedOnce.add(key);
    this.mark(phase, extra);
  }

  /**
   * The arrival curtain dropped for THIS transit (loading → ready).
   * Records the curtain-down instant and ARMS the bounded post-reveal
   * frame burst. Idempotent within a transit (re-arming would restart
   * the burst and double-count) — only the first call per transit
   * arms it.
   */
  curtainDown(extra?: Record<string, unknown>): void {
    if (!this.enabled || this.engageAt < 0) return;
    // One curtain-down per transit. A later spurious `loading` flip
    // must not restart the burst.
    if (this.curtainDownAt >= 0) return;
    this.curtainDownAt = performance.now();
    this.frameIdx = 0;
    this.burstClosed = false;
    this.mark('curtain_down', extra);
  }

  /** True while the bounded post-reveal burst still wants frames.
   *  Lets the rAF loop skip the (cheap) feedback read entirely when
   *  the burst isn't active. */
  wantsFrame(): boolean {
    return (
      this.enabled &&
      this.curtainDownAt >= 0 &&
      !this.burstClosed &&
      this.frameIdx < FRAME_BURST_CAP
    );
  }

  /**
   * Record one rendered frame in the post-reveal burst. Emits
   * `transit_frame { idx, sinceCurtainMs, elapsedMs, spriteCount? }`
   * for idx 0..FRAME_BURST_CAP-1, then emits a single
   * `transit_mark { phase: 'settled' }` and self-disables. HARD CAP —
   * never an unbounded per-frame logger.
   *
   * @param elapsedMs that frame's wall delta (rAF `now - lastFrameTime`).
   * @param spriteCount optional — omit if not cheaply reachable on main.
   */
  frame(elapsedMs: number, spriteCount?: number): void {
    if (!this.wantsFrame()) return;
    const idx = this.frameIdx++;
    logEvent('transit_frame', {
      idx,
      sinceCurtainMs: performance.now() - this.curtainDownAt,
      elapsedMs,
      ...(spriteCount !== undefined ? { spriteCount } : {}),
    });
    if (this.frameIdx >= FRAME_BURST_CAP && !this.burstClosed) {
      this.burstClosed = true;
      // Close the timeline. `mark` recomputes sinceEngageMs/stepMs so
      // `settled` is anchored to the same single clock as every other
      // row — the ts-17546 stall now falls INSIDE a numbered
      // `transit_frame` bracketed by `curtain_down` … `settled`.
      this.mark('settled', { frames: idx + 1 });
      // Disarm so a stray post-settle frame can't emit anything.
      this.engageAt = -1;
      this.curtainDownAt = -1;
    }
  }

  /**
   * Plan: crispy-kazoo, Commit 6 — reset every per-transit latch + the
   * one-shot ledger so a GameSurface remount sees a clean instance.
   */
  dispose(): void {
    this.engageAt = -1;
    this.lastMarkAt = -1;
    this.curtainDownAt = -1;
    this.frameIdx = 0;
    this.burstClosed = false;
    this.firedOnce.clear();
    this.armed.clear();
  }
}
