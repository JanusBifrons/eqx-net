/**
 * Late inputs on a slow link → quantised heading corrections
 * (phone play test over a Cloudflare tunnel, capture
 * `2026-11-21T10-33-40Z-fxc3y2`: "the ship jitters left to right").
 *
 * Closed loop, deterministic: the production lead controller
 * (`updateRttAndLookahead`) sizes the client's input lead, inputs cross a
 * jittered uplink into the production server input queue (`tickInputQueue`),
 * snapshots cross a jittered downlink back. A pilot taps turn in short
 * pulses. Whenever an input reaches the server after its tick, the held
 * input stands in for it, so the server's heading differs from the
 * prediction by a whole number of turn steps — the 0.105 / 0.21 rad
 * corrections in the capture.
 *
 * The bug: the lead's RTT sample was `lastRtt − lead`, and with the
 * held-ack rule the ack for tick X arrives `lead` ticks after X was sent
 * whether X was on time or not, so the sample was ~0 on ANY link and the
 * lead sat on its 3-tick floor (capture: ticksAhead p50 3 on a ~100 ms
 * link). The fix sizes the lead from the server-measured input margin.
 */
import { describe, it, expect } from 'vitest';
import { tickInputQueue, inputLeadMargin, type QueuedInput } from '../../core/physics/inputQueue.js';
import { createWelford } from '../../core/math/Welford.js';
import { updateAnchor } from './clockAnchor.js';
import { createLookaheadController } from './lookaheadController.js';
import { updateRttAndLookahead } from './rttLookaheadUpdater.js';
import type { PredictionStats } from './predictionStats.js';
import type { Reconciler } from '../../core/prediction/Reconciler.js';

const FIXED_MS = 1000 / 60;
/** A scout's turn per tick (rad) — only the quantum matters here. */
const TURN = 0.105;
const SNAPSHOT_EVERY = 3;
const RAF_MS = 1000 / 90; // the play-test phone ran at 90 Hz

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LinkModel { baseMs: number; jitterMs: number; spikeChance: number; spikeMs: number }
interface RunResult { snapshots: number; angleCorrections: number[]; leadP50: number }

/** Pilot taps: turn for 2 ticks out of every 7, alternating direction. */
function pilotTurn(tick: number): -1 | 0 | 1 {
  const phase = tick % 7;
  if (phase >= 2) return 0;
  return Math.floor(tick / 7) % 2 === 0 ? 1 : -1;
}

