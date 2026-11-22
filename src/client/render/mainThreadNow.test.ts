/**
 * Render-worker clock audit (netcode gap smoothing S5-W2). On desktop the
 * renderer is a worker whose `performance.now()` counts from its own, later
 * `timeOrigin`. Pose-ring arrivals and remote-laser `expiresAt` are stamped on
 * the main thread, so every consumer that compared them against the worker's
 * clock read the wrong point in time. Each consumer now reads
 * `mirror.frameTimeMs` (the main thread's frame time) through
 * `mainThreadNowMs`. Each case drives the renderer clock 5000 ms behind the
 * main thread, which the old code got wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Container } from 'pixi.js';
import type { RenderMirror, ShipRenderState, SwarmRenderState, PoseRingEntry } from '../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import { interpolateSwarmPose, resetSwarmDisplayDelay, resetSwarmTickClock } from '../net/swarmInterpolation.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { mainThreadNowMs } from './mainThreadNow.js';
import { resolveSelectable, type SelectableTarget } from './SelectionBracket.js';
import { HealthBarManager } from './HealthBars.js';
import { updateBeams, updateTractorBeams, createBeamCtx, type BeamCtxRefs } from './pixi/beamUpdater.js';
import type { BeamSpritePool, BeamView } from './BeamSpritePool.js';

/** How far the worker's clock lags the window's (worker started later). */
const WORKER_CLOCK_OFFSET_MS = 5000;
const FIRST_ARRIVAL_MS = 10_000;
const ARRIVAL_STEP_MS = 50;
const SAMPLES = 8;
const STEP_X = 100;
/** Main-thread frame time: a little behind the newest arrival plus the delay,
 *  so the read lands mid-ring (the moving piece's present pose). */
const MAIN_NOW_MS = FIRST_ARRIVAL_MS + (SAMPLES - 3) * ARRIVAL_STEP_MS;
const WORKER_NOW_MS = MAIN_NOW_MS - WORKER_CLOCK_OFFSET_MS;
const SWARM_ID = 7;

/** A drifting, awake swarm piece: main-thread arrivals 50 ms apart, x rising. */
function movingPiece(kind: number): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    const live = i < SAMPLES;
    ring.push({
      empty: !live, x: live ? i * STEP_X : 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0,
      arrivalMs: live ? FIRST_ARRIVAL_MS + i * ARRIVAL_STEP_MS : 0,
    });
  }
  const last = (SAMPLES - 1) * STEP_X;
  return {
    x: last, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: last, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: ring, ringHead: SAMPLES % POSE_RING_DEPTH,
    radius: 20, kind, sleeping: false, lastUpdateTick: 0,
  } as SwarmRenderState;
}

function mirrorWith(entry: SwarmRenderState): RenderMirror {
  return {
    ships: new Map<string, ShipRenderState>(),
    swarm: new Map([[SWARM_ID, entry]]),
    localPlayerId: null,
    frameTimeMs: MAIN_NOW_MS,
  } as RenderMirror;
}

/** The pose the main thread itself would draw this frame. */
function mainThreadX(entry: SwarmRenderState): number {
  return interpolateSwarmPose(entry, MAIN_NOW_MS, { x: 0, y: 0, angle: 0 }).x;
}

beforeEach(() => {
  resetSwarmTickClock();
  resetSwarmDisplayDelay();
});

describe('mainThreadNowMs', () => {
  it('reads the mirror frame time, else the renderer clock', () => {
    expect(mainThreadNowMs({ frameTimeMs: MAIN_NOW_MS }, WORKER_NOW_MS)).toBe(MAIN_NOW_MS);
    expect(mainThreadNowMs({}, WORKER_NOW_MS)).toBe(WORKER_NOW_MS);
    expect(mainThreadNowMs({ frameTimeMs: Number.NaN }, WORKER_NOW_MS)).toBe(WORKER_NOW_MS);
  });

  it('the fixture separates the clocks (the worker read pins to the oldest pose)', () => {
    const entry = movingPiece(3);
    const workerX = interpolateSwarmPose(entry, WORKER_NOW_MS, { x: 0, y: 0, angle: 0 }).x;
    expect(workerX).toBe(0);
    expect(mainThreadX(entry)).toBeGreaterThan(STEP_X);
  });
});

