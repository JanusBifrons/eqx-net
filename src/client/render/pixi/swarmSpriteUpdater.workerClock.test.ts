/**
 * Asteroid / structure sprites interpolate their pose ring on the MAIN-THREAD
 * clock (netcode gap smoothing S5-W2). Ring arrivals are main-thread stamps;
 * on desktop the renderer is a worker whose `performance.now()` counts from
 * its own, later `timeOrigin`, so reading the ring at that clock drew an awake
 * (drifting) rock at the oldest pose in its ring, behind its collision body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A GL program needs a canvas; node has none.
vi.mock('../field/fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockBatchProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { interpolateSwarmPose, resetSwarmDisplayDelay, resetSwarmTickClock } from '../../net/swarmInterpolation.js';

/** How far the worker's clock lags the window's (worker started later). */
const WORKER_CLOCK_OFFSET_MS = 5000;
const FIRST_ARRIVAL_MS = 10_000;
const ARRIVAL_STEP_MS = 50;
const SAMPLES = 8;
const STEP_X = 100;
const MAIN_NOW_MS = FIRST_ARRIVAL_MS + (SAMPLES - 3) * ARRIVAL_STEP_MS;

/** An awake, drifting rock: main-thread arrivals 50 ms apart, x rising. */
function driftingRock(): SwarmRenderState {
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
    radius: 40, kind: 0, sleeping: false, lastUpdateTick: 0,
  } as SwarmRenderState;
}

function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(),
    sprites: new Map<string, Graphics>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    art: { art: null, handles: new Map(), sunAz: 0 },
    slewDtSec: 1 / 60,
  };
}

describe('updateSwarmSprites — worker clock offset', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    resetSwarmDisplayDelay();
  });
  afterEach(() => vi.restoreAllMocks());

  it('draws an awake rock at the main-thread pose, not the oldest ring sample', () => {
    vi.spyOn(performance, 'now').mockReturnValue(MAIN_NOW_MS - WORKER_CLOCK_OFFSET_MS);
    const rock = driftingRock();
    const expectedX = interpolateSwarmPose(rock, MAIN_NOW_MS, { x: 0, y: 0, angle: 0 }).x;
    expect(expectedX).toBeGreaterThan(STEP_X); // the fixture is mid-ring, not pinned
    const mirror = { swarm: new Map([[1, rock]]), frameTimeMs: MAIN_NOW_MS } as unknown as RenderMirror;
    const ctx = makeCtx();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.get('swarm-1')!.x).toBeCloseTo(expectedX, 6);
  });
});
