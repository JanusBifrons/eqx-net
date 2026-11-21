/**
 * Network quality verdict for a phone-lane capture
 * (docs/ops/network-quality.md; capture layout: docs/ops/phone-link.md "Play evidence").
 *
 *   pnpm phone:verdict <capture dir> [<capture dir> ...]
 *
 * Prints a tier (Good / Playable / Poor) and splits every arrival gap over
 * GAP_MS between three clocks:
 *   - server:  the server's own send stamps were already that far apart;
 *   - device:  the phone's main thread was blocked (raf_gap / loaf / longtask)
 *              across the gap, so the message was read late;
 *   - network: the server sent on time and the phone was free, yet the update
 *              arrived late.
 * Only network gaps count toward the tier: a server or device problem is not a
 * bad connection. Offline, no deps. Pure functions are exported for
 * tests/unit/lane-net-verdict.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvents } from './lane-stall-names.mjs';

/** An arrival gap longer than this is a "gap" (ms). */
export const GAP_MS = 200;
/** Receives this soon after a `welcome` are join / reconnect catch-up, not play (ms). */
export const SETTLE_AFTER_WELCOME_MS = 3000;
/** An arrival gap this long restarts the lateness baseline (reconnect or stall). */
const LATENESS_RESET_GAP_MS = 1000;
/** How fast the lateness baseline creeps up toward the current offset (absorbs clock drift). */
const LATENESS_BASELINE_CREEP = 0.01;
/** Minutes are summed from arrival deltas shorter than this (ms); longer is time out of play. */
const IN_PLAY_MAX_DELTA_MS = 10000;
/** A server send gap covering at least this share of the arrival gap makes it a server gap. */
const SERVER_SHARE = 0.5;
/** A main-thread stall covering at least this share of the unexplained part makes it a device gap. */
const DEVICE_SHARE = 0.5;
/** Pairs whose server ticks jump further than this straddle a reconnect: no server send gap. */
const MAX_TICK_STEP = 600;
const MS_PER_MIN = 60000;

/** Tier thresholds (docs/ops/network-quality.md "Tiers"). Network-attributed gaps only. */
export const TIERS = {
  // Good is a subset of Playable, so it carries the one-second ceiling too.
  good: { rttP99Ms: 100, latenessP95Ms: 30, gapsPerMin: 2, maxGapMs: 1000 },
  playable: { rttP99Ms: 250, latenessP95Ms: 150, gapsPerMin: 10, maxGapMs: 1000 },
};

/** Device hitch rate (frames over 50 ms, per minute) above which the phone itself stutters. */
export const DEVICE_HITCHES_PER_MIN_OK = 6;

/**
 * Tier from network metrics. Every bound is strict (`<`). A metric that was not
 * measured (NaN, e.g. no RTT samples) skips its bound; with neither lateness nor
 * a gap rate there is nothing to judge ('No data').
 * @param {{ rttP99Ms: number, latenessP95Ms: number, networkGapsPerMin: number, maxNetworkGapMs: number }} m
 * @returns {{ tier: 'Good' | 'Playable' | 'Poor' | 'No data', reasons: string[] }}
 */
export function classifyTier(m) {
  if (!Number.isFinite(m.latenessP95Ms) && !Number.isFinite(m.networkGapsPerMin)) return { tier: 'No data', reasons: [] };
  const over = (x, bound) => Number.isFinite(x) && !(x < bound);
  const fails = (t) => {
    const r = [];
    if (over(m.rttP99Ms, t.rttP99Ms)) r.push(`RTT p99 ${fmt(m.rttP99Ms)} >= ${t.rttP99Ms} ms`);
    if (over(m.latenessP95Ms, t.latenessP95Ms)) r.push(`lateness p95 ${fmt(m.latenessP95Ms)} >= ${t.latenessP95Ms} ms`);
    if (over(m.networkGapsPerMin, t.gapsPerMin)) r.push(`network gaps ${fmt(m.networkGapsPerMin, 1)}/min >= ${t.gapsPerMin}/min`);
    if (over(m.maxNetworkGapMs, t.maxGapMs)) r.push(`network gap ${fmt(m.maxNetworkGapMs)} ms >= ${t.maxGapMs} ms`);
    return r;
  };
  const notGood = fails(TIERS.good);
  if (notGood.length === 0) return { tier: 'Good', reasons: [] };
  const notPlayable = fails(TIERS.playable);
  if (notPlayable.length === 0) return { tier: 'Playable', reasons: notGood };
  return { tier: 'Poor', reasons: notPlayable };
}

