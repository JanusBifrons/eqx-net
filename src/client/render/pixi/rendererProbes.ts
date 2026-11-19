/**
 * Test / perf probes of the Pixi renderer — lifted out of `PixiRenderer`
 * (god-file split, Phase 4). Read only by DEV hooks, e2e specs and the perf
 * harness, never by gameplay. Each takes the renderer state it reads
 * (`RendererProbeState`, a getter view the renderer builds once), and
 * PixiRenderer keeps a one-line public delegate so callers are unchanged.
 * A new probe goes here, not inline in PixiRenderer.
 */

import type { Application, Container } from 'pixi.js';
import type { RenderMirror, RenderPerfReading, PerfProbeOp, RenderCountReading } from '@core/contracts/IRenderer';
import { FrameTimeRing } from '@core/perf/FrameTimeRing';
import type { Camera } from '../worker/Camera';
import type { EffectsService } from '../../effects/EffectsService';
import type { MountVisualManager } from '../MountVisualManager';
import type { HelmCourseMarker } from '../helm/HelmCourseMarker.js';
import type { StarfieldBackground } from '../StarfieldBackground';
import type { Backdrop } from '../art/fx/Backdrop.js';
import type { FxBeams, FxProjectiles } from '../art/fx/FxWeapons.js';
import type { FxExplosions } from '../art/fx/FxExplosions.js';
import type { FxEngines } from '../art/fx/FxEngines.js';
import type { FxFences, FxShields } from '../art/fx/FxShields.js';
import { litPass } from '../art/litPass.js';
import { isMachinedSprite, type ShipArtCtx } from '../art/shipArtSprites.js';
import { probeIdentity } from '../shipRekey.js';
import { WreckPieceSprite } from './wreckArt.js';
import type { FarZoomIcons } from './FarZoomIcons';
import type { WarpFx } from './WarpFx.js';
import type { WarpSpoolFx } from './WarpSpoolFx.js';
import type { SelectionBracket } from '../SelectionBracket';

/** The renderer state the probes read (live values: getters on the renderer). */
export interface RendererProbeState {
  readonly app: Application;
  readonly sprites: Map<string, Container>;
  readonly artCtx: ShipArtCtx;
  readonly swarmSpriteKinds: Map<string, number>;
  readonly mountVisuals: MountVisualManager;
  readonly camera: Camera;
  readonly starfield: StarfieldBackground | null;
  readonly backdrop: Backdrop | null;
  readonly effects: EffectsService | null;
  readonly engineDbgScratch: number[];
  readonly farIcons: FarZoomIcons;
  readonly warpFx: WarpFx;
  readonly spoolFx: WarpSpoolFx;
  readonly helmMarker: HelmCourseMarker;
  readonly lastMirror: RenderMirror | null;
  readonly fxEngines: FxEngines | null;
  readonly fxExplosions: FxExplosions | null;
  readonly fxProjectiles: FxProjectiles | null;
  readonly fxLiveBeams: FxBeams | null;
  readonly fxShields: FxShields | null;
  readonly fxShieldsOn: boolean;
  readonly fxFences: FxFences | null;
  readonly wreckBreaks: number;
  readonly wreckBlastsSpawned: number;
  readonly wreckRipplesSpawned: number;
  readonly hullBlastsReplaced: number;
  readonly shipRekeysApplied: number;
  readonly selectionBracket: SelectionBracket | null;
  readonly fleetRing: FleetRingProbeState;
}

export interface BackdropStats { classicStars: boolean; motes: { near: number; fore: number } | null; deep: number; on: boolean; nebula: string | null; landmarks: number; sky: string; density: number; speed: number; speedZoom: number; speedLevel: string }

export type ArtStats = { mode: 'classic' | 'machined'; machinedSprites: number; classicShipSprites: number; backdrop: BackdropStats; fxProjectiles: number; fxWakes: number; fxBeam: boolean; fxExplosions: number; fxShields: number; fxFences: number; fxFenceHits: number; fxFenceContacts: number; fxEngines: number; engineParticles: number; turrets: number; turretShots: number; turretAim: ReturnType<MountVisualManager['aimProbe']>; lodDots: number; effectQuality: string; fxRibbons: number; localEngine: ReturnType<FxEngines['debugView']>; warpBursts: number; warpSpooling: number; spoolFxDrawn: number; ownArt: string | null; helmMarker: boolean; wreckPieces: number; wreckTextured: number; wreckGlowing: number; wreckBreaks: number; wreckEngines: number; wreckLit: number; wreckRawMaps: number; wreckFarLod: number; wreckBlasts: number; wreckRipples: number; hullBlastsReplaced: number; litMeshes: number } & Partial<ReturnType<NonNullable<ShipArtCtx['art']>['stats']>>;

