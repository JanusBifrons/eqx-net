/**
 * GPU-lit art: the frame's point lights from weapons fire and explosions —
 * lifted out of `PixiRenderer` (god-file split, Phase 4).
 *
 * `noteBlastLight(ctx, x, y, r)` is the explosions' spawn hook (a ring of 24
 * reused records); `feedLitScene(mirror, ctx)` adds this frame's lights to
 * `litPass.scene`. The ctx is built once by `createLitSceneCtx` (renderer
 * construction, so the explosions' hook can bind before `init`); `init` sets
 * `beamCtx`, and the caller writes `tractorViewCount` before each call.
 * Allocation-free per frame (invariant #14).
 */

import type { RenderMirror } from '@core/contracts/IRenderer';
import { NAVAL_SHELL_WEAPON_IDS } from '@core/combat/shellFlight';
import { litPass } from '../art/litPass.js';
import { addBeamLights, beamLightBudget } from '../beamStyles';
import type { BeamView } from '../BeamSpritePool';
import type { BeamCtx } from './beamUpdater.js';

export interface LitSceneCtx {
  fxNow: () => number;
  blastLights: Array<{ x: number; y: number; r: number; t0: number }>;
  blastLightNext: number;
  /** Set in `init` once the beam ctx is built. */
  beamCtx: BeamCtx | null;
  tractorViews: BeamView[];
  /** Written by the caller each frame. */
  tractorViewCount: number;
}

export interface LitSceneCtxRefs {
  fxNow: () => number;
  tractorViews: BeamView[];
}

/** Build the lit-scene ctx once (renderer construction). */
export function createLitSceneCtx(refs: LitSceneCtxRefs): LitSceneCtx {
  return { fxNow: refs.fxNow, blastLights: [], blastLightNext: 0, beamCtx: null, tractorViews: refs.tractorViews, tractorViewCount: 0 };
}

/** An explosion lights the hulls around it for ~0.9 s (sprite space). */
export function noteBlastLight(ctx: LitSceneCtx, x: number, y: number, r: number): void {
  if (!litPass.settings || litPass.settings.pointLights <= 0) return;
  const L = ctx.blastLights;
  if (L.length < 24) { L.push({ x, y, r, t0: ctx.fxNow() }); return; }
  const b = L[ctx.blastLightNext]!;
  ctx.blastLightNext = (ctx.blastLightNext + 1) % L.length;
  b.x = x; b.y = y; b.r = r; b.t0 = ctx.fxNow();
}

/**
 * GPU-lit art: add this frame's lights to the lighting pass (sprite space):
 * explosions (fading), projectiles in flight (naval shells by calibre),
 * missiles and beams. Muzzle flashes are lit by the guns themselves
 * (MountVisualManager, pinned to the flash sprite). Alloc-free.
 */
export function feedLitScene(mirror: RenderMirror, ctx: LitSceneCtx): void {
  const ls = litPass.settings;
  if (!ls || ls.pointLights <= 0) return;
  const sc = litPass.scene, now = ctx.fxNow();
  for (const b of ctx.blastLights) {
    const age = (now - b.t0) / 900;
    if (age < 0 || age >= 1) continue;
    const k = (1 - age) * (1 - age);
    sc.addLight(b.x, b.y, 25, 0xff8a30, 3 * k, b.r * 3 + 90);
  }
  if (mirror.projectiles) for (const p of mirror.projectiles.values()) {
    if (p.beam) continue;
    const w = p.weaponId ?? '';
    const K = w === 'naval_siege' ? 10 : w === 'naval_xxl' ? 7 : w === 'naval_xl' || w === 'railgun' ? 6 : w === 'naval_l' ? 4.5 : w === 'naval_m' ? 3 : w === 'naval_s' ? 2 : 1;
    // The railgun slug burns white-blue; powder shells and autocannon amber.
    const color = w === 'railgun' ? 0xcfe8ff : NAVAL_SHELL_WEAPON_IDS.has(w) || w === 'autocannon' ? 0xffc070 : 0x9fd8ff;
    const x = p.x, y = -p.y;
    sc.addLight(x, y, 5 * K, color, K > 1 ? 0.36 * K : 0.9, 55 * K);
  }
  if (mirror.missiles) for (const m of mirror.missiles.values()) sc.addLight(m.x, -m.y, 8, 0xffa060, 1.2, 70);
  const beamCtx = ctx.beamCtx!;
  for (let i = 0; i < beamCtx.liveBeamCacheCount; i++) beamLights(beamCtx.liveBeamCache[i]!);
  for (let i = 0; i < beamCtx.remoteBeamCacheCount; i++) beamLights(beamCtx.remoteBeamCache[i]!);
  for (let i = 0; i < ctx.tractorViewCount; i++) beamLights(ctx.tractorViews[i]!); // tractors glow blue where they hold
}

/** A beam lights where it hits and along its length. */
function beamLights(b: BeamView): void {
  // Game space in, Pixi space to the lit scene (beamStyles `addBeamLights`).
  addBeamLights(litPass.scene, b, beamLightBudget(litPass.settings?.pointLights ?? 0));
}
