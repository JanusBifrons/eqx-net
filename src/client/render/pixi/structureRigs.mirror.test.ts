/**
 * Build mirror (base loop 4C) on the rigs, through the real sprite updater:
 * - the crane's drawn clamp lands on the real ship when the server sends its
 *   target in the mirror-undone host frame (`worldToRigHost` →
 *   `structureWorldToLocal`) and the sprite draws flipped: no double flip;
 * - a mirrored solar's panels still face the sun.
 */
import { describe, it, expect } from 'vitest';
import { Container, Point } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { StructureRigs } from './structureRigs.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { DOCK_CRANE_REACH_TICKS } from '../../../core/articulation/rigCatalogue.js';
import { structureWorldToLocal } from '../../../shared-types/structureKinds/geometry.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function entry(shipKind: string, x: number, y: number, angle: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0, prevX: x, prevY: y, prevAngle: angle,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: emptyPoseRing(), ringHead: 0,
    radius: 36, kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}

function makeCtx(): SwarmSpriteCtx & { structureRigs: StructureRigs } {
  const shipContainer = new Container();
  return {
    shipContainer,
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
    slewDtSec: 100,
    structureRigs: new StructureRigs(shipContainer),
  };
}

/** Every rig part Graphics labelled `rig-<id>` under the view's groups. */
function partByLabel(rigs: StructureRigs, key: string, id: string): Container {
  const view = rigs.viewFor(key)!;
  const i = view.rig.parts.findIndex((p) => p.id === id);
  return view.parts[i]!;
}

const HX = 300, HY = -140, HA = 0.7;

function craneClampWorld(mirror: boolean): { x: number; y: number } {
  const ctx = makeCtx();
  // The ship the crane grips, in world game space.
  const sx = HX + 40, sy = HY + 380;
  // The server's clip target: the ship in the host frame, mirror undone.
  const t = structureWorldToLocal(sx, sy, HX, HY, Math.cos(HA), Math.sin(HA), mirror, { x: 0, y: 0 });
  const swarm = new Map<number, SwarmRenderState>([[7, entry('freight_dock', HX, HY, HA)]]);
  const row: StructureRenderState = {
    powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, mirror,
    rigClip: { clipId: 'arm-reach', startTick: 0, targetX: t.x, targetY: t.y },
  };
  const m = { swarm, structures: new Map([[7, row]]), rigTick: DOCK_CRANE_REACH_TICKS + 30 } as unknown as RenderMirror;
  ctx.structureRigs.begin();
  updateSwarmSprites(m, ctx);
  const clamp = partByLabel(ctx.structureRigs, 'swarm-7', 'clamp');
  const p = clamp.toGlobal(new Point(0, 0));
  // Pixi y-down → game y-up; distance to the ship.
  return { x: p.x - sx, y: -p.y - sy };
}

describe('build mirror: crane grip lands on the real ship (4C)', () => {
  it('unmirrored control: the drawn clamp is on the ship', () => {
    const d = craneClampWorld(false);
    expect(Math.hypot(d.x, d.y)).toBeLessThan(1);
  });

  it('mirrored: the drawn clamp is still on the ship (no double flip)', () => {
    const d = craneClampWorld(true);
    expect(Math.hypot(d.x, d.y)).toBeLessThan(1);
  });
});

describe('build mirror: sun-facing parts (4C)', () => {
  function panelFacing(mirror: boolean, sunAz: number): number {
    const ctx = makeCtx();
    const swarm = new Map<number, SwarmRenderState>([[7, entry('solar', 0, 0, 0.4)]]);
    const row: StructureRenderState = { powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, mirror };
    const m = { swarm, structures: new Map([[7, row]]), rigTick: 100 } as unknown as RenderMirror;
    ctx.structureRigs.begin();
    updateSwarmSprites(m, ctx);
    const view = ctx.structureRigs.viewFor('swarm-7')!;
    // The updater feeds the sun only with Machined art on; pose the built
    // view again with the sun, as the updater does each frame.
    view.update(null, 100, 0, 0, 0.4, 1, sunAz);
    const i = view.rig.aims.indexOf(1);
    expect(i).toBeGreaterThanOrEqual(0);
    const g = view.parts[i]!;
    const o = g.toGlobal(new Point(0, 0));
    const x = g.toGlobal(new Point(1, 0));
    return Math.atan2(x.y - o.y, x.x - o.x); // Pixi-space direction of the part's +x
  }

  function angDiff(a: number, b: number): number {
    const d = a - b;
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  }

  it('unmirrored and mirrored panels point the same way, at the sun', () => {
    for (const az of [0.3, 1.9, -2.4]) {
      const plain = panelFacing(false, az);
      const flipped = panelFacing(true, az);
      expect(angDiff(flipped, plain)).toBeLessThan(1e-6);
      expect(angDiff(plain, az)).toBeLessThan(1e-6);
    }
  });
});
