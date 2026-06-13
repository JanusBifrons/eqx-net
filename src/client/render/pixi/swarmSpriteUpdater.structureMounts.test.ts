/**
 * Structure mount-visual regression lock (structures follow-up Item A,
 * plan: i-want-you-to-majestic-pie; Invariant #13 — failing test FIRST).
 *
 * On-device smoke (2026-06-07): a Turret renders as ONLY its base polygon
 * (the "triangle") — no barrel, no aim. Root cause: `swarmSpriteUpdater`
 * gated the mount-visual code behind `if (entry.kind === 1 && entry.shipKind)`
 * (drones only), so structures (kind===2) — which DO carry a `mounts` entry
 * in `structureKinds.ts` (TURRET 'barrel', MINER 'drill') — never got a
 * barrel sprite. Structures carry NO `mountAngles` on any wire; the snapshot
 * `structures[]` slice ships only `turretTargetId` / `miningTargetId`, so the
 * barrel angle must be DERIVED client-side from the target id + the target
 * entity's pose.
 *
 * This test reads the REAL drawn artifact (the `MountVisualManager` barrel
 * cluster + its sprite rotation), NOT a recompute (feedback-test-observable
 * lesson). It asserts, for BOTH a turret (turretTargetId) and a miner
 * (miningTargetId):
 *   1. the structure sprite gained exactly ONE barrel (mountCountForShip === 1)
 *   2. the barrel sprite rotation is non-zero AND points AT the target
 *      (validated against the SAME `applyMountAngles` Y-flip convention).
 *
 * Before the fix this FAILS at `mountCountForShip === 1` (count is 0 — no
 * kind===2 branch ever builds the cluster).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type {
  RenderMirror,
  SwarmRenderState,
  StructureRenderState,
  PoseRingEntry,
} from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { wrapPi } from '../../../core/ai/WeaponMountController.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  }
  return ring;
}

/** A static structure swarm entry posed exactly at (x,y,angle). `sleeping:true`
 *  makes `interpolateSwarmPose` pin to entry.x/y/angle (no ring math), so the
 *  rendered sprite lands at the deterministic structure pose. */
function structureEntry(
  shipKind: string,
  x: number,
  y: number,
  angle: number,
): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0,
    prevX: x, prevY: y, prevAngle: angle,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 36, kind: 2, shipKind,
    sleeping: true, lastUpdateTick: 0,
  };
}

/** A drone target entry (kind===1) the structure mount should aim at. */
function droneEntry(x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 12, kind: 1, shipKind: 'fighter',
    sleeping: true, lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState>): StructureRenderState {
  return {
    powered: true, netPower: 10, connTo: [], built: true,
    buildPct: 1, deconstructPct: 0, ...over,
  };
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
    // P3.8 — a LARGE default dt so a single updateSwarmSprites call slews all the
    // way to the target (the dead-ahead aim tests below assert the converged
    // angle); the dedicated slew test overrides this with a small per-frame dt.
    slewDtSec: 100,
  };
}

/** The barrel sprite rotation the renderer SHOULD draw for a structure mount
 *  aiming at `target`, derived independently from the production code via the
 *  canonical server convention (WeaponMountTicker) + the applyMountAngles
 *  Y-flip. The structure mount sits at the body centre (localX=localY=0,
 *  baseAngle=0). */
function expectedBarrelRotation(
  bodyX: number,
  bodyY: number,
  bodyAngle: number,
  baseAngle: number,
  targetX: number,
  targetY: number,
): number {
  const dx = targetX - bodyX;
  const dy = targetY - bodyY;
  const worldBearing = Math.atan2(-dx, dy);
  const arcLocal = wrapPi(worldBearing - bodyAngle - baseAngle);
  // applyMountAngles: spriteRotation = -(baseAngle + current)
  return -(baseAngle + arcLocal);
}

