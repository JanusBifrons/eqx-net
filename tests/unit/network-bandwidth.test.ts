/**
 * Phase 0 — Network-bandwidth baseline gate (multi-mount/turret combat refactor).
 *
 * Captures bytes-out-per-client for a deterministic scenario (4 clients, 4
 * player ships, 100 drones, 60 ticks of motion) by invoking the same swarm
 * encoder and the same JSON snapshot shape the room uses on the broadcast
 * loop. The numbers are a stable proxy for wire traffic — they don't include
 * Colyseus framing overhead, but they track the production cost in the same
 * direction, and they're 100% deterministic.
 *
 * Two modes:
 *
 *  1. **Capture mode** — run with `EQX_CAPTURE_BASELINE=1 pnpm test
 *     tests/unit/network-bandwidth.test.ts`. Writes the measured numbers to
 *     `benchmarks/baselines/network-bandwidth.json`. Use this to (a) seed the
 *     baseline once at the start of the refactor and (b) re-seed at the end
 *     of each phase that intentionally moves the numbers (Phase 4b adds
 *     `mountAngles` to snapshot.states, Phase 4c adds them to snapshot.drones).
 *
 *  2. **Assert mode** (default) — reads the baseline JSON and asserts each
 *     metric stays within `MAX_REGRESSION_PCT` (10%) of the captured number.
 *     This is the regression gate during phases 1, 2a/b/c, and 3, which must
 *     not move the wire-byte budget at all (Phase 2b is a slight reduction;
 *     Phase 3 adds laser_fired event bytes for multi-mount fires, but the
 *     baseline scenario fires no weapons, so it should still match exactly).
 *
 * The scenario deliberately fires no weapons — combat-event bytes are
 * measured separately by the combat E2E specs. This file scopes to the
 * steady-state broadcast (swarm packet + 20 Hz snapshot) which is where any
 * per-entity wire change shows up first.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BinarySwarmBroadcast } from '../../src/server/net/BinarySwarmBroadcast.js';
import { SwarmEntityRegistry } from '../../src/server/net/SwarmEntityRegistry.js';
import { SpatialGrid } from '../../src/server/interest/SpatialGrid.js';
import { shouldBroadcastFar } from '../../src/server/net/snapshotScheduler.js';
import {
  SAB_TOTAL_BYTES,
  slotBase,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
} from '../../src/shared-types/sabLayout.js';
import type { SnapshotMessage } from '../../src/shared-types/messages.js';

// ── scenario configuration ─────────────────────────────────────────────────

const CLIENT_COUNT = 4;
const PLAYER_COUNT = CLIENT_COUNT;
const DRONE_COUNT = 100;
const TICK_COUNT = 60; // 1 second at 60 Hz
const WORLD_RADIUS = 6_000; // Tighter than swarm-broadcast bench's 18 000 so
                            // interest windows actually overlap (mirrors
                            // realistic gameplay density better than worst-case).
const MAX_REGRESSION_PCT = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASELINE_PATH = resolve(__dirname, '../../benchmarks/baselines/network-bandwidth.json');

// ── measurement shape ──────────────────────────────────────────────────────

interface BandwidthMeasurement {
  /** Total swarm-packet bytes sent across all clients across all 60 ticks. */
  totalSwarmBytes: number;
  /** Total JSON-snapshot bytes sent across all clients across all 60 ticks. */
  totalSnapshotBytes: number;
  /** Average bytes/sec per client over the 60-tick window (= total / 4). */
  bytesPerSecPerClient: number;
  /** Peak per-tick swarm bytes any single client saw. */
  peakSwarmTickBytes: number;
  /** Peak per-tick snapshot bytes any single client saw (on 20 Hz tick). */
  peakSnapshotTickBytes: number;
  /** Total snapshot count (number of 20 Hz fires across all clients). */
  snapshotCount: number;
  /** Total swarm packets emitted (per-tick × per-client, minus quiet-tick suppressions). */
  swarmPacketCount: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Deterministic-but-spread positions via a sunflower spiral, identical seed
 *  used everywhere — gives a stable scenario that doesn't depend on
 *  Math.random. */
