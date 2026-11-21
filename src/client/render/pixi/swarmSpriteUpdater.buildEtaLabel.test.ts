/**
 * Build-ETA label legibility (invariant #13 — failing test first).
 *
 * Seen live on a sideways Pixel 7 (base-build-test): the ETA countdown above a
 * blueprint's build bar was ~6 CSS px tall — a 12 px WORLD-space font drawn at
 * the default 0.5 camera zoom. Like the other in-world readouts the player must
 * read (damage numbers, lock tags) it is now counter-scaled to a constant
 * on-screen size. This reads the REAL drawn Text the updater owns.
 */
import { describe, it, expect } from 'vitest';
import { Container, Text } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type { RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function blueprintEntry(): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: emptyPoseRing(), ringHead: 0,
    radius: 60, kind: 2, shipKind: 'solar', sleeping: true, lastUpdateTick: 0,
  };
}

function makeCtx(cameraScale: number): SwarmSpriteCtx {
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
    slewDtSec: 0.016,
    cameraScale,
  };
}

/** On-screen (CSS px) font height of the ETA label after one update at `cameraScale`. */
function etaScreenPx(
  cameraScale: number,
  row: Partial<StructureRenderState> = { buildPct: 0.1, etaMs: 7000 },
): { px: number; text: string } {
  const ctx = makeCtx(cameraScale);
  const swarm = new Map<number, SwarmRenderState>([[7, blueprintEntry()]]);
  const structures = new Map<number, StructureRenderState>([[7, {
    powered: false, netPower: 0, connTo: [], built: false, buildPct: 0.1, deconstructPct: 0, ...row,
  }]]);
  updateSwarmSprites({ swarm, structures } as unknown as RenderMirror, ctx);
  for (const sprite of ctx.sprites.values()) {
    const t = sprite.getChildByLabel('buildEta') as Text | null;
    if (!t) continue;
    const fontPx = t.style.fontSize as number;
    return { px: fontPx * Math.abs(t.scale.y) * Math.abs(sprite.scale.y) * cameraScale, text: t.text };
  }
  throw new Error('no buildEta label drawn');
}

describe('updateSwarmSprites — build-ETA label is readable on a phone', () => {
  it('shows the countdown text', () => {
    expect(etaScreenPx(0.5).text).toBe('7s');
  });

  it('draws at the in-world readout size (13 CSS px) at the default zoom', () => {
    expect(etaScreenPx(0.5).px).toBeCloseTo(13, 3);
  });

  it('keeps that size at any zoom (screen-constant, like damage numbers)', () => {
    expect(etaScreenPx(0.25).px).toBeCloseTo(13, 3);
    expect(etaScreenPx(1.2).px).toBeCloseTo(13, 3);
  });

  // Seen while filming: a Refinery placed over the player's parked fighter hit
  // 100% and the label went blank — it waits for the ship to move (server
  // blueprintBody.ts) with nothing on screen saying so.
  it('a finished blueprint still waiting to turn solid says it is waiting for ships to clear', () => {
    const got = etaScreenPx(0.5, { buildPct: 1, etaMs: 0, ghostBody: true });
    expect(got.text).toBe('WAITING FOR SHIPS TO CLEAR');
    expect(got.px).toBeCloseTo(13, 3);
  });
});