describe('updateSwarmSprites — structure mount visuals (kind===2)', () => {
  let ctx: SwarmSpriteCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('builds a barrel for a TURRET and aims it at turretTargetId', () => {
    const turretId = 100;
    const droneId = 200;
    // Turret at origin facing forward; target drone straight ahead (+y world).
    const turret = structureEntry('turret', 0, 0, 0);
    const target = droneEntry(0, 350);
    const swarm = new Map<number, SwarmRenderState>([
      [turretId, turret],
      [droneId, target],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [turretId, structureState({ turretTargetId: droneId })],
    ]);
    const mirror: RenderMirror = { swarm, structures } as unknown as RenderMirror;

    updateSwarmSprites(mirror, ctx);

    const key = `swarm-${turretId}`;
    // (1) the barrel cluster exists — exactly one mount on the turret.
    expect(ctx.mountVisuals.mountCountForShip(key)).toBe(1);

    // (2) the barrel rotation aims at the target (non-zero + correct sign).
    const sk = getStructureKind('turret');
    const mount = sk.mounts![0]!;
    const cluster = (ctx.mountVisuals as unknown as {
      clusters: Map<string, { perMount: Map<string, { turret: Graphics }> }>;
    }).clusters.get(key)!;
    const barrel = cluster.perMount.get(mount.id)!.turret;
    const expected = expectedBarrelRotation(0, 0, 0, mount.baseAngle, 0, 350);
    expect(barrel.rotation).toBeCloseTo(expected, 5);
    // Target dead ahead (+y, ship-forward) → barrel stays at 0 (forward).
    // Use an off-axis target to prove the aim actually rotates the barrel.
  });

  it('SLEWS a TURRET barrel toward an off-axis target — eases, does NOT snap (P3.8)', () => {
    // P3.8 regression lock: a structure barrel must SLEW toward its target over
    // frames (rotateMountToward), NOT jump to it in one frame. The pre-fix code
    // snapped — a blueprint turret/miner sat at base ("up") and the instant it
    // acquired a target the barrel jumped to the bearing ("places at a weird
    // angle then snaps"). This drives a 90° off-axis target and asserts a single
    // frame moves only PART of the way, then converges over many frames.
    const turretId = 101;
    const droneId = 201;
    const turret = structureEntry('turret', 0, 0, 0);
    // Target to the turret's RIGHT (+x). Forward is +y → a +x target is 90° off.
    const target = droneEntry(400, 0);
    const swarm = new Map<number, SwarmRenderState>([
      [turretId, turret],
      [droneId, target],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [turretId, structureState({ turretTargetId: droneId })],
    ]);
    const mirror: RenderMirror = { swarm, structures } as unknown as RenderMirror;

    const sk = getStructureKind('turret');
    const mount = sk.mounts![0]!;
    const aimed = expectedBarrelRotation(0, 0, 0, mount.baseAngle, 400, 0);
    expect(Math.abs(aimed)).toBeGreaterThan(1); // sanity: target really is ~90° off

    const key = `swarm-${turretId}`;
    const barrelOf = (): Graphics =>
      (ctx.mountVisuals as unknown as {
        clusters: Map<string, { perMount: Map<string, { turret: Graphics }> }>;
      }).clusters.get(key)!.perMount.get(mount.id)!.turret;

    // ONE 60 Hz frame: the barrel has moved OFF base toward the target, but is
    // NOWHERE near it yet (a snap would land exactly on `aimed` in one frame —
    // this assertion FAILS on the pre-fix snap behaviour).
    ctx.slewDtSec = 1 / 60;
    updateSwarmSprites(mirror, ctx);
    expect(ctx.mountVisuals.mountCountForShip(key)).toBe(1);
    const afterOne = barrelOf().rotation;
    expect(Math.abs(afterOne), 'barrel moved off base (forward = 0)').toBeGreaterThan(0);
    expect(Math.abs(afterOne - aimed), 'barrel must NOT snap to the target in one frame').toBeGreaterThan(0.2);
    expect(Math.sign(afterOne), 'slewed TOWARD the target, not away').toBe(Math.sign(aimed));

    // Over many frames it converges to the full aim.
    for (let f = 0; f < 300; f++) updateSwarmSprites(mirror, ctx);
    expect(barrelOf().rotation).toBeCloseTo(aimed, 3);
  });

  it('builds a barrel for a MINER and aims it at miningTargetId', () => {
    const minerId = 102;
    const asteroidId = 202;
    const miner = structureEntry('miner', 100, 100, 0);
    // Asteroid (mining target) off to one side.
    const target = droneEntry(100, 900);
    target.kind = 0; // mining target is an asteroid (kind 0); resolution is by id.
    const swarm = new Map<number, SwarmRenderState>([
      [minerId, miner],
      [asteroidId, target],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [minerId, structureState({ miningTargetId: asteroidId })],
    ]);
    const mirror: RenderMirror = { swarm, structures } as unknown as RenderMirror;

    updateSwarmSprites(mirror, ctx);

    const key = `swarm-${minerId}`;
    expect(ctx.mountVisuals.mountCountForShip(key)).toBe(1);

    const sk = getStructureKind('miner');
    const mount = sk.mounts![0]!;
    const cluster = (ctx.mountVisuals as unknown as {
      clusters: Map<string, { perMount: Map<string, { turret: Graphics }> }>;
    }).clusters.get(key)!;
    const barrel = cluster.perMount.get(mount.id)!.turret;
    const expected = expectedBarrelRotation(100, 100, 0, mount.baseAngle, 100, 900);
    expect(barrel.rotation).toBeCloseTo(expected, 5);
  });

  it('attaches a mining-range ring to a MINER sprite, but not to a TURRET (WS-4 Phase 5 / R2.16)', () => {
    const minerId = 104;
    const turretId = 105;
    const miner = structureEntry('miner', 0, 0, 0);
    const turret = structureEntry('turret', 500, 0, 0);
    const swarm = new Map<number, SwarmRenderState>([
      [minerId, miner],
      [turretId, turret],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [minerId, structureState({})],
      [turretId, structureState({})],
    ]);
    const mirror: RenderMirror = { swarm, structures } as unknown as RenderMirror;

    updateSwarmSprites(mirror, ctx);

    // The miner sprite carries exactly one ring child (label-tagged), built
    // once in the sprite-create path — the real drawn artifact, not a recompute.
    const minerSprite = ctx.sprites.get(`swarm-${minerId}`)!;
    const rings = minerSprite.children.filter((c) => c.label === 'minerRangeRing');
    expect(rings.length).toBe(1);

    // The turret has no miningRange → no ring.
    const turretSprite = ctx.sprites.get(`swarm-${turretId}`)!;
    expect(turretSprite.children.filter((c) => c.label === 'minerRangeRing').length).toBe(0);
  });

  it('builds the miner ring exactly ONCE across many frames (invariant #14 — not per-frame)', () => {
    const minerId = 106;
    const miner = structureEntry('miner', 0, 0, 0);
    const swarm = new Map<number, SwarmRenderState>([[minerId, miner]]);
    const structures = new Map<number, StructureRenderState>([[minerId, structureState({})]]);
    const mirror: RenderMirror = { swarm, structures } as unknown as RenderMirror;

    for (let f = 0; f < 5; f++) updateSwarmSprites(mirror, ctx);

    const minerSprite = ctx.sprites.get(`swarm-${minerId}`)!;
    expect(minerSprite.children.filter((c) => c.label === 'minerRangeRing').length).toBe(1);
  });

  it('leaves the barrel at base when the structure has no target', () => {
    const turretId = 103;
    const turret = structureEntry('turret', 0, 0, 0);
    const swarm = new Map<number, SwarmRenderState>([[turretId, turret]]);
    const structures = new Map<number, StructureRenderState>([
      [turretId, structureState({})], // no turretTargetId / miningTargetId
    ]);
    const mirror: RenderMirror = { swarm, structures } as unknown as RenderMirror;

    updateSwarmSprites(mirror, ctx);

    const key = `swarm-${turretId}`;
    expect(ctx.mountVisuals.mountCountForShip(key)).toBe(1);
    const sk = getStructureKind('turret');
    const mount = sk.mounts![0]!;
    const cluster = (ctx.mountVisuals as unknown as {
      clusters: Map<string, { perMount: Map<string, { turret: Graphics }> }>;
    }).clusters.get(key)!;
    const barrel = cluster.perMount.get(mount.id)!.turret;
    // No target → barrel at base angle (0 for the structure mounts).
    expect(barrel.rotation).toBeCloseTo(-mount.baseAngle, 5);
  });
});
