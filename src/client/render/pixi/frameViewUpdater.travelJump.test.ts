/**
 * Teleport landing frame (#13 — failing test first).
 *
 * Film 2026-11-26 take 18 (Ancients' gate, Sol Prime → Vega Reach): on the
 * one frame the ship landed on the far gate, the gate, grid and hull vanished
 * and the sky jumped. The camera only follows the ship in the Pixi ticker,
 * AFTER `update()`, so that frame's culling, sprites, grid and sky were all
 * worked out for the old (now empty) held spot. A travel jump moves the
 * camera by the same amount BEFORE any frame pass reads it.
 */
import { describe, it, expect } from 'vitest';
import { Camera, type CameraTarget } from '../worker/Camera.js';
import { carryCameraAcrossJump, type JumpCarryCtx } from './frameViewUpdater.js';
import type { RenderMirror } from '@core/contracts/IRenderer';

function setup(): { cam: Camera; ctx: JumpCarryCtx; mirror: RenderMirror; r: { spectator: boolean; scripted: boolean } } {
  const target: CameraTarget = { x: 0, y: 0, scale: { x: 0.5, y: 0.5, set(s: number) { this.x = s; this.y = s; } } };
  const cam = new Camera(target, { minScale: 0.05, maxScale: 3 });
  cam.setScreenSize(1000, 500);
  cam.moveCenter(100, -200); // pixi space: game (100, 200)
  const r = { spectator: false, scripted: false };
  const ctx: JumpCarryCtx = {
    r: { camera: cam, get spectator() { return r.spectator; }, cameraDirector: { isCameraScripted: () => r.scripted } },
    lastJumpX: 0, lastJumpY: 0, jumpCentre: { x: 0, y: 0 },
  };
  return { cam, ctx, mirror: {} as RenderMirror, r };
}

const centre = (cam: Camera) => cam.centerInto({ x: 0, y: 0 });

describe('carryCameraAcrossJump', () => {
  it('moves the camera by a new jump at once (game y up, pixi y down)', () => {
    const { cam, ctx, mirror } = setup();
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x).toBeCloseTo(100);
    mirror.travelJumpX = 5000;
    mirror.travelJumpY = 3000;
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x).toBeCloseTo(5100);
    expect(centre(cam).y).toBeCloseTo(-3200);
    // The same total next frame: no further move.
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x).toBeCloseTo(5100);
    // A second jump adds only its own delta.
    mirror.travelJumpX = 4000;
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x).toBeCloseTo(4100);
  });

  it('leaves a free (spectator) or scripted camera alone, but still notes the jump', () => {
    const { cam, ctx, mirror, r } = setup();
    r.spectator = true;
    mirror.travelJumpX = 5000;
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x).toBeCloseTo(100);
    r.spectator = false;
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x, 'not applied late').toBeCloseTo(100);
    r.scripted = true;
    mirror.travelJumpX = 6000;
    carryCameraAcrossJump(mirror, ctx);
    expect(centre(cam).x).toBeCloseTo(100);
  });
});