function sunflower(i: number, count: number, radius: number): { x: number; y: number; angle: number } {
  const PHI = Math.PI * (3 - Math.sqrt(5));
  const t = (i + 0.5) / count;
  const r = Math.sqrt(t) * radius;
  const angle = i * PHI;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, angle };
}

/** A small per-entity per-tick velocity that mixes "moving" drones (above
 *  MOVING_SPEED_TAXI = 0.5 so the encoder ships every tick) with "static"
 *  drones (below threshold, gated by quantisation). Mirrors real gameplay
 *  load where some drones are patrolling and others are coasting. */
function droneVelocity(i: number): { vx: number; vy: number } {
  // Half the population moves at 0.8 u/s (above threshold), half at 0.2 u/s.
  const fast = i % 2 === 0;
  const speed = fast ? 0.8 : 0.2;
  const dir = (i * 0.21) % (Math.PI * 2);
  return { vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed };
}

/** Mirror the per-recipient snapshot build in `SectorRoom.update()` — without
 *  Colyseus, without the worker. Returns the JSON-serialised payload size. */
function buildSnapshotJsonSize(
  allShips: ReadonlyArray<{ id: string; x: number; y: number; vx: number; vy: number; angle: number; angvel: number }>,
  swarmRegistry: SwarmEntityRegistry,
  sabF32: Float32Array,
  inInterest: Set<number>,
  serverTick: number,
  ackedTick: number,
): number {
  const states: SnapshotMessage['states'] = {};
  for (const s of allShips) {
    // Mirror production: lastInput omitted when bits unchanged. In this
    // bench all ships have idle bits so lastInput stays omitted after
    // the first snapshot — match production's steady-state cost.
    states[s.id] = {
      x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel,
    };
  }

  // Per-recipient drone slice — in-interest drones at serverTick. This bench
  // skips the SnapshotRing rewind (uses live SAB pose) — close enough for a
  // wire-byte budget; rewinding to a 12-tick-old pose costs the same bytes.
  let drones: SnapshotMessage['drones'];
  for (const eid of inInterest) {
    const rec = swarmRegistry.getByEntityId(eid);
    if (!rec || rec.kind !== 1) continue;
    const base = slotBase(rec.slot);
    if (!drones) drones = [];
    drones.push({
      id: eid,
      x: sabF32[base + SLOT_X_OFF]!,
      y: sabF32[base + SLOT_Y_OFF]!,
      vx: sabF32[base + SLOT_VX_OFF]!,
      vy: sabF32[base + SLOT_VY_OFF]!,
      angle: sabF32[base + SLOT_ANGLE_OFF]!,
      angvel: sabF32[base + SLOT_ANGVEL_OFF]!,
    });
  }

  const snap: SnapshotMessage = {
    type: 'snapshot',
    serverTick,
    states,
    ackedTick,
    ...(drones ? { drones } : {}),
  };
  return Buffer.byteLength(JSON.stringify(snap), 'utf8');
}

// ── scenario runner ────────────────────────────────────────────────────────

