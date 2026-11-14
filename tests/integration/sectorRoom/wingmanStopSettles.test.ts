/**
 * RTS command layer — ships ordered together stop and settle without shoving.
 *
 * Bug (found by the fleet-command e2e author in real play, 2026-11-14): two
 * wingmen flying close together (the same patrol) are given Stop. The server
 * reports both "Guarding" at once, but they keep pushing apart for seconds:
 * in one run a ship still moved ~18 u/s more than 8 s after Stop; in another
 * the gap grew 115 → 181 u over ~3.5 s, in opposite directions, before it
 * settled. Owner: "press Stop → ships stop". The classic RTS case is the
 * same: several ships sent to ONE point must arrive and settle round it,
 * not shove each other.
 *
 * Recipe: park fighters (fresh-spawn displacement + Spectate), send two at
 * one far point so their paths converge until their hulls touch (as on a
 * shared patrol), then Stop both. Before the fix this reproduced the report
 * exactly: the gap grew 94 → 180 u in opposite directions, and both crawled
 * on at ~10 u/s for seconds (below the brake's speed band). Second case: a
 * Move of four ships to one point. Real room, real physics, live server poses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { wingmanConfigFor } from '../../../src/server/fleet/FleetCommandSubsystem.js';

interface Pose { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }

/** "Stopped": slower than this fraction of the ship's max speed. */
const STOPPED_SPEED_FRAC = 0.01;

