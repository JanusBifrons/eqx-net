/**
 * RTS Part A S1 — every remote ship turns smoothly on screen, on the ONE
 * remote-ship path (snapshot reset → forward prediction with the snapshot's
 * input bits → decaying x/y/ANGLE offsets). Ported from the parked-hull
 * manager's steady-turn test (`LingeringPredBodyManager.test.ts`), which this
 * path replaces at S3.
 *
 * The test flies a real fighter on an authoritative "server" PhysicsWorld
 * with a held turn + thrust, sends a snapshot every 3 ticks (20 Hz) and drives
 * the client's real functions exactly as `ColyseusClient` does:
 * `preResetRemoteShips` + `computeRemoteLerpOffsets` per snapshot,
 * `applyRemoteShipInputs` + `tick` per tick, `stepRemoteShipOffset` per frame.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type ShipInput } from '../../core/physics/World.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages.js';
import { applyRemoteShipInputs, preResetRemoteShips, type PreResetRemoteCtx } from './snapshotRemoteSync.js';
import { computeRemoteLerpOffsets, stepRemoteShipOffset, type RemoteShipOffset } from './remoteLerpOffsets.js';
import { createRemotePredictionGuard } from './remotePredictionGuard.js';
import { STAGE_3_MAX_LOOKAHEAD_TICKS } from './predictionTuning.js';

const ID = 'R1';
const FRAME_MS = 1000 / 60;
const IDS = [ID];

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

interface Run {
  /** Drawn (mirror) angle per frame. */
  drawn: number[];
  /** Server angle per tick. */
  server: number[];
}

interface FlyOpts {
  ticks: number;
  input: ShipInput;
  /** The snapshot carries the held bits (the fixed server). */
  sendBits: boolean;
  /** Reset the body with angvel 0 (the pre-4c parked-hull reset, contrast). */
  zeroAngvel?: boolean;
  /** Draw the raw body angle, no angle offset spring (contrast). */
  noAngleSpring?: boolean;
}

function makeCtx(world: PhysicsWorld): PreResetRemoteCtx {
  return {
    predWorld: world,
    mirror: { ships: new Map() } as unknown as RenderMirror,
    preResetRemotePosScratch: new Map(),
    preResetRemotePosEntries: [],
    remoteLastInputs: new Map(),
    remoteForwardTicks: new Map(),
  };
}

function snapshotOf(server: PhysicsWorld, tick: number, opts: Pick<FlyOpts, 'sendBits' | 'zeroAngvel' | 'input'>): SnapshotMessage {
  const s = server.getShipState(ID)!;
  return {
    type: 'snapshot',
    serverTick: tick,
    states: {
      [ID]: {
        x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: opts.zeroAngvel ? 0 : s.angvel,
        playerId: 'pilot', isActive: true,
        ...(opts.sendBits ? { lastInput: { thrust: opts.input.thrust, turnLeft: opts.input.turnLeft, turnRight: opts.input.turnRight, boost: false, reverse: false } } : {}),
      },
    },
  } as unknown as SnapshotMessage;
}

async function fly(opts: FlyOpts): Promise<Run> {
  const server = await PhysicsWorld.create();
  const client = await PhysicsWorld.create();
  server.spawnShip(ID, 0, 0, 'fighter');
  client.spawnShip(ID, 0, 0, 'fighter');
  const ctx = makeCtx(client);
  const guard = createRemotePredictionGuard();
  const offsets = new Map<string, RemoteShipOffset>();

  let tick = 0;
  const deliver = (): void => {
    const preReset = preResetRemoteShips(snapshotOf(server, tick, opts), 'me', ctx);
    computeRemoteLerpOffsets({ predWorld: client, preResetRemotePos: preReset, remoteShipOffsets: offsets, predGuard: guard });
  };

  // Spin up to a steady turn on the server before the client sees it.
  for (let i = 0; i < 30; i++) { server.applyInput(ID, opts.input); server.tick(1 / 60); tick++; }
  // The client's body is born at its first snapshot pose
  // (`ensureRemoteShipBody` spawns from a real snapshot pose), so the first
  // reset carries no offset.
  client.setShipState(ID, server.getShipState(ID)!);
  deliver();

  const run: Run = { drawn: [], server: [] };
  for (let t = 1; t <= opts.ticks; t++) {
    server.applyInput(ID, opts.input);
    server.tick(1 / 60);
    tick++;
    run.server.push(server.getShipState(ID)!.angle);
    applyRemoteShipInputs(client, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard);
    client.tick(1 / 60);
    if (t % 3 === 0) deliver();
    let oa = 0;
    const off = offsets.get(ID);
    if (off) {
      if (!stepRemoteShipOffset(off, FRAME_MS)) offsets.delete(ID);
      oa = off.sa.x;
    }
    run.drawn.push(client.getShipState(ID)!.angle + (opts.noAngleSpring ? 0 : oa));
  }
  server.dispose();
  client.dispose();
  return run;
}

function maxStep(xs: number[]): number {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs(wrapPi(xs[i]! - xs[i - 1]!)));
  return m;
}

