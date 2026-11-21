/**
 * Named, seeded network + client-frame profiles for the gap-smoothing work.
 *
 * Each profile feeds `buildDeliveries` / `buildFrameTimes` /
 * `buildNetworkEvents` in runner.ts. Stalls start at `GAP_AT_MS`, after the
 * client has settled. Both streams are reliable and ordered: whatever is
 * sent during a stall arrives together, in send order, at its end.
 *
 * `jitter-4g` reproduces the JSON snapshot inter-arrival gaps measured on
 * the 2026-11-21 4G capture (p50 52, p95 91, p99 170 ms).
 */
import type { NetworkProfile } from './types.js';

export type GapProfileName =
  | 'lan-clean'
  | 'gap-200'
  | 'gap-400'
  | 'gap-600'
  | 'burst-600-both-streams'
  | 'gap-json-only'
  | 'gap-swarm-only'
  | 'frame-stall-250'
  | 'jitter-4g';

/** When every stall in these profiles starts (ms of scenario time). */
export const GAP_AT_MS = 2000;
/** One-way link delay for the clean LAN profile. */
const LAN_DELAY_MS = 2;
/** One-way link delay for the WAN profiles. */
const WAN_DELAY_MS = 40;
/** Stall length used by the single-stream profiles. */
const SINGLE_STREAM_GAP_MS = 400;
const BURST_GAP_MS = 600;
const FRAME_STALL_MS = 250;
/** 4G capture, JSON snapshot inter-arrival gap percentiles (ms). */
const JITTER_4G_P50_MS = 52;
const JITTER_4G_P95_MS = 91;
const JITTER_4G_P99_MS = 170;
const JITTER_4G_SEED = 0x46470021;

function gapProfile(name: GapProfileName, durationMs: number, seed: number): NetworkProfile {
  return {
    name,
    seed,
    baseDelayMs: WAN_DELAY_MS,
    gaps: [{ atMs: GAP_AT_MS, durationMs, streams: 'both' }],
    frameStalls: [],
  };
}

export const GAP_PROFILES: Readonly<Record<GapProfileName, NetworkProfile>> = {
  'lan-clean': { name: 'lan-clean', seed: 1, baseDelayMs: LAN_DELAY_MS, gaps: [], frameStalls: [] },
  'gap-200': gapProfile('gap-200', 200, 2),
  'gap-400': gapProfile('gap-400', 400, 3),
  'gap-600': gapProfile('gap-600', 600, 4),
  'burst-600-both-streams': {
    name: 'burst-600-both-streams',
    seed: 5,
    baseDelayMs: WAN_DELAY_MS,
    gaps: [
      { atMs: GAP_AT_MS, durationMs: BURST_GAP_MS, streams: 'json' },
      { atMs: GAP_AT_MS, durationMs: BURST_GAP_MS, streams: 'swarm' },
    ],
    frameStalls: [],
  },
  'gap-json-only': {
    name: 'gap-json-only',
    seed: 6,
    baseDelayMs: WAN_DELAY_MS,
    gaps: [{ atMs: GAP_AT_MS, durationMs: SINGLE_STREAM_GAP_MS, streams: 'json' }],
    frameStalls: [],
  },
  'gap-swarm-only': {
    name: 'gap-swarm-only',
    seed: 7,
    baseDelayMs: WAN_DELAY_MS,
    gaps: [{ atMs: GAP_AT_MS, durationMs: SINGLE_STREAM_GAP_MS, streams: 'swarm' }],
    frameStalls: [],
  },
  'frame-stall-250': {
    name: 'frame-stall-250',
    seed: 8,
    baseDelayMs: WAN_DELAY_MS,
    gaps: [],
    frameStalls: [{ atMs: GAP_AT_MS, durationMs: FRAME_STALL_MS }],
  },
  'jitter-4g': {
    name: 'jitter-4g',
    seed: JITTER_4G_SEED,
    baseDelayMs: WAN_DELAY_MS,
    jitter: { gapP50Ms: JITTER_4G_P50_MS, gapP95Ms: JITTER_4G_P95_MS, gapP99Ms: JITTER_4G_P99_MS },
    gaps: [],
    frameStalls: [],
  },
};

export function getGapProfile(name: GapProfileName): NetworkProfile {
  return GAP_PROFILES[name];
}
