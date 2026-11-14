/**
 * WS-12 / R2.33 — re-entering a BUMPED lingering hull must land at the hull's
 * LIVE pose, not a stale "abandon-point" pose ("bumped hull re-entry teleports
 * to a stale pose").
 *
 * REPRODUCE-FIRST OUTCOME — this is a REGRESSION LOCK, not a failing-first test.
 * The investigation drove the bug end-to-end across BOTH plausible re-entry paths
 * (the bump uses the proven `lingeringHullPush` collision — a 2nd player thrusts
 * into the hull):
 *   1. resume YOUR OWN still-lingering hull  → the REBIND path (reads LIVE SAB).
 *   2. resume a DIFFERENT bumped ship by id  → rebind falls through to the
 *                                              roster restore.
 * Both land at the LIVE post-bump pose — the stale teleport does NOT reproduce.
 * The most likely reason is R2.26 (persist-forever): keeping the lingering hull
 * in the world preserves its presence marker (a `null` entry still satisfies the
 * rebind gate's `!== undefined`), so re-entry rebinds/restores to the live SAB
 * pose instead of falling to a frozen-pose restore — which on the old 15-min TTL
 * only happened once the hull had been EVICTED. The roster row's pose is also
 * kept fresh by `markLinger`/`markStored`. So this test LOCKS the correct
 * behaviour; if the user still sees a teleport on-device, that capture will name
 * a distinct path (e.g. a cross-sector Limbo restore) to target specifically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

interface Sample {
  id: string;
  playerId: string;
  x: number;
  y: number;
  isActive: boolean;
}

function collect(
  room: { onMessage: (t: string, cb: (s: unknown) => void) => void },
  target: Sample[],
): void {
  room.onMessage('snapshot', (snap: unknown) => {
    const s = snap as SnapshotMessage;
    for (const [id, e] of Object.entries(s.states)) {
      target.push({ id, playerId: e.playerId, x: e.x, y: e.y, isActive: e.isActive });
    }
  });
}

describe('SectorRoom integration — R2.33 re-entry pose (bumped lingering hull)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('resuming a BUMPED lingering hull by shipId lands at its LIVE pose, not the abandon pose', async () => {
    const PID_A = randomUUID();
    const PID_B = randomUUID();

    // A spawns at (0,0).
    const a1 = await harness.connectActive(PID_A, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let originalShipId = '';
    for (const [id, ship] of state.ships) {
      if (ship.playerId === PID_A && ship.isActive) {
        originalShipId = id;
        break;
      }
    }
    expect(originalShipId).not.toBe('');

    // A disconnects → its hull lingers at (0,0); the roster row is frozen at (0,0).
    await harness.disconnectClient(a1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });

    // B spawns just below A's lingering hull and thrusts into it (+y push).
    const samples: Sample[] = [];
    const b = await harness.connectActive(PID_B, { spawnX: 0, spawnY: -25, shipKind: 'fighter' });
    collect(b, samples);
    for (let i = 0; i < 20; i++) {
      harness.sendThrust(b);
      await harness.advance(50);
    }

    // A's lingering hull (isActive=false) has DRIFTED off its (0,0) abandon pose.
    const lingerSamples = samples.filter((s) => s.id === originalShipId && !s.isActive);
    expect(lingerSamples.length).toBeGreaterThan(5);
    const liveBump = lingerSamples[lingerSamples.length - 1]!;
    expect(
      liveBump.y,
      'precondition: the bump must move the lingering hull off its (0,0) abandon pose',
    ).toBeGreaterThan(5);

    // A RESUMES that exact hull by shipId (the roster-card "fly it again" path).
    samples.length = 0;
    await harness.connectActive(PID_A, { shipId: originalShipId });
    await harness.advance(200);

    // THE LOCK: A's re-entered ACTIVE hull must spawn at the hull's LIVE
    // post-bump pose, NOT teleport back to the (0,0) abandon pose.
    const aActive = samples.filter((s) => s.playerId === PID_A && s.isActive);
    expect(aActive.length).toBeGreaterThan(0);
    const reentered = aActive[aActive.length - 1]!;
    expect(
      reentered.y,
      `re-entered at y=${reentered.y.toFixed(1)} but the live bumped hull was at y=${liveBump.y.toFixed(1)} — ` +
        `the roster-restore teleported to the stale abandon pose (R2.33)`,
    ).toBeGreaterThan(liveBump.y - 10);
  }, 30_000);

  it('resuming a DIFFERENT bumped ship by shipId (rebind falls through) lands at its LIVE pose', async () => {
    // The roster evict-then-restore path (the one that reads rec.lastX). It is
    // reached only when rebind FALLS THROUGH — i.e. the player resumes a ship
    // that is NOT their current active/lingering hull. Scenario: swap away from
    // X to Y, X is bumped while parked, then swap BACK to X.
    const PID_A = randomUUID();
    const PID_B = randomUUID();

    // A spawns X at (0,0).
    const aX = await harness.connectActive(PID_A, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let shipX = '';
    for (const [id, ship] of state.ships) {
      if (ship.playerId === PID_A && ship.isActive) { shipX = id; break; }
    }
    expect(shipX).not.toBe('');

    // A swaps to a fresh ship Y far away — X is displaced into the world at (0,0).
    await harness.disconnectClient(aX);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });
    const aY = await harness.connectActive(PID_A, { isNewShip: true, shipKind: 'fighter', spawnX: 300, spawnY: 300 });

    // B pushes the parked X off its (0,0) abandon pose.
    const samples: Sample[] = [];
    const b = await harness.connectActive(PID_B, { spawnX: 0, spawnY: -25, shipKind: 'fighter' });
    collect(b, samples);
    for (let i = 0; i < 20; i++) {
      harness.sendThrust(b);
      await harness.advance(50);
    }
    const xLinger = samples.filter((s) => s.id === shipX && !s.isActive);
    expect(xLinger.length).toBeGreaterThan(5);
    const liveBump = xLinger[xLinger.length - 1]!;
    expect(liveBump.y, 'precondition: X must be pushed off (0,0)').toBeGreaterThan(5);

    // A swaps BACK to X by shipId (rebind falls through → roster restore of X).
    await harness.disconnectClient(aY);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });
    samples.length = 0;
    await harness.connectActive(PID_A, { shipId: shipX });
    await harness.advance(200);

    // THE LOCK: A re-enters X at its LIVE post-bump pose, not the (0,0) abandon
    // pose — even via the roster fall-through (the restore re-reads the row
    // after the evict's markStored). The bump here is tuning-dependent and was
    // only ~20 u under the old handling, inside this tolerance; the MOVED case
    // below is the tuning-independent lock.
    const aActive = samples.filter((s) => s.playerId === PID_A && s.isActive);
    expect(aActive.length).toBeGreaterThan(0);
    const reentered = aActive[aActive.length - 1]!;
    expect(
      reentered.y,
      `re-entered X at y=${reentered.y.toFixed(1)} but the live bumped hull was at y=${liveBump.y.toFixed(1)} — ` +
        `roster restore read the stale abandon pose (R2.33 / Path 3)`,
    ).toBeGreaterThan(liveBump.y - 12);
  }, 35_000);

  it('resuming a DIFFERENT parked ship that MOVED far from its abandon pose lands where it really is', async () => {
    // Same fall-through as above, but the parked hull is moved by a fixed,
    // tuning-independent displacement (worker SET_POSITION) instead of a bump.
    // Found 2026-11-13 by the arcade-handling retune (#566): with quicker
    // thrust B pushed X ~115 u and the resume landed at (0,0). The restore read
    // the roster row it fetched BEFORE `evictOwnerlessShip` re-stored the live
    // pose (`put` replaces the record object, so the earlier `rec` is stale).
    // The old slow bump moved X only ~20 u, inside the case above's tolerance.
    const PID_A = randomUUID();
    const aX = await harness.connectActive(PID_A, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let shipX = '';
    for (const [id, ship] of state.ships) {
      if (ship.playerId === PID_A && ship.isActive) { shipX = id; break; }
    }
    expect(shipX).not.toBe('');

    await harness.disconnectClient(aX);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });
    const aY = await harness.connectActive(PID_A, { isNewShip: true, shipKind: 'fighter', spawnX: 1500, spawnY: 1500 });

    // Move the parked X 400 u north, at rest.
    room._internals.postToWorker({
      type: 'SET_POSITION', entityId: `linger-${shipX}`, x: 0, y: 400, angle: 0, vx: 0, vy: 0, angvel: 0,
    });
    await harness.advance(200);

    await harness.disconnectClient(aY);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });
    const samples: Sample[] = [];
    const a2 = await harness.connectActive(PID_A, { shipId: shipX });
    collect(a2, samples);
    await harness.advance(200);

    const aActive = samples.filter((s) => s.id === shipX && s.isActive);
    expect(aActive.length).toBeGreaterThan(0);
    const reentered = aActive[aActive.length - 1]!;
    expect(
      Math.hypot(reentered.x, reentered.y - 400),
      `re-entered X at (${reentered.x.toFixed(1)}, ${reentered.y.toFixed(1)}) but it was parked at (0, 400) — ` +
        `the restore read the roster row from before the evict re-stored the live pose`,
    ).toBeLessThan(10);
  }, 35_000);
});
