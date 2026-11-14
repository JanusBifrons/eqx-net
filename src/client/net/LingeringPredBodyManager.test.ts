/**
 * RTS slice 4c — a lingering hull flown by a server-side wingman must turn
 * smoothly on screen, not in 20 Hz steps.
 *
 * Before: each snapshot reset the predWorld body with angvel 0 and no input,
 * and only the POSITION was spring-smoothed, so a turning wingman's angle sat
 * still for two frames and then jumped three ticks' worth (visible stepping).
 *
 * Now (remote-ship recipe): the snapshot's angvel seeds the body, the hull's
 * `lastInput` bits forward-predict it every tick, and the angle residual is
 * spring-smoothed like the position.
 *
 * The test flies a real fighter on an authoritative "server" PhysicsWorld with
 * a held turn + thrust, sends a snapshot every 3 ticks (20 Hz) and drives the
 * manager exactly as the client does (router → noteSnapshot + ensure; per
 * tick applyInputs + tick; per frame applyPerFrameOffsets).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld, type ShipInput } from '../../core/physics/World.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import { LingeringPredBodyManager } from './LingeringPredBodyManager.js';

const ID = 'HULL_1';
const BODY = `linger-${ID}`;
const FRAME_MS = 1000 / 60;

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

type LingerEntry = NonNullable<RenderMirror['lingeringShips']> extends Map<string, infer E> ? E : never;

interface Run {
  /** Drawn (mirror) angle per frame. */
  drawn: number[];
  /** Server angle per tick. */
  server: number[];
}

async function fly(opts: { sendBits: boolean; ticks: number; input: ShipInput; legacy?: boolean }): Promise<Run> {
  const server = await PhysicsWorld.create();
  const client = await PhysicsWorld.create();
  server.spawnShip(BODY, 0, 0, 'fighter');
  const mgr = new LingeringPredBodyManager();
  const entry: LingerEntry = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', ownerPlayerId: 'p' };
  const mirror = { ships: new Map(), lingeringShips: new Map([[ID, entry]]) } as unknown as RenderMirror;

  const deliver = (): void => {
    const s = server.getShipState(BODY)!;
    entry.x = s.x; entry.y = s.y; entry.vx = s.vx; entry.vy = s.vy; entry.angle = s.angle;
    if (!opts.legacy) entry.thrusting = mgr.noteSnapshot(ID, s.angvel, opts.sendBits ? { ...opts.input, boost: false, reverse: false } : undefined);
    mgr.ensure(ID, client, mirror);
  };

  // Spin up to a steady turn on the server before the client sees it.
  for (let i = 0; i < 30; i++) { server.applyInput(BODY, opts.input); server.tick(1 / 60); }
  deliver();

  const run: Run = { drawn: [], server: [] };
  for (let t = 1; t <= opts.ticks; t++) {
    server.applyInput(BODY, opts.input);
    server.tick(1 / 60);
    run.server.push(server.getShipState(BODY)!.angle);
    mgr.applyInputs(client);
    client.tick(1 / 60);
    if (t % 3 === 0) deliver();
    mgr.applyPerFrameOffsets(client, mirror, FRAME_MS);
    run.drawn.push(entry.angle);
  }
  return run;
}

function maxStep(xs: number[]): number {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs(wrapPi(xs[i]! - xs[i - 1]!)));
  return m;
}

describe('LingeringPredBodyManager — wingman-flown hull renders smoothly (RTS slice 4c)', () => {
  const TURN: ShipInput = { thrust: true, turnLeft: true, turnRight: false, boost: false, reverse: false };
  let smooth: Run;
  let noBits: Run;
  let legacy: Run;

  beforeAll(async () => {
    smooth = await fly({ sendBits: true, ticks: 120, input: TURN });
    // A server that sends no bits (pre-4c wire): the seeded angvel alone
    // keeps the turn going between snapshots.
    noBits = await fly({ sendBits: false, ticks: 120, input: TURN });
    // The pre-4c client: no snapshot angvel, no bits (body reset with angvel
    // 0). The contrast proving the test can see the stepping.
    legacy = await fly({ sendBits: false, ticks: 120, input: TURN, legacy: true });
  });

  it('a steady turn never steps more than ~1.25 ticks of rotation in one frame', () => {
    const perTick = maxStep(smooth.server);
    expect(perTick).toBeGreaterThan(0.01); // it really is turning
    expect(maxStep(smooth.drawn)).toBeLessThanOrEqual(perTick * 1.25);
  });

  it('the drawn angle tracks the authoritative angle', () => {
    for (let i = 0; i < smooth.drawn.length; i++) {
      expect(Math.abs(wrapPi(smooth.drawn[i]! - smooth.server[i]!))).toBeLessThan(0.02);
    }
  });

  it('the snapshot angvel alone already keeps a steady turn smooth', () => {
    expect(maxStep(noBits.drawn)).toBeLessThanOrEqual(maxStep(smooth.server) * 1.25);
  });

  it('contrast: the pre-4c reset (angvel 0, no bits) visibly steps', () => {
    expect(maxStep(legacy.drawn)).toBeGreaterThan(maxStep(smooth.server) * 1.5);
  });

  it('the thrust bit propagates to the lingering entry, and absent bits keep the last value', async () => {
    const world = await PhysicsWorld.create();
    const mgr = new LingeringPredBodyManager();
    expect(mgr.noteSnapshot(ID, 0, TURN)).toBe(true);
    // Idle-bits dedupe: an absent `lastInput` means "unchanged".
    expect(mgr.noteSnapshot(ID, 0, undefined)).toBe(true);
    expect(mgr.noteSnapshot(ID, 0, { ...TURN, thrust: false })).toBe(false);
    // A hull the wire never carried bits for draws no flame.
    expect(mgr.noteSnapshot('OTHER', 0, undefined)).toBe(false);
    // despawn forgets the hull's motion state.
    mgr.despawn(ID, world);
    expect(mgr.noteSnapshot(ID, 0, undefined)).toBe(false);
  });

  it('forward prediction is bounded per snapshot (lookahead cap)', async () => {
    const world = await PhysicsWorld.create();
    const mgr = new LingeringPredBodyManager();
    const entry: LingerEntry = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', ownerPlayerId: 'p' };
    const mirror = { ships: new Map(), lingeringShips: new Map([[ID, entry]]) } as unknown as RenderMirror;
    mgr.noteSnapshot(ID, 0, TURN);
    mgr.ensure(ID, world, mirror);
    let calls = 0;
    const counting = new Proxy(world, {
      get(target, prop, recv) {
        if (prop === 'applyInput') return (...a: Parameters<PhysicsWorld['applyInput']>) => { calls++; target.applyInput(...a); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
    for (let i = 0; i < 40; i++) { mgr.applyInputs(counting); world.tick(1 / 60); }
    expect(calls).toBe(8); // STAGE_3_MAX_LOOKAHEAD_TICKS
    mgr.ensure(ID, world, mirror); // next snapshot re-arms it
    mgr.applyInputs(counting);
    expect(calls).toBe(9);
  });
});
