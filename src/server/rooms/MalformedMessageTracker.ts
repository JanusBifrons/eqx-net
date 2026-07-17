/**
 * Per-connection malformed-message accounting + SAMPLED warn (campaign PR
 * 1.3; anti-patterns review 2026-07, C-server 3).
 *
 * Invariant #3 / the server Validation Contract has two halves: (1) zod-parse
 * and drop every inbound message — implemented everywhere; (2) "increment a
 * per-connection error counter, sampled `pino.warn`" — which every handler
 * DOCSTRING claimed while every site actually emitted an UNSAMPLED
 * `logger.warn` per malformed packet and no counter existed. A client
 * spraying malformed packets (the `input` channel accepts up to 3/tick =
 * 180/s) firehosed the gameplay log at full rate — the log-amplification DoS
 * the contract was written to prevent.
 *
 * One tracker per room; all `onMessage` handlers route their parse failures
 * through `record(sessionId, messageType)`. Warn policy: the FIRST malformed
 * packet per connection always logs (an honest client bug surfaces
 * immediately), then every `sampleEvery`-th after that, always carrying the
 * running total so the flood magnitude stays visible. `clear(sessionId)` on
 * leave prevents the map leaking across reconnects.
 *
 * Hot-loop note (invariant #14): `record` is reachable from `onMessage` — a
 * Map get/set and integer math; the log-fields object is allocated only on
 * the sampled calls (1st + every Nth), which is exactly the bounded rate the
 * sampler exists to enforce.
 */

export interface MalformedWarnSink {
  warn(fields: { sessionId: string; messageType: string; malformedCount: number }, msg: string): void;
}

export const MALFORMED_SAMPLE_EVERY = 25;

export class MalformedMessageTracker {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly logger: MalformedWarnSink,
    private readonly sampleEvery: number = MALFORMED_SAMPLE_EVERY,
  ) {}

  /** Record one dropped malformed packet; warn on the 1st and every Nth. */
  record(sessionId: string, messageType: string): void {
    const n = (this.counts.get(sessionId) ?? 0) + 1;
    this.counts.set(sessionId, n);
    if (n === 1 || n % this.sampleEvery === 0) {
      this.logger.warn(
        { sessionId, messageType, malformedCount: n },
        'malformed client message dropped (sampled)',
      );
    }
  }

  /** Total malformed packets recorded for a connection (diagnostics/tests). */
  countFor(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  /** Forget a connection — call from onLeave so reconnect churn can't leak. */
  clear(sessionId: string): void {
    this.counts.delete(sessionId);
  }
}