/**
 * Which clock caused one arrival gap.
 * @param {{ recvGapMs: number, serverSendGapMs: number | null, deviceStallMs: number }} g
 *   `serverSendGapMs` null = unknown (pair straddles a reconnect); `deviceStallMs` =
 *   the longest main-thread stall overlapping the gap window.
 * @returns {'server' | 'device' | 'network'}
 */
export function attributeGap(g) {
  const send = g.serverSendGapMs ?? 0;
  if (send >= SERVER_SHARE * g.recvGapMs) return 'server';
  if (g.deviceStallMs >= DEVICE_SHARE * (g.recvGapMs - send)) return 'device';
  return 'network';
}

/**
 * Per-arrival lateness: (client receive − server send) above a baseline that
 * tracks the minimum, creeps up slowly to absorb clock drift, and restarts
 * after a long arrival gap. The two clocks are unsynchronised, so only the
 * excess over the best-seen offset means anything.
 * @param {ReadonlyArray<{ clientRecvPerfNow: number, serverSendPerfNow: number }>} receives
 * @returns {number[]}
 */
export function latenessSeries(receives) {
  const out = [];
  let base = null;
  let lastT = null;
  for (const r of receives) {
    const off = r.clientRecvPerfNow - r.serverSendPerfNow;
    if (base === null || (lastT !== null && r.clientRecvPerfNow - lastT > LATENESS_RESET_GAP_MS) || off < base) base = off;
    else base += LATENESS_BASELINE_CREEP * (off - base);
    lastT = r.clientRecvPerfNow;
    out.push(off - base);
  }
  return out;
}

/** Nearest-rank percentile; NaN for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * Summarise one capture's events into a verdict.
 * @param {{ snapshots: object[], perf: object[], frames: object[], lifecycle: object[] }} ev
 */