describe('worker-clock offset does not move pose-ring reads', () => {
  afterEach(() => vi.restoreAllMocks());

  it('SelectionBracket frames a drifting scrap piece where it is drawn', () => {
    vi.spyOn(performance, 'now').mockReturnValue(WORKER_NOW_MS);
    const entry = movingPiece(3);
    const out: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };
    expect(resolveSelectable(mirrorWith(entry), `swarm-${SWARM_ID}`, out)).toBe(true);
    expect(out.x).toBeCloseTo(mainThreadX(entry), 6);
  });

  it('HealthBars place a drifting rock bar where the rock is drawn', () => {
    vi.spyOn(performance, 'now').mockReturnValue(WORKER_NOW_MS);
    const entry = movingPiece(0);
    const mgr = new HealthBarManager(new Container());
    mgr.onHit(`swarm-${SWARM_ID}`, 0.5);
    mgr.update(mirrorWith(entry));
    const bar = (mgr as unknown as { bars: Map<string, { gfx: Container }> }).bars.get(`swarm-${SWARM_ID}`)!;
    expect(bar.gfx.x).toBeCloseTo(mainThreadX(entry), 6);
  });

  it('a tractor beam ends on the drifting piece it holds', () => {
    const kind = getShipKind('interceptor');
    const entry = movingPiece(3);
    const mirror = mirrorWith(entry);
    mirror.ships.set('me', { x: 0, y: -500, angle: 0, vx: 0, vy: 0, kind: 'interceptor' } as ShipRenderState);
    mirror.tractorLinks = [{ emitter: 'me', mountId: kind.mounts![0]!.id, target: SWARM_ID }];
    const pool = { setBeams: vi.fn() } as unknown as BeamSpritePool;
    const views: BeamView[] = [];
    expect(updateTractorBeams(mirror, pool, views, false, () => WORKER_NOW_MS, 1)).toBe(1);
    expect(views[0]!.toX).toBeCloseTo(mainThreadX(entry), 6);
  });
});

describe('worker-clock offset does not hold remote lasers at full brightness', () => {
  it('a laser 75 ms from expiry is half faded', () => {
    const kind = getShipKind('interceptor');
    const mountId = kind.mounts![0]!.id;
    const pool = { setBeams: vi.fn(), hideAll: vi.fn(), liveCount: 0 } as unknown as BeamSpritePool;
    const refs = {
      beamsDisabled: false,
      fxNow: () => WORKER_NOW_MS,
      remoteBeamPool: pool,
      remoteBeamGfx: new Container(),
      miningBeamPool: null,
      miningBeamGfx: null,
      liveBeamPool: null,
      liveBeamGfx: null,
      fxRemoteBeams: null,
      fxLiveBeams: null,
      fxShields: null,
      fxFences: null,
      fxShieldPose: () => null,
      swarmPoseScratch: { x: 0, y: 0, angle: 0 },
      feedback: {},
    } as unknown as BeamCtxRefs;
    const ctx = createBeamCtx(refs);
    const mirror: RenderMirror = {
      ships: new Map([['p', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'interceptor' } as ShipRenderState]]),
      localPlayerId: null,
      frameTimeMs: MAIN_NOW_MS,
      remoteLasers: new Map([['p', new Map([[mountId, {
        range: 400, hit: false, expiresAt: MAIN_NOW_MS + 75, fromX: 0, fromY: 0, toX: 0, toY: 400,
      }]])]]),
    };
    updateBeams(mirror, ctx);
    expect(ctx.remoteBeamCacheCount).toBe(1);
    expect(ctx.remoteBeamCache[0]!.alpha).toBeCloseTo(0.5, 6);
  });
});
