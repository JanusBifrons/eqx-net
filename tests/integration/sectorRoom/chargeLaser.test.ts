/**
 * Living World P3c (plan peppy-jumping-pinwheel) — the robot orb's CHARGE LASER
 * through a real SectorRoom: the AI trigger starts a wind-up, clients see
 * `drones[].charging` in the snapshot, and the beam lands only after the
 * charge elapses (it is a dodgeable telegraph, not an instant hit).
 *
 * Fails on the pre-P3c code: the orb's beam was instant (no `charging` bit is
 * ever sent, and damage arrives with no wind-up).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { DamageEvent, SnapshotMessage } from '../../../src/shared-types/messages.js';

describe('SectorRoom integration — robot charge laser (P3c)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      // A robot orb 300 u north of the spawn, nose pointing south at the pilot.
      dronePoses: [{ kind: 'robot-circle', x: 0, y: 300, angle: Math.PI, hullExposed: true }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('telegraphs (drones[].charging) before the beam lands', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { initialHull: 99999 });
    let chargingAt: number | null = null;
    let hitAt: number | null = null;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      if (chargingAt === null && snap.drones?.some((d) => d.charging === true)) chargingAt = Date.now();
    });
    cr.onMessage('damage', (e: DamageEvent) => {
      if (hitAt === null && e.targetId === pid) hitAt = Date.now();
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && hitAt === null) await new Promise((r) => setTimeout(r, 50));

    expect(chargingAt, 'the client never saw the charge telegraph').not.toBeNull();
    expect(hitAt, 'the charge laser never fired').not.toBeNull();
    // The beam lands AFTER the wind-up was visible — ~1.2 s of charge, minus
    // snapshot cadence slack (20 Hz) on the first observed charging frame.
    expect(hitAt! - chargingAt!).toBeGreaterThanOrEqual(900);
  });
});