export function summarizeCapture(ev) {
  const welcomes = ev.lifecycle.filter((e) => e.tag === 'welcome').map((e) => e.ts);
  const disconnects = ev.lifecycle.filter((e) => e.tag === 'disconnected').length;
  const settled = (ts) => !welcomes.some((w) => ts >= w && ts < w + SETTLE_AFTER_WELCOME_MS);
  const rec = ev.snapshots.filter((e) => e.tag === 'snapshot_received' && e.data);

  let inPlayMs = 0;
  for (let i = 1; i < rec.length; i++) {
    const d = rec[i].ts - rec[i - 1].ts;
    if (d < IN_PLAY_MAX_DELTA_MS) inPlayMs += d;
  }
  const minutes = inPlayMs / MS_PER_MIN;

  const stalls = [];
  for (const e of ev.perf) {
    const d = e.data ?? {};
    if (e.tag === 'raf_gap' && typeof d.elapsedMs === 'number') stalls.push([e.ts - d.elapsedMs, e.ts]);
    else if ((e.tag === 'loaf' || e.tag === 'longtask') && typeof d.startTime === 'number' && typeof d.durationMs === 'number') {
      stalls.push([d.startTime, d.startTime + d.durationMs]);
    }
  }
  const longestStallIn = (from, to) => {
    let best = 0;
    for (const [a, b] of stalls) best = Math.max(best, Math.min(b, to) - Math.max(a, from));
    return best;
  };

  const gaps = { server: [], device: [], network: [] };
  for (let i = 1; i < rec.length; i++) {
    const a = rec[i - 1].data;
    const b = rec[i].data;
    const g = b.recvGapMs;
    if (!(g > GAP_MS) || !settled(rec[i].ts)) continue;
    const step = b.serverTick - a.serverTick;
    const serverSendGapMs = step >= 0 && step <= MAX_TICK_STEP ? b.serverSendPerfNow - a.serverSendPerfNow : null;
    const end = b.clientRecvPerfNow;
    gaps[attributeGap({ recvGapMs: g, serverSendGapMs, deviceStallMs: longestStallIn(end - g, end) })].push(g);
  }
  const allGaps = gaps.server.length + gaps.device.length + gaps.network.length;
  const share = (k) => (allGaps === 0 ? 0 : Math.round((100 * gaps[k].length) / allGaps));

  const rtt = ev.snapshots.filter((e) => e.tag === 'snapshot' && settled(e.ts) && e.data?.rttMs > 0).map((e) => e.data.rttMs);
  const late = latenessSeries(rec.map((e) => e.data));
  const metrics = {
    rttP99Ms: percentile(rtt, 99),
    latenessP95Ms: percentile(late, 95),
    networkGapsPerMin: minutes > 0 ? gaps.network.length / minutes : NaN,
    maxNetworkGapMs: gaps.network.length ? Math.max(...gaps.network) : 0,
  };

  const windows = ev.frames.filter((e) => e.tag === 'perf_summary' && e.data);
  const frameMin = windows.reduce((s, e) => s + (e.data.windowMs ?? 0), 0) / MS_PER_MIN;
  const hitches = windows.reduce((s, e) => s + (e.data.hitches ?? 0), 0);
  const rafGaps = ev.perf.filter((e) => e.tag === 'raf_gap').length;
  const hitchesPerMin = frameMin > 0 ? hitches / frameMin : NaN;

  return {
    minutes,
    welcomes: welcomes.length,
    disconnects,
    metrics,
    ...classifyTier(metrics),
    gaps: {
      total: allGaps,
      perMin: minutes > 0 ? allGaps / minutes : NaN,
      serverPct: share('server'),
      devicePct: share('device'),
      networkPct: share('network'),
      maxMs: allGaps ? Math.max(...gaps.server, ...gaps.device, ...gaps.network) : 0,
    },
    device: {
      hitchesPerMin,
      rafGapsPerMin: frameMin > 0 ? rafGaps / frameMin : NaN,
      smooth: hitchesPerMin < DEVICE_HITCHES_PER_MIN_OK,
    },
  };
}

function fmt(x, digits = 0) {
  return Number.isFinite(x) ? x.toFixed(digits) : '-';
}

function readCapture(dir) {
  const rd = (f) => {
    const p = path.join(dir, f);
    return existsSync(p) ? readEvents(readFileSync(p, 'utf8')) : [];
  };
  // Older captures filed some perf events under other.ndjson.
  return { snapshots: rd('snapshots.ndjson'), perf: [...rd('perf.ndjson'), ...rd('other.ndjson')], frames: rd('frames.ndjson'), lifecycle: rd('lifecycle.ndjson') };
}

function main(argv) {
  const dirs = argv.slice(2);
  if (dirs.length === 0) { console.error('usage: pnpm phone:verdict <capture dir> [...]'); process.exit(2); }
  for (const dir of dirs) {
    const r = summarizeCapture(readCapture(dir));
    const m = r.metrics;
    console.log(`${path.basename(dir)}: ${r.tier}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`);
    console.log(`  ${fmt(r.minutes, 1)} min in play, ${r.welcomes} welcome(s), ${r.disconnects} disconnect(s)`);
    console.log(`  network: RTT p99 ${fmt(m.rttP99Ms)} ms, lateness p95 ${fmt(m.latenessP95Ms)} ms, network gaps ${fmt(m.networkGapsPerMin, 1)}/min (max ${fmt(m.maxNetworkGapMs)} ms)`);
    console.log(`  gaps > ${GAP_MS} ms: ${r.gaps.total} (${fmt(r.gaps.perMin, 1)}/min, max ${fmt(r.gaps.maxMs)} ms): server ${r.gaps.serverPct}%, network ${r.gaps.networkPct}%, device ${r.gaps.devicePct}%`);
    const devVerdict = Number.isFinite(r.device.hitchesPerMin) ? (r.device.smooth ? 'smooth' : 'hitchy') : 'no frame summaries';
    console.log(`  device: ${fmt(r.device.hitchesPerMin, 1)} hitches/min (frames > 50 ms), ${fmt(r.device.rafGapsPerMin, 1)} raf_gaps/min -> ${devVerdict}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv);