export interface FleetRingReading { id: string; ringX: number; ringY: number; shipX: number; shipY: number; frames: number }

/** Test-only ring probe state (RTS review 2026-11-14). Off until first read. Built once. */
export interface FleetRingProbeState { on: boolean; readonly probe: FleetRingReading; readonly pt: { x: number; y: number } }
export function createFleetRingProbe(): FleetRingProbeState {
  return { on: false, probe: { id: '', ringX: NaN, ringY: NaN, shipX: NaN, shipY: NaN, frames: 0 }, pt: { x: 0, y: 0 } };
}

/** Ticker, after the camera tick (the transform this frame renders with):
 *  the first selection marker as drawn vs its ship sprite's screen point. */
export function captureFleetRingProbe(r: RendererProbeState): void {
  const o = r.selectionBracket;
  const id = o?.lastMarkerId ?? null;
  if (o === null || id === null) return;
  const sp = r.sprites.get(id);
  if (sp === undefined) return;
  const g = sp.parent ? sp.parent.toGlobal(sp.position, r.fleetRing.pt) : null;
  if (g === null) return;
  const p = r.fleetRing.probe;
  p.id = id; p.ringX = o.lastMarker.x; p.ringY = o.lastMarker.y; p.shipX = g.x; p.shipY = g.y; p.frames++;
}

/**
 * Test-only (RTS review 2026-11-14): turns the per-frame ring probe on and
 * returns the latest capture: the first selection marker's drawn centre and its
 * ship's screen point, both as the frame renders. Read by the
 * `__eqxFleetRingProbe` DEV hook (`?worker=0`). Not used by gameplay.
 */
export function fleetRingProbe(r: RendererProbeState): FleetRingReading {
  r.fleetRing.on = true;
  return { ...r.fleetRing.probe };
}

/** DEBUG (exhaust-side investigation): the local ship sprite WORLD position
 *  + engine particle world positions (pixi coords; gfx.y = -gameY). */
export function debugEngine(r: RendererProbeState): { ship: { x: number; y: number; vx: number; vy: number }; particles: number[] } | null {
  const localId = r.lastMirror?.localPlayerId;
  if (!localId || !r.effects) return null;
  const sp = r.sprites.get(localId);
  if (!sp) return null;
  const out: number[] = [];
  const n = r.effects.debugCopyEngineParticleWorld(out);
  out.length = n * 4;
  const sv = r.lastMirror?.ships.get(localId);
  return { ship: { x: sp.x, y: sp.y, vx: sv?.vx ?? 0, vy: sv?.vy ?? 0 }, particles: out };
}

export interface ShipVisualProbe { sprite: number | null; cluster: number | null; artHandle: number | null; rekeys: number }

/** DEV/E2E: what the backdrop is showing. */
export function backdropStats(r: RendererProbeState): BackdropStats {
  const b = r.backdrop;
  return { classicStars: r.starfield?.isVisible() === true, motes: b?.moteCounts() ?? null, deep: b?.deepSpace() ?? 0, on: b?.sky.visible === true, nebula: b?.nebulaKey() ?? null, landmarks: b?.visibleLandmarks ?? 0, sky: b?.skySignature ?? '', density: b?.density ?? 0,
    speed: b?.speed.sf ?? 0, speedZoom: r.camera.speedZoom(), speedLevel: b?.speedLevel ?? 'off' };
}

/**
 * Test-only (RTS Part A seamless hand-over): the identity of the ship drawn
 * under `key`: its sprite's and turret cluster's Pixi `uid`, its art handle's
 * probe id, and how many re-keys this renderer has applied. A spec reads it
 * before and after taking a ship's controls: the same numbers under the new
 * key mean nothing was rebuilt. Read by the `__eqxShipVisualProbe` DEV hook
 * (`?worker=0`). Not used by gameplay.
 */
