/**
 * Base loop 3O — an unbuilt structure draws as a cyan hologram that a print
 * line fills in with its build fraction; a built one draws solid.
 */
import { describe, expect, it } from 'vitest';
import { Container, type Graphics } from 'pixi.js';
import { HOLOGRAM_LABEL, printLineX, StructureHologram, syncStructureHologram } from './structureHologram.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { POSE_RING_DEPTH, type PoseRingEntry, type RenderMirror, type StructureRenderState, type SwarmRenderState } from '../../../core/contracts/IRenderer.js';

function row(built: boolean, buildPct: number): StructureRenderState {
  return { powered: true, netPower: 0, connTo: [], built, buildPct, deconstructPct: 0 };
}
function holoOf(c: Container): StructureHologram | null {
  return c.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram | null;
}
function entry(shipKind: string): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: ring, ringHead: 0, radius: 36, kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}
function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(), sprites: new Map<string, Graphics>(), mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 }, remoteHitTargets: new Set<string>(), localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(), structureMountAngles: new Map<string, number[]>(), spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(), art: { art: null, handles: new Map(), sunAz: 0 }, slewDtSec: 100,
  };
}

describe('structure hologram', () => {
  it('an unbuilt structure draws as a hologram', () => {
    const ctx = makeCtx();
    const m = { swarm: new Map([[7, entry('solar')]]), structures: new Map([[7, row(false, 0)]]) } as unknown as RenderMirror;
    updateSwarmSprites(m, ctx);
    const sprite = ctx.sprites.get('swarm-7')!;
    const holo = holoOf(sprite)!;
    expect(holo).toBeInstanceOf(StructureHologram);
    // Nothing paid: all of it is hologram, no print line yet.
    expect(holo.ahead.visible).toBe(true);
    expect(holo.ahead.mask).toBe(holo.clip);
    expect(holo.line.visible).toBe(false);
    expect(holo.clip.x).toBeCloseTo(-holo.halfW, 6);
    // The hologram is the structure's footprint, and the solid art under it is not dimmed.
    expect(holo.halfW).toBe(getStructureKind('solar').footprint.w / 2);
    expect(sprite.alpha).toBe(1);
  });

  it('progress 0.5 shows the print line at the middle', () => {
    const sprite = new Container();
    expect(syncStructureHologram(sprite, 'solar', 36, undefined, row(false, 0.5), 1000)).toBe(true);
    const holo = holoOf(sprite)!;
    expect(holo.line.visible).toBe(true);
    expect(holo.line.x).toBeCloseTo(0, 6);
    // The mask (hologram region) starts at the line and runs to the right edge.
    expect(holo.clip.x).toBeCloseTo(0, 6);
    expect(holo.clip.scale.x).toBeGreaterThan(holo.halfW);
    expect(printLineX(50, 0)).toBe(-50);
    expect(printLineX(50, 0.5)).toBe(0);
    expect(printLineX(50, 1)).toBe(50);
  });

  it('the print line ramps between server steps without re-anchoring', () => {
    const sprite = new Container();
    const st = { ...row(false, 0.5), etaMs: 1000 };
    syncStructureHologram(sprite, 'solar', 36, undefined, st, 1000);
    const holo = holoOf(sprite)!;
    syncStructureHologram(sprite, 'solar', 36, undefined, st, 1500);
    expect(holo.shownPct).toBeCloseTo(0.75, 6);
    expect(holoOf(sprite)).toBe(holo); // built once, reused
  });

  it('a built structure draws solid', () => {
    const ctx = makeCtx();
    const structures = new Map([[7, row(false, 0.9)]]);
    const m = { swarm: new Map([[7, entry('solar')]]), structures } as unknown as RenderMirror;
    updateSwarmSprites(m, ctx);
    expect(holoOf(ctx.sprites.get('swarm-7')!)).not.toBeNull();
    structures.set(7, row(true, 1));
    updateSwarmSprites(m, ctx);
    const sprite = ctx.sprites.get('swarm-7')!;
    expect(holoOf(sprite)).toBeNull();
    expect(sprite.alpha).toBe(1);
  });
});
