/**
 * Capital follow jitter (owner, 2026-11-12, watching the refilmed
 * capital-guns-fighter take: "There's a bit of jittering going on I feel").
 *
 * The take: a heavy cruiser on the follow camera flies at a battleship. QA
 * measured ship wobble p99 0.99 px against 0.01 px on the other capital takes,
 * with 0 prediction corrections and the drawn poses smooth (local and the
 * battleship both < 0.06 px of residual a frame). What moved was the camera
 * SCALE: the speed zoom-out (C3) is eased from a raw per-frame speed, and the
 * renderer measured it as (camera centre change) / (renderer clock change).
 * The centre moves by the ship's drawn pose, which is resolved at the frame
 * time `mirror.frameTimeMs` (steady 16.7 ms steps), while the renderer clock
 * steps 15-31 ms; the camera centre is also a frame behind the pose at that
 * point of `update()`. So the raw speed swung ±15-60 % frame to frame and the
 * whole view "breathed" by ~0.3 % of its scale: ~2 px at the screen edge,
 * ~1 px at a capital's hull ends. Ships at rest (the other capital takes)
 * have no speed and no breathing.
 *
 * The fix measures the speed from the followed ship's drawn pose at its frame
 * time. This replays 6 s of the real take (wall clock, frame time, drawn
 * pose per frame) through the renderer's sampling seam and the real
 * `Backdrop`, the way `PixiRenderer.update` drives them.
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import { DEFAULT_RIG } from '../art/shade.js';
import { Backdrop } from '../art/fx/Backdrop.js';
import { newSpeedFxSample, speedFxSampleInto } from './speedFxSample.js';
import trace from './capitalFollowTrace.fixture.json';

const art = { fx: (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: DEFAULT_RIG, state: 'ready', ship: null, struct: null,
  fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } }), lightRig: DEFAULT_RIG } as unknown as ArtService;

/** heavy-cruiser maxSpeed at the shipping scale (what counts as full speed). */
const FULL_SPEED = 166;
/** A point this far from the screen centre: the edge of a 1280-px view. */
const EDGE_PX = 640;

/** Per-frame residual of a series against its 7-frame moving average (the
 *  showcase wobble gate's measure). */
function residuals(a: number[], h = 3): number[] {
  const out: number[] = [];
  for (let i = h; i < a.length - h; i++) {
    let s = 0;
    for (let j = i - h; j <= i + h; j++) s += a[j]!;
    out.push(Math.abs(a[i]! - s / (2 * h + 1)));
  }
  return out.sort((x, y) => x - y);
}

/** Replay the take: per frame, the followed sprite is at the drawn pose
 *  (Pixi space), the camera centre still at last frame's pose (follow is
 *  applied on the camera's next tick), the renderer clock at wallMs. */
function replaySpeedZoom(): number[] {
  const b = new Backdrop(art, () => 'high');
  b.setSector('emerald-span');
  const cam = { center: { x: 0, y: 0 }, scale: { x: 0.1 }, screenWidth: 1280, screenHeight: 720 };
  const sample = newSpeedFxSample();
  const sprite = { x: 0, y: 0 };
  const zooms: number[] = [];
  const rows = trace.rows as [number, number, number, number][];
  for (let i = 0; i < rows.length; i++) {
    const [wallMs, frameTimeMs, gx, gy] = rows[i]!;
    const prev = rows[Math.max(0, i - 1)]!;
    cam.center.x = prev[2]; cam.center.y = -prev[3];
    sprite.x = gx; sprite.y = -gy;
    speedFxSampleInto(sample, sprite, frameTimeMs, cam.center, wallMs);
    b.update(cam, wallMs, FULL_SPEED, sample);
    zooms.push(b.speedZoom());
  }
  return zooms;
}

describe('speed zoom while following a flying capital', () => {
  it('does not make the view breathe frame to frame', () => {
    const zooms = replaySpeedZoom();
    const r = residuals(zooms.slice(60)); // past the first second of easing in
    const p99Px = (r[Math.floor(r.length * 0.99)]! / zooms[zooms.length - 1]!) * EDGE_PX;
    expect(p99Px).toBeLessThan(0.3);
  });

  it('still zooms out with speed (the effect is kept)', () => {
    const zooms = replaySpeedZoom();
    // ~100 u/s of a 166 u/s top speed under the 'large' 0.2 zoom-out.
    expect(zooms[zooms.length - 1]!).toBeLessThan(0.92);
    expect(zooms[zooms.length - 1]!).toBeGreaterThan(0.85);
  });
});

describe('speedFxSampleInto', () => {
  it('uses the followed pose at its frame time', () => {
    const s = speedFxSampleInto(newSpeedFxSample(), { x: 5, y: -6 }, 1234, { x: 1, y: 2 }, 9999);
    expect(s).toEqual({ x: 5, y: -6, t: 1234, fromPose: true });
  });

  it('falls back to the camera centre at the renderer clock with nothing followed', () => {
    const s = speedFxSampleInto(newSpeedFxSample(), null, 1234, { x: 1, y: 2 }, 9999);
    expect(s).toEqual({ x: 1, y: 2, t: 9999, fromPose: false });
  });

  it('falls back to the camera centre when the mirror carries no frame time', () => {
    const s = speedFxSampleInto(newSpeedFxSample(), { x: 5, y: -6 }, undefined, { x: 1, y: 2 }, 9999);
    expect(s).toEqual({ x: 1, y: 2, t: 9999, fromPose: false });
  });
});