describe('SectorRoom integration — wingmen ordered together stop and settle (RTS stop drift)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  /** Park one fighter per spawn point for one owner; returns their ids. */
  async function parkFleet(pid: string, spawns: ReadonlyArray<readonly [number, number]>): Promise<string[]> {
    const ids: string[] = [];
    const activeOf = (): string => {
      const state = harness.getServerRoom()!.state as SectorState;
      for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };
    let client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: spawns[0]![0], spawnY: spawns[0]![1] });
    for (let i = 0; ; i++) {
      ids.push(activeOf());
      if (i === spawns.length - 1) break;
      await harness.disconnectClient(client);
      await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
      client = await harness.connectActive(pid, {
        isNewShip: true, shipKind: 'fighter', spawnX: spawns[i + 1]![0], spawnY: spawns[i + 1]![1],
      });
    }
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(new Set(ids).size).toBe(spawns.length);
    const fleet = harness.getServerRoom()!._internals.fleet;
    for (const id of ids) expect(fleet.isAttached(id), `${id} is AI-flown`).toBe(true);
    return ids;
  }

  function poseReader(): (id: string) => Pose {
    const r = harness.getServerRoom() as unknown as { entityPoseInto: (id: string, out: Pose) => boolean };
    return (id) => {
      const p: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
      expect(r.entityPoseInto(id, p), `${id} has a pose`).toBe(true);
      return p;
    };
  }

  it('Stop: two wingmen flying hull to hull stop promptly, keep their spacing and stay stopped', async () => {
    const pid = randomUUID();
    const ids = await parkFleet(pid, [[0, 0], [0, 100]]);
    const fleet = harness.getServerRoom()!._internals.fleet;
    const at = poseReader();

    // Both at one far point (a shared waypoint): their paths converge until
    // the hulls touch.
    expect(fleet.applyOrder(pid, ids, { kind: 'move', x: 8000, y: 50 })).toHaveLength(2);
    await harness.advance(5000);
    const a0 = at(ids[0]!), b0 = at(ids[1]!);
    const v0 = Math.max(Math.hypot(a0.vx, a0.vy), Math.hypot(b0.vx, b0.vy));
    const gap0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
    expect(v0, 'precondition: flying').toBeGreaterThan(200);
    expect(gap0, 'precondition: close together').toBeLessThan(150);

    expect(fleet.applyOrder(pid, ids, { kind: 'stop' })).toHaveLength(2);
    const kind = getShipKind('fighter');
    const still = kind.maxSpeed * STOPPED_SPEED_FRAC;
    // The physical brake from v0 on the reverse key: dv/dt = −(a + k·v).
    const { stats } = wingmanConfigFor(kind);
    const k = stats.linearDamping, a = stats.reverseAccel;
    const tBrake = k > 0 ? Math.log(1 + (k * v0) / a) / k : v0 / a;
    // Prompt: stopped within a second of what the brakes allow ...
    const tSettle = tBrake + 1;
    const trace: string[] = [];
    let worst = 0;
    let gapSettle = -1, gapMax = 0;
    for (let t = 0; t <= tSettle + 4; t += 0.25) {
      const pa = at(ids[0]!), pb = at(ids[1]!);
      const sa = Math.hypot(pa.vx, pa.vy), sb = Math.hypot(pb.vx, pb.vy);
      const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      trace.push(`${t.toFixed(2)}s A ${sa.toFixed(1)} B ${sb.toFixed(1)} gap ${gap.toFixed(1)}`);
      if (t >= tSettle) {
        // ... and still for the next 4 s.
        if (gapSettle < 0) gapSettle = gap;
        gapMax = Math.max(gapMax, gap);
        worst = Math.max(worst, sa, sb);
      }
      await harness.advance(250);
    }
    const msg = `v0 ${v0.toFixed(0)} u/s, gap ${gap0.toFixed(0)} u, brake ${tBrake.toFixed(2)} s, `
      + `stopped by ${tSettle.toFixed(2)} s, still < ${still.toFixed(1)} u/s\n${trace.join('\n')}`;
    expect(worst, `speeds after Stop (u/s):\n${msg}`).toBeLessThan(still);
    // They brake side by side: no pushing apart (the report: 115 → 181 u;
    // this test saw 94 → 180 before the fix, and up to ~26 u after it from
    // the bounce of the hulls touching as Stop lands).
    expect(Math.abs(gapSettle - gap0), `the ships keep their spacing through the brake:\n${msg}`).toBeLessThan(40);
    expect(gapMax - gapSettle, `the gap does not grow once stopped:\n${msg}`).toBeLessThan(5);
  }, 120_000);

  it('Move: four wingmen sent to ONE point arrive, settle round it and stop', async () => {
    const pid = randomUUID();
    const ids = await parkFleet(pid, [[0, 0], [0, 300], [0, -300], [-300, 0]]);
    const fleet = harness.getServerRoom()!._internals.fleet;
    const at = poseReader();
    const TX = 2500, TY = 0;
    expect(fleet.applyOrder(pid, ids, { kind: 'move', x: TX, y: TY })).toHaveLength(4);

    const kind = getShipKind('fighter');
    const still = kind.maxSpeed * STOPPED_SPEED_FRAC;
    // Every order finishes (bounded): they all arrive.
    let done = false;
    for (let i = 0; i < 160 && !done; i++) {
      await harness.advance(250);
      done = ids.every((id) => fleet.brainOf(id)!.order === null);
    }
    const where = (): string => ids.map((id) => {
      const p = at(id);
      return `${JSON.stringify(fleet.brainOf(id)!.order)} @ ${p.x.toFixed(0)},${p.y.toFixed(0)} v ${Math.hypot(p.vx, p.vy).toFixed(1)}`;
    }).join('; ');
    expect(done, `every move order completes (${where()})`).toBe(true);

    // Then they hold still round the point, not shoving each other.
    await harness.advance(1000);
    const start = ids.map(at);
    const trace: string[] = [];
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      const ps = ids.map(at);
      const sp = ps.map((p) => Math.hypot(p.vx, p.vy));
      worst = Math.max(worst, ...sp);
      trace.push(`${sp.map((s) => s.toFixed(1)).join(' ')} | from point ${ps.map((p) => Math.hypot(p.x - TX, p.y - TY).toFixed(0)).join(' ')}`);
      await harness.advance(250);
    }
    const msg = trace.join('\n');
    expect(worst, `speeds after arrival (u/s):\n${msg}`).toBeLessThan(still);
    const end = ids.map(at);
    for (let i = 0; i < ids.length; i++) {
      const moved = Math.hypot(end[i]!.x - start[i]!.x, end[i]!.y - start[i]!.y);
      expect(moved, `ship ${i} holds its spot once arrived:\n${msg}`).toBeLessThan(10);
    }
    // Round the point: within a few ship spacings of it (#18: from shipTuning).
    const spacing = shipTuning(kind).flockSeparation;
    for (const p of end) {
      expect(Math.hypot(p.x - TX, p.y - TY), `settled round the ordered point:\n${msg}`).toBeLessThan(spacing * 3);
    }
  }, 150_000);
});
