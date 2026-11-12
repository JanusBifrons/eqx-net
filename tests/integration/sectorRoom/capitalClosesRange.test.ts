/**
 * Bug (measured 2026-11-12, `showcase-capital-duel`): an NPC battleship that
 * turns hostile while under way, with its target (a heavy cruiser) just
 * beyond its 16" reach, kept OPENING the range. Out of reach the broadside AI
 * turned before it thrust and never braked, so the hull coasted on its patrol
 * velocity away from the target: the aft turret lost the target at ~20–25 s,
 * never fired, and hostility lapsed at ~30 s.
 *
 * Expected: a hostile capital beyond main-battery reach stops opening the
 * range at once (brakes with its real reverse thrust), closes to reach and
 * fires, using its own slow handling (no teleport, no handling change). A
 * capital already in reach keeps holding its broadside stand-off.
 *
 * Layout: battleship at the origin, bow +y (angle 0), making 40 u/s ahead
 * (the measured patrol speed); the pilot flies a heavy cruiser dead astern,
 * 150 u beyond the battleship's main-battery reach. The pilot joins with
 * `instantLock` (completes NPC locks on it in reach; see capitalEngagement).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { HostileDroneBehaviour, BROADSIDE_STANDOFF } from '../../../src/core/ai/HostileDroneBehaviour.js';
import type { ShellSalvo } from '../../../src/shared-types/messages/shellEvents.js';

const REACH = new HostileDroneBehaviour('battleship').getFireRange();
const DRONE_ID = 'pose-drone-0';

type Pose = { x: number; y: number; vx: number; vy: number };
interface RoomPeek {
  swarmEntitySnapshot(id: string): Pose | null;
  shipPoseCache: Map<string, Pose>;
}

describe('SectorRoom integration — hostile capital closes the range', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function boot(dronePose: { x: number; y: number; angle: number; vx?: number; vy?: number }): Promise<void> {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true,
      dronePoses: [{ kind: 'battleship', ...dronePose }],
    });
  }

  /** Range battleship → pilot, from the server's live poses (null until both exist). */
  function range(pid: string): number | null {
    const room = harness!.getServerRoom() as unknown as RoomPeek;
    const d = room.swarmEntitySnapshot(DRONE_ID);
    if (!d) return null;
    const dx = d.x, dy = d.y;
    const p = room.shipPoseCache.get(pid);
    if (!p) return null;
    return Math.hypot(p.x - dx, p.y - dy);
  }

  it('out of reach and opening: brakes at once, closes to reach and fires', { timeout: 100_000 }, async () => {
    await boot({ x: 0, y: 0, angle: 0, vx: 0, vy: 40 });
    const pid = randomUUID();
    const cr = await harness!.connectActive(pid, {
      shipKind: 'heavy-cruiser', spawnX: 0, spawnY: -(REACH + 150),
      initialHull: 1_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    let fired = false;
    cr.onMessage('shell_salvo', (m: ShellSalvo) => { if (m.w === 'naval_xl') fired = true; });

    const t0 = Date.now();
    const r0 = range(pid)!;
    expect(r0, 'precondition: the pilot starts beyond 16" reach').toBeGreaterThan(REACH);
    let peak = r0, peakAt = 0, last = r0, firedAt = -1;
    while (Date.now() - t0 < 75_000 && firedAt < 0) {
      await new Promise((r) => setTimeout(r, 100));
      const t = (Date.now() - t0) / 1000;
      const r = range(pid);
      if (r === null) continue;
      if (r > peak) { peak = r; peakAt = t; }
      last = r;
      if (fired && firedAt < 0) firedAt = t;
    }
    console.log(`[closes-range] reach=${REACH.toFixed(0)} r0=${r0.toFixed(0)} peak=${peak.toFixed(0)}@${peakAt.toFixed(1)}s last=${last.toFixed(0)} fired@${firedAt.toFixed(1)}s`);
    // At 40 u/s and the real reverse thrust it stops within ~20 s; coasting it
    // was still opening at ~15 u/s there.
    expect(peakAt, 'the range kept opening').toBeLessThan(25);
    expect(peak - r0, 'the range opened too far before it stopped').toBeLessThan(600);
    expect(last, 'the battleship was not closing the range').toBeLessThan(peak);
    expect(firedAt, 'the 16" battery never fired').toBeGreaterThan(0);
  });

  it('in reach: still holds its broadside stand-off', { timeout: 60_000 }, async () => {
    // Pilot on the starboard beam at the stand-off distance, battleship at rest.
    const standoff = REACH * BROADSIDE_STANDOFF;
    await boot({ x: 0, y: 0, angle: 0 });
    const pid = randomUUID();
    await harness!.connectActive(pid, {
      shipKind: 'heavy-cruiser', spawnX: standoff, spawnY: 0,
      initialHull: 1_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    const t0 = Date.now();
    let lo = Infinity, hi = 0;
    while (Date.now() - t0 < 20_000) {
      await new Promise((r) => setTimeout(r, 100));
      const r = range(pid);
      if (r === null) continue;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    console.log(`[holds-standoff] standoff=${standoff.toFixed(0)} range ${lo.toFixed(0)}..${hi.toFixed(0)}`);
    expect(hi, 'left main-battery reach').toBeLessThan(REACH);
    expect(Math.abs(lo - standoff), 'closed in from the stand-off').toBeLessThan(0.1 * standoff);
    expect(Math.abs(hi - standoff), 'drifted out from the stand-off').toBeLessThan(0.1 * standoff);
  });
});
