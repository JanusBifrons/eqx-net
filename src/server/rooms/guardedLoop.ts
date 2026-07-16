/**
 * Error boundary for the authoritative loops (campaign PR 1.1; anti-patterns
 * review 2026-07, C-server 1 / Part D #15).
 *
 * The SectorRoom setImmediate sim loop, the LivingWorldDirector control tick,
 * and the structure grid / turret / selection-stats interval timers all run
 * on the ONE server process. Before this boundary existed, an exception
 * escaping any of those callbacks was an uncaught exception — killing every
 * galaxy sector and the director in one shot (and inside the sim loop it
 * also silently ended the loop: the tail `setImmediate(loop)` never ran).
 *
 * `guarded(label, fn)` wraps a loop/timer callback so a throwing subsystem
 * logs-and-continues — the same discipline `SectorPersistence` and the
 * snapshot send already use, applied at the top-level loops. Error logs are
 * throttled per boundary (a throw-every-tick subsystem must not firehose the
 * log at 60 Hz); the periodic re-log carries the suppressed count so the
 * ongoing failure stays visible.
 *
 * Happy path is allocation-free (invariant #14): a try/catch allocates
 * nothing unless it throws, and the throttle state lives in the closure.
 */
import { pino } from 'pino';

const logger = pino({
  name: 'guarded-loop',
  transport: process.env['NODE_ENV'] !== 'production' ? { target: 'pino-pretty' } : undefined,
});

export type GuardedErrorSink = (label: string, err: unknown, suppressedSinceLastLog: number) => void;

/** Minimum ms between error logs per boundary; throws in between are counted, not logged. */
export const GUARDED_LOG_THROTTLE_MS = 5_000;

const defaultSink: GuardedErrorSink = (label, err, suppressed) => {
  logger.error({ err, label, suppressed }, 'guarded loop callback threw — iteration skipped, loop continues');
};

/**
 * Wrap a tick/timer callback so a throw is contained (logged, throttled)
 * instead of escaping the event-loop callback. `nowMs` is injectable for
 * deterministic throttle tests.
 */
export function guarded(
  label: string,
  fn: () => void,
  onError: GuardedErrorSink = defaultSink,
  nowMs: () => number = Date.now,
): () => void {
  let lastLogAtMs = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return () => {
    try {
      fn();
    } catch (err) {
      const now = nowMs();
      if (now - lastLogAtMs >= GUARDED_LOG_THROTTLE_MS) {
        onError(label, err, suppressed);
        lastLogAtMs = now;
        suppressed = 0;
      } else {
        suppressed++;
      }
    }
  };
}
