/**
 * Loads a `diag/captures/<id>/` directory into a typed event stream the
 * replay harness consumes. Plan: capture-driven replay infra, Phase C
 * (2026-05-21).
 *
 * Capture format (set by Phase A enrichment):
 *   summary.json            — top-level metadata + counts
 *   raf.ndjson              — rafTick + inputSent + input_intent +
 *                             local_pose_predicted + local_pose_rendered
 *   snapshots.ndjson        — snapshot (with full local serverState since A.1)
 *   corrections.ndjson      — correction events (when drift > threshold)
 *   lifecycle.ndjson        — welcome, phase_change, etc.
 *   others                  — combat, population, perf, other
 *
 * The loader stitches these into a single time-ordered `TimelineEvent[]`
 * keyed by client `ts` (performance.now() at the time of logEvent).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal welcome data captured in lifecycle.ndjson. */
export interface WelcomeEventData {
  playerId: string;
  serverTick: number;
  idReassigned?: boolean;
}

/** Per-snapshot data captured in snapshots.ndjson (Phase A.1 schema). */
export interface SnapshotEventData {
  n: number;
  serverTick: number;
  ackedTick: number;
  ticksAhead: number;
  intervalMs: number;
  rttMs: number;
  driftUnits: number;
  angleDriftRad: number;
  maxDriftUnits: number;
  lerping: boolean;
  serverX: number;
  serverY: number;
  /** Phase A.1 additions — full local serverState for deterministic replay. */
  serverVx?: number;
  serverVy?: number;
  serverAngle?: number;
  serverAngvel?: number;
  beforeX: number;
  beforeY: number;
  afterX: number;
  afterY: number;
}

/** Per-RAF rafTick data (now unsampled — Phase A). */
export interface RafTickEventData {
  elapsedMs: number;
  targetTick: number;
  inputTick: number;
  deficitBefore: number;
  stepsThisFrame: number;
  capped: boolean;
  anchorServerTick: number;
  anchorPerfNow?: number;
  leadTicks: number;
}

/** Per-tick raw input intent (Phase A new tag). */
export interface InputIntentEventData {
  tick: number;
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse: boolean;
  fireHeld: boolean;
  joystickX: number | null;
  joystickY: number | null;
}

/** Per-tick predicted local pose (Phase A new tag). */
export interface LocalPosePredictedData {
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

/** Per-RAF rendered local pose (Phase A new tag — the ground truth). */
export interface LocalPoseRenderedData {
  inputTick: number;
  x: number;
  y: number;
  angle: number;
  lerpOffsetX: number;
  lerpOffsetY: number;
  lerpAngleOffset: number;
}

/** A single timeline event, sorted by client `ts`. */
export type TimelineEvent =
  | { kind: 'welcome'; ts: number; data: WelcomeEventData }
  | { kind: 'snapshot'; ts: number; data: SnapshotEventData }
  | { kind: 'rafTick'; ts: number; data: RafTickEventData }
  | { kind: 'input_intent'; ts: number; data: InputIntentEventData }
  | { kind: 'local_pose_predicted'; ts: number; data: LocalPosePredictedData }
  | { kind: 'local_pose_rendered'; ts: number; data: LocalPoseRenderedData };

export interface LoadedCapture {
  dirName: string;
  /** Full path passed to `loadCapture` — useful for diagnostic logging. */
  capturePath: string;
  /** Welcome event (must exist or load fails). */
  welcome: WelcomeEventData & { ts: number };
  /** All events in `ts` order. */
  events: TimelineEvent[];
  /** Quick counts for assertions / liveness. */
  counts: {
    welcome: number;
    snapshot: number;
    rafTick: number;
    input_intent: number;
    local_pose_predicted: number;
    local_pose_rendered: number;
  };
}

interface RawLogEntry {
  source?: string;
  ts?: number;
  tag?: string;
  data?: Record<string, unknown>;
}

function parseNdjson(path: string): RawLogEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out: RawLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as RawLogEntry;
      if (typeof rec.ts === 'number' && typeof rec.tag === 'string' && rec.data) {
        out.push(rec);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Load a capture directory and return its typed event timeline. Throws
 * if the welcome event is missing — every capture must have one.
 */
export function loadCapture(capturePath: string): LoadedCapture {
  // Accept either a path to the dir or a path that ends with the dir.
  const lifecyclePath = join(capturePath, 'lifecycle.ndjson');
  const snapshotsPath = join(capturePath, 'snapshots.ndjson');
  const rafPath = join(capturePath, 'raf.ndjson');

  const lifecycleRaw = parseNdjson(lifecyclePath);
  const snapshotsRaw = parseNdjson(snapshotsPath);
  const rafRaw = parseNdjson(rafPath);

  const welcomeRaw = lifecycleRaw.find((e) => e.tag === 'welcome');
  if (!welcomeRaw) {
    throw new Error(
      `capture at ${capturePath} has no 'welcome' entry in lifecycle.ndjson — replay cannot bootstrap`,
    );
  }
  const welcome: WelcomeEventData & { ts: number } = {
    ts: welcomeRaw.ts!,
    playerId: String(welcomeRaw.data!['playerId']),
    serverTick: Number(welcomeRaw.data!['serverTick']),
    idReassigned: welcomeRaw.data!['idReassigned'] as boolean | undefined,
  };

  const events: TimelineEvent[] = [
    { kind: 'welcome', ts: welcome.ts, data: welcome },
  ];

  for (const r of snapshotsRaw) {
    if (r.tag !== 'snapshot') continue;
    events.push({ kind: 'snapshot', ts: r.ts!, data: r.data as unknown as SnapshotEventData });
  }

  for (const r of rafRaw) {
    switch (r.tag) {
      case 'rafTick':
        events.push({ kind: 'rafTick', ts: r.ts!, data: r.data as unknown as RafTickEventData });
        break;
      case 'input_intent':
        events.push({ kind: 'input_intent', ts: r.ts!, data: r.data as unknown as InputIntentEventData });
        break;
      case 'local_pose_predicted':
        events.push({ kind: 'local_pose_predicted', ts: r.ts!, data: r.data as unknown as LocalPosePredictedData });
        break;
      case 'local_pose_rendered':
        events.push({ kind: 'local_pose_rendered', ts: r.ts!, data: r.data as unknown as LocalPoseRenderedData });
        break;
      default:
        // inputSent, input_received are kept in raf bucket but not needed
        // for replay; ignore silently.
        break;
    }
  }

  // Stable sort by ts. JS Array.sort is stable since ES2019.
  events.sort((a, b) => a.ts - b.ts);

  return {
    dirName: capturePath,
    capturePath,
    welcome,
    events,
    counts: {
      welcome: events.filter((e) => e.kind === 'welcome').length,
      snapshot: events.filter((e) => e.kind === 'snapshot').length,
      rafTick: events.filter((e) => e.kind === 'rafTick').length,
      input_intent: events.filter((e) => e.kind === 'input_intent').length,
      local_pose_predicted: events.filter((e) => e.kind === 'local_pose_predicted').length,
      local_pose_rendered: events.filter((e) => e.kind === 'local_pose_rendered').length,
    },
  };
}
