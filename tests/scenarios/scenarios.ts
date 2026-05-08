/**
 * High-level scenario → events translator. Stage 4.5 of the network-feel
 * roadmap.
 *
 * A `Scenario` describes the network and device conditions; this module
 * generates the corresponding stream of `rafTick` and `snapshot` events
 * the harness's `runScenario` will process.
 *
 * Modelling notes:
 *
 * - **Server side**. Server runs at 60 Hz; broadcasts every 3 server ticks
 *   (20 Hz default). `serverTick` advances 3 per broadcast.
 * - **Held-ack-advance** (per `src/core/physics/inputQueue.ts`). Server's
 *   `ackedTick` advances at the full server rate regardless of how fast
 *   the client sends inputs — once the first input has been applied,
 *   queue-empty ticks fire the held-input branch which synthesises an
 *   ack +1 per server tick. We model this as
 *   `ackedTick = startInputTick + (currentServerTick - startServerTick) - 1`
 *   (a 1-tick processing lag).
 * - **Network gaps**. A gap freezes inbound snapshot delivery. After the
 *   gap, the queued snapshots arrive in a tight burst spread over the
 *   next 200 ms (matching the burst-recovery shape observed in real
 *   diagnostics).
 * - **`lastRtt`** is `arrivalMs - sendMs` — the value
 *   `Reconciler.lastRtt` would compute. For steady-state snapshots that's
 *   the baseline RTT; for gap-delayed snapshots it's the gap duration
 *   plus residual.
 */
import type { Event } from './types';

export interface Scenario {
  name: string;
  /** Client's renderloop rate. 60 = desktop baseline; 10–15 = mobile under load. */
  rafTickHz: number;
  /** One-way network RTT in ms (baseline). */
  rttMs: number;
  /** Optional gaussian-equivalent jitter on RTT (ms σ). Default 0. */
  jitterMs?: number;
  /** Server broadcast cadence in Hz. Default 20 (every 3 server ticks). */
  snapshotPatternHz?: number;
  /** Optional inbound network gaps. */
  gapsMs?: ReadonlyArray<{ atMs: number; durationMs: number }>;
  /** Total scenario duration in ms. */
  durationMs: number;
}

const START_INPUT_TICK = 100;
const START_SERVER_TICK = 100;

export function buildScenarioEvents(scenario: Scenario): Event[] {
  const events: Event[] = [];
  const rafIntervalMs = 1000 / scenario.rafTickHz;
  const snapIntervalMs = 1000 / (scenario.snapshotPatternHz ?? 20);
  const ticksPerSnapshot = 60 / (scenario.snapshotPatternHz ?? 20);
  const rtt = scenario.rttMs;
  const gaps = scenario.gapsMs ?? [];

  // ── rafTick events (uniform cadence) ─────────────────────────────────
  for (let t = rafIntervalMs; t <= scenario.durationMs; t += rafIntervalMs) {
    events.push({ type: 'rafTick', atMs: t, dtMs: rafIntervalMs });
  }

  // ── snapshot events ──────────────────────────────────────────────────
  // First, build the server's schedule of broadcasts.
  const broadcasts: Array<{ sendMs: number; serverTick: number }> = [];
  for (
    let t = 0, sTick = START_SERVER_TICK;
    t <= scenario.durationMs;
    t += snapIntervalMs, sTick += ticksPerSnapshot
  ) {
    broadcasts.push({ sendMs: t, serverTick: sTick });
  }

  // Determine arrival time per broadcast, accounting for gaps.
  // A gap freezes inbound delivery; queued snapshots arrive burst-fashion
  // over a 200 ms window after the gap ends.
  const BURST_WINDOW_MS = 200;
  for (const b of broadcasts) {
    const inGap = gaps.find((g) => b.sendMs >= g.atMs && b.sendMs < g.atMs + g.durationMs);
    let arrivalMs: number;
    if (inGap) {
      const gapEnd = inGap.atMs + inGap.durationMs;
      const offsetInGap = b.sendMs - inGap.atMs;
      const fractionInGap = inGap.durationMs > 0 ? offsetInGap / inGap.durationMs : 0;
      arrivalMs = gapEnd + fractionInGap * BURST_WINDOW_MS;
    } else {
      arrivalMs = b.sendMs + rtt;
    }
    if (arrivalMs > scenario.durationMs) continue;

    // ackedTick = held-ack-advance equivalent (server-rate increment minus a 1-tick lag).
    const ackedTick = START_INPUT_TICK + (b.serverTick - START_SERVER_TICK) - 1;
    const lastRtt = arrivalMs - b.sendMs;
    events.push({
      type: 'snapshot',
      atMs: arrivalMs,
      serverTick: b.serverTick,
      ackedTick,
      lastRtt,
    });
  }

  // Order all events by time. rafTicks and snapshots may interleave.
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}