function runScenario(): BandwidthMeasurement {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  const sabF32 = new Float32Array(sab);
  const sabU32 = new Uint32Array(sab);

  const swarmRegistry = new SwarmEntityRegistry();
  const swarmEncoder = new BinarySwarmBroadcast();
  const grid = new SpatialGrid();

  // Player ships occupy slots 0..3; drones occupy slots 4..103.
  const playerIds: string[] = [];
  for (let p = 0; p < PLAYER_COUNT; p++) {
    const id = `player-${p}`;
    playerIds.push(id);
    // Spread the 4 players across the world (corners of a square) so each
    // client's 3×3 interest window covers a different subset of drones.
    const corner = Math.PI / 4 + (p * Math.PI) / 2;
    const r = WORLD_RADIUS * 0.5;
    const px = Math.cos(corner) * r;
    const py = Math.sin(corner) * r;
    const b = slotBase(p);
    sabF32[b + SLOT_X_OFF] = px;
    sabF32[b + SLOT_Y_OFF] = py;
    sabF32[b + SLOT_VX_OFF] = 0;
    sabF32[b + SLOT_VY_OFF] = 0;
    sabF32[b + SLOT_ANGLE_OFF] = 0;
    sabF32[b + SLOT_ANGVEL_OFF] = 0;
    // Players don't go into the swarm registry or the grid — they're
    // tracked separately in the broadcast loop.
  }

  /** Per-drone-index → (slot, entityId) for use in the per-tick advance. */
  const droneEntityIds = new Int32Array(DRONE_COUNT);
  for (let i = 0; i < DRONE_COUNT; i++) {
    const slot = PLAYER_COUNT + i;
    const { x, y, angle } = sunflower(i, DRONE_COUNT, WORLD_RADIUS);
    const id = `drone-${i}`;
    const rec = swarmRegistry.register(id, slot, 1, 24, x, y, angle);
    droneEntityIds[i] = rec.entityId;
    const { vx, vy } = droneVelocity(i);
    const b = slotBase(slot);
    sabF32[b + SLOT_X_OFF] = x;
    sabF32[b + SLOT_Y_OFF] = y;
    sabF32[b + SLOT_VX_OFF] = vx;
    sabF32[b + SLOT_VY_OFF] = vy;
    sabF32[b + SLOT_ANGLE_OFF] = angle;
    sabF32[b + SLOT_ANGVEL_OFF] = 0;
    grid.insert(rec.entityId, x, y);
  }

  // Per-tick per-client measurement accumulators.
  let totalSwarmBytes = 0;
  let totalSnapshotBytes = 0;
  let peakSwarmTickBytes = 0;
  let peakSnapshotTickBytes = 0;
  let snapshotCount = 0;
  let swarmPacketCount = 0;

  // Per-recipient interest scratch — mirrors production's reuse pattern so
  // we measure the steady-state path, not first-call overhead.
  const interestScratch = new Map<string, Set<number>>();
  for (const pid of playerIds) interestScratch.set(pid, new Set<number>());

  // Build the "all ships" entry list reused per recipient. Player ships
  // don't have angvel-state changes in this scenario so the cost is stable.
  const allShipsEntries = playerIds.map((id, p) => {
    const b = slotBase(p);
    return {
      id,
      x: sabF32[b + SLOT_X_OFF]!,
      y: sabF32[b + SLOT_Y_OFF]!,
      vx: sabF32[b + SLOT_VX_OFF]!,
      vy: sabF32[b + SLOT_VY_OFF]!,
      angle: sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: sabF32[b + SLOT_ANGVEL_OFF]!,
    };
  });

  for (let tick = 1; tick <= TICK_COUNT; tick++) {
    // Advance drone positions by their per-tick velocity (1/60 s step).
    const dt = 1 / 60;
    for (let i = 0; i < DRONE_COUNT; i++) {
      const slot = PLAYER_COUNT + i;
      const b = slotBase(slot);
      const newX = sabF32[b + SLOT_X_OFF]! + sabF32[b + SLOT_VX_OFF]! * dt;
      const newY = sabF32[b + SLOT_Y_OFF]! + sabF32[b + SLOT_VY_OFF]! * dt;
      sabF32[b + SLOT_X_OFF] = newX;
      sabF32[b + SLOT_Y_OFF] = newY;
      grid.move(droneEntityIds[i]!, newX, newY);
    }

    // Per-client swarm + snapshot pass.
    for (let c = 0; c < CLIENT_COUNT; c++) {
      const recipientId = playerIds[c]!;
      const pb = slotBase(c);
      const px = sabF32[pb + SLOT_X_OFF]!;
      const py = sabF32[pb + SLOT_Y_OFF]!;
      const { cx, cy } = grid.cellOf(px, py);
      const scratch = interestScratch.get(recipientId)!;
      grid.query9(cx, cy, scratch);

      const packet = swarmEncoder.encode(swarmRegistry, sabF32, sabU32, tick, scratch);
      if (packet) {
        totalSwarmBytes += packet.byteLength;
        if (packet.byteLength > peakSwarmTickBytes) peakSwarmTickBytes = packet.byteLength;
        swarmPacketCount++;
      }

      if (shouldBroadcastFar(tick, recipientId)) {
        const snapBytes = buildSnapshotJsonSize(
          allShipsEntries,
          swarmRegistry,
          sabF32,
          scratch,
          tick,
          tick - 2, // ackedTick — close enough for byte-budget purposes
        );
        totalSnapshotBytes += snapBytes;
        if (snapBytes > peakSnapshotTickBytes) peakSnapshotTickBytes = snapBytes;
        snapshotCount++;
      }
    }
  }

  const bytesPerSecPerClient = (totalSwarmBytes + totalSnapshotBytes) / CLIENT_COUNT;

  return {
    totalSwarmBytes,
    totalSnapshotBytes,
    bytesPerSecPerClient,
    peakSwarmTickBytes,
    peakSnapshotTickBytes,
    snapshotCount,
    swarmPacketCount,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('network bandwidth — Phase 0 baseline gate', () => {
  it('matches the saved baseline (or captures it when EQX_CAPTURE_BASELINE=1)', () => {
    const measurement = runScenario();

    if (process.env.EQX_CAPTURE_BASELINE === '1') {
      const baselineDir = dirname(BASELINE_PATH);
      if (!existsSync(baselineDir)) mkdirSync(baselineDir, { recursive: true });
      const payload = {
        capturedAt: new Date().toISOString(),
        scenario: {
          clients: CLIENT_COUNT,
          players: PLAYER_COUNT,
          drones: DRONE_COUNT,
          ticks: TICK_COUNT,
          worldRadius: WORLD_RADIUS,
        },
        thresholds: { maxRegressionPct: MAX_REGRESSION_PCT },
        measurement,
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      // Capture mode is informational; still passes the test.
      console.log(`[network-bandwidth] Wrote baseline → ${BASELINE_PATH}\n${JSON.stringify(measurement, null, 2)}`);
      return;
    }

    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
      measurement: BandwidthMeasurement;
      thresholds: { maxRegressionPct: number };
    };
    const max = baseline.thresholds.maxRegressionPct;
    const pctChange = (current: number, base: number): number =>
      base === 0 ? 0 : ((current - base) / base) * 100;

    // Tolerate either direction (regression OR improvement) up to the
    // threshold. Both directions matter — a sudden 20% improvement deserves
    // a baseline re-capture rather than silent acceptance.
    const fields: Array<keyof BandwidthMeasurement> = [
      'totalSwarmBytes',
      'totalSnapshotBytes',
      'bytesPerSecPerClient',
      'peakSwarmTickBytes',
      'peakSnapshotTickBytes',
    ];
    for (const field of fields) {
      const cur = measurement[field];
      const base = baseline.measurement[field];
      const pct = pctChange(cur, base);
      expect(Math.abs(pct), `${field}: ${cur} vs baseline ${base} (Δ ${pct.toFixed(2)}%)`).toBeLessThanOrEqual(max);
    }

    // Counts must match exactly — they're deterministic from the scenario
    // shape, not noise-prone bytes. A drift here means the broadcast cadence
    // or interest filtering changed.
    expect(measurement.snapshotCount).toBe(baseline.measurement.snapshotCount);
    expect(measurement.swarmPacketCount).toBe(baseline.measurement.swarmPacketCount);
  });
});