export function shipVisualProbe(r: RendererProbeState, key: string): ShipVisualProbe {
  const sp = r.sprites.get(key);
  const cl = r.mountVisuals.clusterOf(key);
  const h = r.artCtx.handles.get(key);
  return {
    sprite: sp?.uid ?? null,
    cluster: cl?.uid ?? null,
    artHandle: h === undefined ? null : probeIdentity(h),
    rekeys: r.shipRekeysApplied,
  };
}

/** Machined art status: the service's counts plus how many ship sprites
 *  are drawing Machined vs today's look right now. */
export function artStats(r: RendererProbeState): ArtStats {
  let machined = 0, classic = 0;
  for (const [id, sp] of r.sprites) {
    if (isMachinedSprite(sp)) machined++;
    else if (!id.startsWith('swarm-') || r.artCtx.handles.has(id)) classic++;
  }
  // Capital destruction S2b: drawn wreck pieces (visible sprites of kind 4).
  // S3: textured pieces (parent art), pieces whose cut edges still glow,
  // and break-ups played.
  // wreckEngines: pieces drawing engine exhaust this frame. Must stay 0: a
  // piece wears the dead ship's art handle (nozzles and all), but a wreck
  // has no engines.
  let wreckPieces = 0, wreckTextured = 0, wreckGlowing = 0, wreckEngines = 0, wreckLit = 0, wreckRawMaps = 0, wreckFarLod = 0;
  for (const [id, k] of r.swarmSpriteKinds) {
    if (k !== 4) continue;
    if (r.fxEngines?.drew(id) === true) wreckEngines++;
    const sp = r.sprites.get(id);
    if (sp?.visible !== true) continue;
    wreckPieces++;
    if (sp instanceof WreckPieceSprite) {
      if (sp.art !== null) wreckTextured++;
      if (sp.glowAlpha() > 0) wreckGlowing++;
      if (sp.farZoom) wreckFarLod++;
      const am = sp.artMode();
      if (am === 'lit') wreckLit++;
      else if (am === 'raw-maps') wreckRawMaps++;
    }
  }
  const wreckBreaks = r.wreckBreaks;
  const art = r.artCtx.art;
  return { wreckPieces, wreckTextured, wreckGlowing, wreckBreaks, wreckEngines, wreckLit, wreckRawMaps, wreckFarLod, wreckBlasts: r.wreckBlastsSpawned, wreckRipples: r.wreckRipplesSpawned, hullBlastsReplaced: r.hullBlastsReplaced, litMeshes: litPass.settings ? litPass.count : -1, mode: art ? 'machined' : 'classic', machinedSprites: machined, classicShipSprites: classic, backdrop: backdropStats(r), fxProjectiles: r.fxProjectiles?.liveCount() ?? 0, fxWakes: r.fxProjectiles?.wakeCount() ?? 0, fxBeam: r.fxLiveBeams?.container.visible === true, fxExplosions: r.fxExplosions?.activeCount() ?? 0, fxShields: r.fxShieldsOn ? r.fxShields!.count() : -1, fxFences: r.fxFences?.count() ?? 0, fxFenceHits: r.fxFences?.hitCount ?? 0, fxFenceContacts: r.fxFences?.contactCount() ?? 0, fxEngines: r.fxEngines?.drawn() ?? -1, engineParticles: r.effects ? r.effects.debugCopyEngineParticleWorld(r.engineDbgScratch) : 0, turrets: r.mountVisuals.machinedGunCount(), turretShots: r.mountVisuals.turretShotCount(), turretAim: r.mountVisuals.aimProbe(), lodDots: r.farIcons.iconCount, effectQuality: r.effects?.getQuality() ?? 'none', fxRibbons: r.fxEngines?.ribbons() ?? -1, warpBursts: r.warpFx.burstCount(), warpSpooling: r.warpFx.spoolCount(), spoolFxDrawn: r.spoolFx.spooling, helmMarker: r.helmMarker.isVisible(), ownArt: r.lastMirror?.localPlayerId ? (r.artCtx.handles.get(r.lastMirror.localPlayerId)?.state ?? 'none') : null, localEngine: r.lastMirror?.localPlayerId ? (r.fxEngines?.debugView(r.lastMirror.localPlayerId) ?? null) : null, ...(art ? art.stats() : {}) };
}

