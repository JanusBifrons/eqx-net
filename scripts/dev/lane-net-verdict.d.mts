export const GAP_MS: number;
export const SETTLE_AFTER_WELCOME_MS: number;
export const DEVICE_HITCHES_PER_MIN_OK: number;
export const TIERS: {
  good: { rttP99Ms: number; latenessP95Ms: number; gapsPerMin: number; maxGapMs: number };
  playable: { rttP99Ms: number; latenessP95Ms: number; gapsPerMin: number; maxGapMs: number };
};
export type Tier = 'Good' | 'Playable' | 'Poor' | 'No data';
export interface NetworkMetrics { rttP99Ms: number; latenessP95Ms: number; networkGapsPerMin: number; maxNetworkGapMs: number }
export function classifyTier(m: NetworkMetrics): { tier: Tier; reasons: string[] };
export function attributeGap(g: { recvGapMs: number; serverSendGapMs: number | null; deviceStallMs: number }): 'server' | 'device' | 'network';
export function latenessSeries(receives: ReadonlyArray<{ clientRecvPerfNow: number; serverSendPerfNow: number }>): number[];
export function percentile(values: readonly number[], p: number): number;
export interface CaptureEvent { ts: number; tag?: string; data?: Record<string, unknown> }
export interface CaptureVerdict {
  minutes: number;
  welcomes: number;
  disconnects: number;
  metrics: NetworkMetrics;
  tier: Tier;
  reasons: string[];
  gaps: { total: number; perMin: number; serverPct: number; devicePct: number; networkPct: number; maxMs: number };
  device: { hitchesPerMin: number; rafGapsPerMin: number; smooth: boolean };
}
export function summarizeCapture(ev: {
  snapshots: readonly CaptureEvent[];
  perf: readonly CaptureEvent[];
  frames: readonly CaptureEvent[];
  lifecycle: readonly CaptureEvent[];
}): CaptureVerdict;