describe('remote ships — a steady turn renders smoothly (RTS Part A S1)', () => {
  const TURN: ShipInput = { thrust: true, turnLeft: true, turnRight: false, boost: false, reverse: false };
  let smooth: Run;
  let zeroNoSpring: Run;
  let zeroSpring: Run;

  beforeAll(async () => {
    await RAPIER.init();
    smooth = await fly({ ticks: 120, input: TURN, sendBits: true });
    // Contrast: the pre-4c reset (angvel 0, no bits), drawn raw. The test can see
    // stepping when it is there.
    zeroNoSpring = await fly({ ticks: 120, input: TURN, sendBits: false, zeroAngvel: true, noAngleSpring: true });
    // The same reset, its residual hidden by the angle spring.
    zeroSpring = await fly({ ticks: 120, input: TURN, sendBits: false, zeroAngvel: true });
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

  it('contrast: an angvel-0 reset with no bits, drawn raw, visibly steps', () => {
    expect(maxStep(zeroNoSpring.drawn)).toBeGreaterThan(maxStep(smooth.server) * 1.5);
  });

  it('the angle offset spring smooths that same reset residual', () => {
    expect(maxStep(zeroSpring.drawn)).toBeLessThan(maxStep(zeroNoSpring.drawn));
  });
});

describe('remote ships — forward prediction from the snapshot bits', () => {
  const THRUST: ShipInput = { thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false };

  beforeAll(async () => { await RAPIER.init(); });

  it('held bits keep forward-predicting; a snapshot without bits (idle) stops it', async () => {
    const world = await PhysicsWorld.create();
    world.spawnShip(ID, 0, 0, 'fighter');
    const ctx = makeCtx(world);
    const guard = createRemotePredictionGuard();
    let calls = 0;
    const counting = new Proxy(world, {
      get(target, prop, recv) {
        if (prop === 'applyInput') return (...a: Parameters<PhysicsWorld['applyInput']>) => { calls++; target.applyInput(...a); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
    const server = await PhysicsWorld.create();
    server.spawnShip(ID, 0, 0, 'fighter');
    preResetRemoteShips(snapshotOf(server, 1, { sendBits: true, input: THRUST }), 'me', ctx);
    applyRemoteShipInputs(counting, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard);
    expect(calls).toBe(1);
    // A second snapshot with the bits still held: still predicting.
    preResetRemoteShips(snapshotOf(server, 4, { sendBits: true, input: THRUST }), 'me', ctx);
    applyRemoteShipInputs(counting, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard);
    expect(calls).toBe(2);
    // Absent bits = idle: no forward input (and nothing stuck on).
    preResetRemoteShips(snapshotOf(server, 7, { sendBits: false, input: THRUST }), 'me', ctx);
    applyRemoteShipInputs(counting, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard);
    expect(calls).toBe(2);
    // The entry object is reused across snapshots (#14).
    const before = ctx.remoteLastInputs.get(ID);
    preResetRemoteShips(snapshotOf(server, 10, { sendBits: true, input: THRUST }), 'me', ctx);
    expect(ctx.remoteLastInputs.get(ID)).toBe(before);
    world.dispose();
    server.dispose();
  });

  it('forward prediction is bounded per snapshot (lookahead cap)', async () => {
    const world = await PhysicsWorld.create();
    world.spawnShip(ID, 0, 0, 'fighter');
    const ctx = makeCtx(world);
    const guard = createRemotePredictionGuard();
    let calls = 0;
    const counting = new Proxy(world, {
      get(target, prop, recv) {
        if (prop === 'applyInput') return (...a: Parameters<PhysicsWorld['applyInput']>) => { calls++; target.applyInput(...a); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
    preResetRemoteShips(snapshotOf(world, 1, { sendBits: true, input: THRUST }), 'me', ctx);
    for (let i = 0; i < 40; i++) { applyRemoteShipInputs(counting, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard); world.tick(1 / 60); }
    expect(calls).toBe(STAGE_3_MAX_LOOKAHEAD_TICKS);
    preResetRemoteShips(snapshotOf(world, 41, { sendBits: true, input: THRUST }), 'me', ctx); // next snapshot re-arms it
    applyRemoteShipInputs(counting, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard);
    expect(calls).toBe(STAGE_3_MAX_LOOKAHEAD_TICKS + 1);
    world.dispose();
  });

  it('a remote that leaves the snapshot is forgotten (no stale bits)', async () => {
    const world = await PhysicsWorld.create();
    world.spawnShip(ID, 0, 0, 'fighter');
    const ctx = makeCtx(world);
    preResetRemoteShips(snapshotOf(world, 1, { sendBits: true, input: THRUST }), 'me', ctx);
    expect(ctx.remoteLastInputs.has(ID)).toBe(true);
    preResetRemoteShips({ type: 'snapshot', serverTick: 2, states: {} } as unknown as SnapshotMessage, 'me', ctx);
    expect(ctx.remoteLastInputs.has(ID)).toBe(false);
    expect(ctx.remoteForwardTicks.has(ID)).toBe(false);
    world.dispose();
  });
});