/**
 * Perf scenes (plan prancy-squishing-donut P2): per-frame render cost,
 * recorded only after `sync('enable')` (`?perfprobe=1`), plus the count
 * probe (WS3): draw calls per rendered frame + upload baselines. Built once by
 * the renderer; `ring` is pushed once per `update()`.
 */
export class RendererPerfProbe {
  ring: FrameTimeRing | null = null;
  private _drawRing: FrameTimeRing | null = null;
  private _drawCount = 0;
  private _drawMark = 0;
  private _uploadsBase = 0;
  private _uploadTexelsBase = 0;

  constructor(private readonly r: RendererProbeState) {}

  /** Count mode (`?perfcounts=1`): pin the effects tier (what is drawn must not
   *  depend on the host's speed), count WebGL draw calls by wrapping the
   *  context's draw entry points, and close each rendered frame on Pixi's
   *  `postrender` runner. Perf runs only; players never reach it. */
  private enableCountProbe(): void {
    if (this._drawRing || !this.r.app?.renderer) return;
    this._drawRing = new FrameTimeRing();
    this.r.effects?.pinQuality('high');
    const gl = (this.r.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (gl) {
      // Fixed-arity wrappers: no rest-array per draw call (#14).
      const de = gl.drawElements.bind(gl);
      gl.drawElements = (m, c, t, o) => { this._drawCount++; de(m, c, t, o); };
      const da = gl.drawArrays.bind(gl);
      gl.drawArrays = (m, f, c) => { this._drawCount++; da(m, f, c); };
      if (typeof gl.drawElementsInstanced === 'function') {
        const dei = gl.drawElementsInstanced.bind(gl);
        gl.drawElementsInstanced = (m, c, t, o, n) => { this._drawCount++; dei(m, c, t, o, n); };
      }
      if (typeof gl.drawArraysInstanced === 'function') {
        const dai = gl.drawArraysInstanced.bind(gl);
        gl.drawArraysInstanced = (m, f, c, n) => { this._drawCount++; dai(m, f, c, n); };
      }
    }
    const runners = (this.r.app.renderer as unknown as { runners?: { postrender?: { add(o: { postrender(): void }): void } } }).runners;
    runners?.postrender?.add({ postrender: () => {
      this._drawRing?.push(this._drawCount - this._drawMark);
      this._drawMark = this._drawCount;
    } });
    this.resetCountProbe();
  }

  private resetCountProbe(): void {
    this._drawRing?.reset();
    this._drawMark = this._drawCount;
    const s = this.r.artCtx.art?.stats();
    this._uploadsBase = s?.uploads ?? 0;
    this._uploadTexelsBase = s?.uploadTexels ?? 0;
  }

  private readCountProbe(): RenderCountReading | null {
    if (!this._drawRing) return null;
    const d = this._drawRing.summary();
    const s = this.r.artCtx.art?.stats();
    return {
      drawCalls: { frames: d.frames, p50: d.p50, p95: d.p95, max: d.max },
      textureUploads: (s?.uploads ?? 0) - this._uploadsBase,
      uploadTexels: (s?.uploadTexels ?? 0) - this._uploadTexelsBase,
      atlasPages: s?.pages ?? 0,
      gpuBytes: s?.gpuBytes ?? 0,
    };
  }

  sync(op: PerfProbeOp): RenderPerfReading | null {
    if (op === 'enable') { this.ring ??= new FrameTimeRing(); return null; }
    if (op === 'counts') { this.ring ??= new FrameTimeRing(); this.enableCountProbe(); return null; }
    if (!this.ring) return null;
    if (op === 'reset') { this.ring.reset(); this.resetCountProbe(); return null; }
    let displayObjects = 0;
    const walk = (c: Container): void => { displayObjects++; for (const ch of c.children) walk(ch as Container); };
    if (this.r.app?.stage) walk(this.r.app.stage);
    const m = this.r.lastMirror;
    return {
      render: this.ring.summary(),
      sprites: this.r.sprites.size,
      displayObjects,
      mirrorShips: m?.ships.size ?? 0,
      mirrorSwarm: m?.swarm?.size ?? 0,
      effectQuality: this.r.effects?.getQuality() ?? 'none',
      counts: this.readCountProbe(),
    };
  }
}
