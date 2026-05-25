/**
 * Deterministic WS latency+jitter profile for the Phase-1 netcode gate
 * (plan: e2e-rebuild). Pure, seeded, zero IO — locked by
 * `latencyProfile.test.ts`. Consumed by `eqxLatencyProxy.ts`.
 *
 * The gate injects a FIXED adverse network so the dominant variable is
 * the injected RTT, not the host CPU (that is what makes the gate
 * machine-insensitive). Reproducibility is everything: same seed ⇒
 * byte-identical realisation, so the baseline and HEAD arms suffer the
 * exact same network and differ ONLY by the code under test.
 *
 * NO PACKET DROP. The Colyseus WS is tunneled over TCP; dropping bytes
 * at an application proxy does not model packet loss — it corrupts the
 * WS frame stream and kills the connection. The proxy delivers every
 * byte, in order, just LATER (and with jittered gaps). Variable
 * inter-arrival from jitter is the netcode stressor; ordered delivery is
 * a correctness requirement enforced by the proxy's relay, not here.
 */

/**
 * mulberry32 — COPIED here, deliberately NOT imported from
 * `src/server/livingworld/population.ts` (boundary invariant #1:
 * `tests/` infra must not import server product code). Byte-identical
 * algorithm so the behaviour is auditable against the in-repo original.
 */
export function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Direction = 'c2s' | 's2c';

export interface LatencyProfileSpec {
  /** One-way base delay (ms). RTT ≈ 2 × baseMs. */
  baseMs: number;
  /** One-way uniform jitter half-range (ms): delay ∈ [base−jitter, base+jitter]. */
  jitterMs: number;
  /** Fixed PRNG seeds — one independent stream per direction. */
  seedC2S: number;
  seedS2C: number;
}

/**
 * The ONLY profile the real gate runs on: ≈120 ms RTT ±60. Derived from
 * the incident captures (≈120 ms ±60, ~20 Hz). Lossless by construction
 * (TCP-tunneled WS — see header).
 */
export const PROFILE_PRIMARY: LatencyProfileSpec = {
  baseMs: 60,
  jitterMs: 30,
  seedC2S: 0x9e3779b1,
  seedS2C: 0x85ebca77,
};

/**
 * Acceptance self-test ONLY — a deliberately, unambiguously worse
 * network (≈280 ms RTT, ±180 jitter) used to prove the gate FAILs on an
 * injected network regression. NEVER used by the real gate (that would
 * make the gate test the proxy, not the code). TCP-safe: worse via
 * latency/jitter, no drops.
 */
export const PROFILE_REGRESSION_INJECT: LatencyProfileSpec = {
  baseMs: 140,
  jitterMs: 90,
  seedC2S: 0x9e3779b1,
  seedS2C: 0x85ebca77,
};

/**
 * Stateful per-connection scheduler. `delayFor` returns a deterministic
 * one-way delay (ms, ≥ 0); it NEVER re-paces (delays only) so the
 * server's 20 Hz snapshot cadence is preserved and `snapshotJitterMs`
 * stays a real signal. Two independent seeded streams: c2s and s2c.
 */
export class LatencyScheduler {
  private readonly rngDelay: Record<Direction, () => number>;

  constructor(private readonly spec: LatencyProfileSpec) {
    this.rngDelay = {
      c2s: makeSeededRng(spec.seedC2S),
      s2c: makeSeededRng(spec.seedS2C),
    };
  }

  /** One-way delay (ms) for the next chunk in `dir`, ≥ 0. Deterministic
   *  given the seed + the call sequence on this direction. */
  delayFor(dir: Direction): number {
    const r = this.rngDelay[dir](); // [0,1)
    const d = this.spec.baseMs + (r * 2 - 1) * this.spec.jitterMs;
    return d < 0 ? 0 : d;
  }
}
