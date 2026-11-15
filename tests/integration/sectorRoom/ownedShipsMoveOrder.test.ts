/**
 * RTS Part B slice 9 — the Move order on the AI pilot brain (`setTravel`).
 *
 * Owner rule: Move = keep going and shoot on the way. An Aggressive ship is
 * ordered across the sector past a robot cube sitting on its route. It fires
 * at the cube while the cube is in its sights, never turns back to chase it,
 * arrives at the ordered point and guards there; the order completes (the
 * fleet status drops the order and reads "guarding").
 *
 * Failing first: before this slice a Move only made the destination a guard
 * post; with a robot in sight the brain fought it (combat manoeuvres) instead
 * of travelling, and the order never completed (the wingman store's order
 * stayed until the next command).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';

describe('SectorRoom integration — the Move order travels and shoots on the way (RTS Part B slice 9)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a ship moved past a robot fires at it on the way, never turns back for it, arrives and completes the order', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(internals.fleet.isAttached(sid)).toBe(true);
    // Aggressive: it engages the robot on sight (the Move must not let it).
    internals.fleet.setStance(pid, [sid], 'aggressive');

    const TX = 0;
    const TY = 5000;
    // A robot cube on the route, ahead of the ship.
    expect(internals.spawnTestDrone('cube', 0, 2200, 'robot-square')).toBe(true);
    const cubeStart = internals.swarmHealth.get('cube')!;

    // Count the ship's hits on the cube (the room's one damage choke point).
    const r = room as unknown as { applyDamage: (t: string, s: string, d: number, x?: number, y?: number) => void };
    const orig = r.applyDamage.bind(room);
    let hitsOnCube = 0;
    r.applyDamage = (t, s, d, x, y) => {
      if (s === sid && t === 'cube') hitsOnCube++;
      orig(t, s, d, x, y);
    };

    expect(internals.fleet.applyOrder(pid, [sid], { kind: 'move', x: TX, y: TY })).toEqual([sid]);
    const brain = internals.aiBrainOf(sid)!;
    const arrive = shipTuning(getShipKind('fighter')).wingmanArrive;
    let targeted = false;
    let movingWhileTargeting = false;
    let worstCourse = 1;
    let done = false;
    const trace: string[] = [];
    for (let i = 0; i < 120 && !done; i++) {
      await harness.advance(250);
      const p = internals.lingeringPoseCache.get(sid);
      expect(p, 'the ship is alive and flown').toBeDefined();
      const dx = TX - p!.x;
      const dy = TY - p!.y;
      const dist = Math.hypot(dx, dy);
      const sp = Math.hypot(p!.vx, p!.vy);
      const row = internals.fleet.statusFor(pid)[0]!;
      if (brain.getTargetId?.() === 'cube') {
        targeted = true;
        if (row.activity === 'moving') movingWhileTargeting = true;
      }
      // Never turns back: while under way (not braking for the point), its
      // course points at the destination, not at the cube behind it.
      if (dist > 600 && sp > 50) worstCourse = Math.min(worstCourse, (p!.vx * dx + p!.vy * dy) / (sp * dist));
      trace.push(`${(i * 0.25).toFixed(2)}s @ ${p!.x.toFixed(0)},${p!.y.toFixed(0)} v ${sp.toFixed(0)} tgt ${brain.getTargetId?.() ?? '-'} ${row.activity} order ${row.order?.kind ?? '-'}`);
      done = internals.fleet.brainOf(sid)!.order === null;
    }
    const msg = trace.join('\n');
    expect(targeted, `the ship saw the robot (its locks follow it):\n${msg}`).toBe(true);
    expect(movingWhileTargeting, `the panel reads Moving while it shoots on the way:\n${msg}`).toBe(true);
    expect(hitsOnCube, `it fired on the robot ahead on the way:\n${msg}`).toBeGreaterThan(0);
    const cubeNow = internals.swarmHealth.get('cube');
    expect(cubeNow === undefined || cubeNow < cubeStart, 'the cube took damage').toBe(true);
    expect(worstCourse, `it never turned back to chase:\n${msg}`).toBeGreaterThan(0.5);
    expect(done, `the move order completes on arrival:\n${msg}`).toBe(true);

    const p = internals.lingeringPoseCache.get(sid)!;
    expect(Math.hypot(p.x - TX, p.y - TY), 'arrived at the ordered point').toBeLessThanOrEqual(arrive);
    const row = internals.fleet.statusFor(pid)[0]!;
    expect(row.order, 'the status drops the order').toBeNull();
    expect(row.mode, 'back on its mode').toBe('defend');
    // It now guards the point (the cube may still be in reach: guarding or fighting there).
    expect(['guarding', 'attacking', 'chasing']).toContain(row.activity);
    const hb = brain as unknown as { getGuardPostX(): number | null; getGuardPostY(): number | null };
    expect([hb.getGuardPostX(), hb.getGuardPostY()], 'its guard post is the destination').toEqual([TX, TY]);
    await harness.disconnectClient(client);
  }, 90_000);
});