function run(up: LinkModel, down: LinkModel, seconds: number, seed: number): RunResult {
  const r = rng(seed);
  const delay = (m: LinkModel): number =>
    m.baseMs + r() * m.jitterMs + (r() < m.spikeChance ? r() * m.spikeMs : 0);

  // ── server ──
  const queue: QueuedInput[] = [];
  const lastApplied = new Map<number, QueuedInput>();
  const lastAck = new Map<number, number>();
  let serverTick = 0; // completed ticks
  let serverHeading = 0;
  let latestMargin: number | undefined;
  const uplink: Array<{ at: number; input: QueuedInput }> = [];
  let lastUpArrival = 0;
  const downlink: Array<{ at: number; serverTick: number; ackedTick: number; heading: number; margin: number | undefined }> = [];
  let lastDownArrival = 0;

  // ── client ──
  const sentAt = new Map<number, number>();
  const predicted = new Map<number, number>(); // heading after applying input X → key X + 1
  const reconciler = { lastRtt: 0 };
  const stats = { rttMeanMs: 0, rttStdDevMs: 0 } as PredictionStats;
  const welford = createWelford();
  const ctrl = createLookaheadController(6);
  let lead = 6;
  let anchor: { anchorServerTick: number; anchorPerfNow: number } | null = null;
  let inputTick = -1;
  let clientHeading = 0;
  let lastSnapAt = -1;
  let nextRaf = 0;

  const angleCorrections: number[] = [];
  const leads: number[] = [];
  let snapshots = 0;
  const end = seconds * 1000;
  const warmupMs = 5000;

  for (let now = 0; now < end; now += 0.5) {
    // Uplink deliveries (in order — a WebSocket is TCP).
    while (uplink.length > 0 && uplink[0]!.at <= now) {
      const { input } = uplink.shift()!;
      latestMargin = inputLeadMargin(input.tick, serverTick);
      queue.push(input);
    }
    // Server step.
    if (now >= (serverTick + 1) * FIXED_MS) {
      const res = tickInputQueue(0, queue, lastApplied, lastAck, serverTick);
      if (res.applied) serverHeading += (res.applied.turnLeft ? TURN : 0) - (res.applied.turnRight ? TURN : 0);
      serverTick++;
      if (serverTick % SNAPSHOT_EVERY === 0) {
        const at = Math.max(lastDownArrival, now + delay(down));
        lastDownArrival = at;
        downlink.push({ at, serverTick, ackedTick: lastAck.get(0) ?? 0, heading: serverHeading, margin: latestMargin });
        latestMargin = undefined;
      }
    }
    // Client snapshot arrivals.
    while (downlink.length > 0 && downlink[0]!.at <= now) {
      const s = downlink.shift()!;
      anchor = anchor === null
        ? { anchorServerTick: s.serverTick, anchorPerfNow: now }
        : updateAnchor(anchor, s.serverTick, now);
      if (inputTick < 0) inputTick = s.serverTick + lead;
      const sent = sentAt.get(s.ackedTick);
      if (sent !== undefined) reconciler.lastRtt = now - sent;
      const intervalMs = lastSnapAt >= 0 ? now - lastSnapAt : 0;
      lastSnapAt = now;
      lead = updateRttAndLookahead(intervalMs, {
        reconciler: reconciler as unknown as Reconciler,
        stats,
        rttWelford: welford,
        lookaheadCtrl: ctrl,
        leadTicks: lead,
        lastFrameMs: RAF_MS,
        inputMargin: s.margin,
        timeScale: 1,
      });
      const want = predicted.get(s.ackedTick + 1);
      if (now > warmupMs && want !== undefined) {
        snapshots++;
        leads.push(lead);
        const drift = Math.abs(s.heading - want);
        if (drift > 0.001) angleCorrections.push(drift);
      }
      // Reconcile: the server's heading is truth; replay the unacked inputs.
      if (want !== undefined) {
        let h = s.heading;
        for (let t = s.ackedTick + 1; t < inputTick; t++) {
          const tn = pilotTurn(t);
          h += tn * TURN;
          predicted.set(t + 1, h);
        }
        clientHeading = h;
      }
    }
    // Client RAF: produce every tick up to the wall-clock target.
    if (now >= nextRaf) {
      nextRaf += RAF_MS;
      if (anchor !== null && inputTick >= 0) {
        const target = Math.floor((now - anchor.anchorPerfNow) / FIXED_MS) + anchor.anchorServerTick + lead;
        let n = 0;
        while (inputTick < target && n < 4) {
          const tn = pilotTurn(inputTick);
          clientHeading += tn * TURN;
          predicted.set(inputTick + 1, clientHeading);
          sentAt.set(inputTick, now);
          const at = Math.max(lastUpArrival, now + delay(up));
          lastUpArrival = at;
          uplink.push({
            at,
            input: { tick: inputTick, thrust: true, turnLeft: tn === 1, turnRight: tn === -1, boost: false, reverse: false },
          });
          inputTick++;
          n++;
        }
      }
    }
  }
  leads.sort((a, b) => a - b);
  return { snapshots, angleCorrections, leadP50: leads[Math.floor(leads.length / 2)] ?? 0 };
}

/** ~100 ms round trip with tunnel jitter — the play-test link. */
const TUNNEL_UP: LinkModel = { baseMs: 40, jitterMs: 20, spikeChance: 0.03, spikeMs: 60 };
const TUNNEL_DOWN: LinkModel = { baseMs: 40, jitterMs: 15, spikeChance: 0.03, spikeMs: 60 };

describe('input lead on a slow, jittery link (late inputs → quantised heading snaps)', () => {
  it('sizes the lead to the real round trip, so turn taps produce no heading corrections', () => {
    const res = run(TUNNEL_UP, TUNNEL_DOWN, 60, 1);
    expect(res.snapshots).toBeGreaterThan(1000);
    // Every heading correction a late input causes is a whole number of turn
    // steps; the bug produced hundreds. Allow the rare spike past mean + 2σ.
    expect(res.angleCorrections.length / res.snapshots).toBeLessThan(0.02);
    // The lead covers the ~100 ms round trip (6 ticks), not the 3-tick floor.
    expect(res.leadP50).toBeGreaterThanOrEqual(6);
  });

  it('keeps a short lead on a fast link (no lead inflation)', () => {
    const lan: LinkModel = { baseMs: 2, jitterMs: 2, spikeChance: 0, spikeMs: 0 };
    const res = run(lan, lan, 20, 2);
    expect(res.angleCorrections.length).toBe(0);
    expect(res.leadP50).toBeLessThanOrEqual(3);
  });
});
