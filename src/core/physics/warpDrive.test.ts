/**
 * In-sector warp-to (Phase 4 step 4): the state machine, then real Rapier
 * worlds: a warp lands on its target, passes through anything on the way,
 * and two worlds fed the same inputs stay identical (the server worker and
 * the client prediction run exactly this).
 */
import { describe, it, expect } from 'vitest';
import { newWarpState, stepWarp, WARP_SPOOL_TICKS, WARP_SPEED } from './warpDrive.js';
import { PhysicsWorld, type ShipInput } from './World.js';

const DT = 1 / 60;
const idle: ShipInput = { thrust: false, turnLeft: false, turnRight: false };

describe('stepWarp', () => {
  it('spools, cruises, drops, then ignores the held request', () => {
    const s = newWarpState();
    const req = { x: 50_000, y: 0 };
    // The request tick starts the spool; it runs WARP_SPOOL_TICKS more.
    for (let i = 0; i < WARP_SPOOL_TICKS; i++) expect(stepWarp(s, req, 0, 0, DT)).toBe('fly');
    expect(stepWarp(s, req, 0, 0, DT)).toBe('engage');
    expect(s.phase).toBe('cruise');
    expect(stepWarp(s, req, 20_000, 0, DT)).toBe('cruise');
    expect(stepWarp(s, req, 50_000 - 100, 0, DT)).toBe('drop');
    expect(s.phase).toBe('idle');
    expect(stepWarp(s, req, 50_000, 0, DT)).toBe('fly'); // latched: no second warp
    expect(s.phase).toBe('idle');
    stepWarp(s, null, 50_000, 0, DT); // request cleared: latch released
    expect(s.latched).toBe(false);
  });

  it('dropping the request during the spool cancels it; a new target restarts the spool', () => {
    const s = newWarpState();
    for (let i = 0; i < 100; i++) stepWarp(s, { x: 9e4, y: 0 }, 0, 0, DT);
    expect(stepWarp(s, null, 0, 0, DT)).toBe('fly');
    expect(s.phase).toBe('idle');
    for (let i = 0; i < 100; i++) stepWarp(s, { x: 9e4, y: 0 }, 0, 0, DT);
    stepWarp(s, { x: 0, y: 9e4 }, 0, 0, DT);
    expect(s.ticks).toBe(0);
  });
});

async function warpRun(withObstacle: boolean): Promise<{ path: Array<[number, number]>; obstacle: { x: number; y: number } | null; arrivedAt: number; landed: [number, number] }> {
  const w = await PhysicsWorld.create();
  w.spawnShip('p', 0, 0, 'fighter');
  if (withObstacle) w.spawnObstacle('rock', 60_000, 0, 200, 50);
  const target = { warpX: 120_000, warpY: 0 };
  const path: Array<[number, number]> = [];
  let arrivedAt = -1;
  let landed: [number, number] = [NaN, NaN];
  for (let t = 0; t < WARP_SPOOL_TICKS + 600; t++) {
    w.applyInput('p', { ...idle, ...target });
    w.tick(DT);
    const s = w.getShipState('p')!;
    path.push([s.x, s.y]);
    if (arrivedAt < 0 && w.warpArrived('p')) { arrivedAt = t; landed = [s.x, s.y]; }
  }
  const rock = withObstacle ? w.getShipState('rock') : null;
  w.dispose();
  return { path, obstacle: rock ? { x: rock.x, y: rock.y } : null, arrivedAt, landed };
}

describe('warp in a real physics world', () => {
  it('lands on its target, after the spool and a ~6 s run', async () => {
    const r = await warpRun(false);
    // Where it dropped out (it then coasts on at its exit speed).
    expect(Math.hypot(r.landed[0] - 120_000, r.landed[1])).toBeLessThan(5);
    const expected = WARP_SPOOL_TICKS + Math.ceil((120_000 / WARP_SPEED) * 60);
    expect(r.arrivedAt).toBeGreaterThan(WARP_SPOOL_TICKS);
    expect(r.arrivedAt).toBeLessThan(expected + 60);
  });

  it('passes through an obstacle on the way without touching it', async () => {
    const r = await warpRun(true);
    expect(r.obstacle).not.toBeNull();
    expect(Math.hypot(r.obstacle!.x - 60_000, r.obstacle!.y)).toBeLessThan(1);
    // Where it dropped out (it then coasts on at its exit speed).
    expect(Math.hypot(r.landed[0] - 120_000, r.landed[1])).toBeLessThan(5);
  });

  it('two worlds fed the same inputs warp identically (server == prediction)', async () => {
    const a = await warpRun(true), b = await warpRun(true);
    expect(a.path).toEqual(b.path);
    expect(a.arrivedAt).toBe(b.arrivedAt);
  });
});

describe('warp under prediction correction (Reconciler)', () => {
  it('a correction mid-spool and mid-run replays from the right warp state', async () => {
    const { Reconciler } = await import('../prediction/Reconciler.js');
    // "Server": one world fed every input. "Client": another, corrected to the
    // server's state at an older acked tick, then replaying.
    const server = await PhysicsWorld.create();
    const client = await PhysicsWorld.create();
    server.spawnShip('p', 0, 0, 'fighter');
    client.spawnShip('p', 0, 0, 'fighter');
    const rec = new Reconciler(client, 'p');
    const serverStates: Array<ReturnType<PhysicsWorld['getShipState']>> = [];
    const total = WARP_SPOOL_TICKS + 200;
    let worst = 0, corrected = false;
    for (let t = 0; t < total; t++) {
      const input = { ...idle, warpX: 90_000, warpY: 30_000 };
      server.applyInput('p', input); server.tick(DT); serverStates[t] = server.getShipState('p');
      client.applyInput('p', input);
      rec.recordInput({ tick: t, thrust: false, turnLeft: false, turnRight: false, warpX: 90_000, warpY: 30_000, sentAt: 0 });
      client.tick(DT);
      // Corrections 20 ticks behind, once in the spool and once in the run.
      if (t === WARP_SPOOL_TICKS - 50 || t === WARP_SPOOL_TICKS + 100) {
        const acked = t - 20;
        rec.reconcile(serverStates[acked]!, acked, t + 1, acked);
        corrected = true;
      }
      // Every tick after a correction, the client must match the server
      // (a replay from the wrong spool count engages early: km apart mid-run).
      if (corrected) {
        const a = server.getShipState('p')!, b = client.getShipState('p')!;
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(worst).toBeLessThan(1);
    expect(client.warpPhase('p')).toBe(server.warpPhase('p'));
  });
});
