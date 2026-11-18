/**
 * Per-frame warp-to visuals (departure / arrival bursts) and warp spool-up —
 * lifted out of `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `updateWarpFx(mirror, ctx)` feeds `WarpFx` and `WarpSpoolFx` one resolved
 * sprite pose per visible ship (players, parked hulls in a warp phase, and
 * warping drones). The ctx, its effects, scratch and per-ship maps are built
 * once by `createWarpFxCtx` (renderer construction, so probes and resets are
 * safe before `init`); the caller writes `cameraScale` before each call.
 * Nothing here allocates per ship (invariant #14) beyond the debt noted inline.
 */

import type { Container } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { WARP_SPOOL_TICKS } from '@core/physics/warpDrive';
import { WarpSpoolFx, type SpoolFxShip, type Nozzle } from './WarpSpoolFx.js';
import { WarpFx, type WarpFxShip } from './WarpFx.js';
import { engineProfileForKind } from './engineGeometry.js';
import { isParkedHull } from '../shipOwnership.js';
import { warpFxFeedsShip } from '../warpFxGate.js';
import type { ShipArtCtx } from '../art/shipArtSprites.js';

export interface WarpFxCtx {
  /** Written by the caller each frame (world scale). */
  cameraScale: number;
  fxNow: () => number;
  sprites: Map<string, Container>;
  artHandles: ShipArtCtx['handles'];
  warpFx: WarpFx;
  spoolFx: WarpSpoolFx;
  spoolShip: SpoolFxShip;
  /** Per ship: when its spool started (ms) and its last warp phase. */
  spoolStart: Map<string, number>;
  spoolPhase: Map<string, number>;
  /** Per kind: hull half length and a stern nozzle for classic-look ships. */
  spoolKind: Map<string, { half: number; nozzles: Nozzle[] }>;
  warpShipScratch: WarpFxShip;
  warpStern: Map<string, number>;
  /** W2a — drones fed to WarpFx last frame (their sprite keys). */
  droneWarpFed: Set<string>;
  /** Parked hulls fed to the warp effects last frame (`warpFxFeedsShip`).
   *  A hull that left the mirror is dropped on the next frame's sweep. */
  hullWarpFed: Set<string>;
  /** W2a — `swarm-<id>` keys, built once per drone (no per-frame string). */
  droneWarpKeys: Map<number, string>;
}

export interface WarpFxCtxRefs {
  fxNow: () => number;
  sprites: Map<string, Container>;
  artHandles: ShipArtCtx['handles'];
  /** Tests inject their own effects; the renderer lets these default. */
  warpFx?: WarpFx;
  spoolFx?: WarpSpoolFx;
}

/** Build the pooled warp ctx once (renderer construction). */
export function createWarpFxCtx(refs: WarpFxCtxRefs): WarpFxCtx {
  return {
    cameraScale: 1,
    fxNow: refs.fxNow,
    sprites: refs.sprites,
    artHandles: refs.artHandles,
    warpFx: refs.warpFx ?? new WarpFx(),
    spoolFx: refs.spoolFx ?? new WarpSpoolFx(),
    spoolShip: { x: 0, y: 0, rotation: 0, progress: -1, nozzles: [], half: 0 },
    spoolStart: new Map(),
    spoolPhase: new Map(),
    spoolKind: new Map(),
    warpShipScratch: { x: 0, y: 0, rotation: 0, warp: undefined, stern: 0, isLocal: false },
    warpStern: new Map(),
    droneWarpFed: new Set(),
    hullWarpFed: new Set(),
    droneWarpKeys: new Map(),
  };
}

/** Warp-to visuals for every visible ship (one resolved sprite pose each). */
export function updateWarpFx(mirror: RenderMirror, ctx: WarpFxCtx): void {
  const fx = ctx.warpFx;
  fx.beginFrame(ctx.fxNow(), ctx.cameraScale);
  ctx.spoolFx.beginFrame(ctx.fxNow(), ctx.cameraScale);
  const local = mirror.localPlayerId;
  const s = ctx.warpShipScratch;
  const hullFed = ctx.hullWarpFed;
  for (const [id, ship] of mirror.ships) {
    // ACTIVE ships always; a parked hull (#17 LINGERING) only while it has a
    // warp phase (RTS fleet warp S4: its group spools / it just arrived),
    // and one frame after (warpFxGate.ts).
    const parked = isParkedHull(mirror, id, ship);
    if (!warpFxFeedsShip(parked, ship.warp, parked && hullFed.has(id))) continue;
    if (parked) {
      if (ship.warp === undefined) hullFed.delete(id); else hullFed.add(id);
    }
    const sp = ctx.sprites.get(id);
    // A remote ship on its run is hidden but still tracked (its departure).
    if (!sp || (!sp.visible && ship.warp !== 2)) continue;
    const kind = ship.kind ?? '';
    let stern = ctx.warpStern.get(kind);
    if (stern === undefined) { stern = engineProfileForKind(ship.kind).sternOffset; ctx.warpStern.set(kind, stern); }
    s.x = sp.x; s.y = sp.y; s.rotation = sp.rotation; s.warp = ship.warp; s.stern = stern; s.isLocal = id === local;
    fx.draw(id, s);
    drawSpoolFx(ctx, id, ship.warp, ship.kind, sp, id === local ? mirror.localSpoolMs : undefined);
  }
  // Hulls that left (warped out, or the sector changed): forget them.
  if (hullFed.size > 0) {
    for (const id of hullFed) if (!mirror.ships.has(id)) hullFed.delete(id); // TODO: alloc-debt (iterator; only while a hull warps)
  }
  // W2a — NPCs warping (flagship fleets). Fed while their phase is set and
  // one frame after it clears, so a cancelled spool settles to idle instead
  // of WarpFx reading the disappearance as a departure.
  const fed = ctx.droneWarpFed;
  if (mirror.swarm) for (const [eid, e] of mirror.swarm) {
    if (e.kind !== 1) continue;
    const key = droneWarpKey(ctx, eid);
    if (e.warp === undefined && !fed.has(key)) continue;
    const sp = ctx.sprites.get(key);
    if (!sp) continue;
    const kindId = e.shipKind ?? '';
    let stern = ctx.warpStern.get(kindId);
    if (stern === undefined) { stern = engineProfileForKind(e.shipKind).sternOffset; ctx.warpStern.set(kindId, stern); }
    s.x = sp.x; s.y = sp.y; s.rotation = sp.rotation; s.warp = e.warp; s.stern = stern; s.isLocal = false;
    fx.draw(key, s);
    drawSpoolFx(ctx, key, e.warp, e.shipKind, sp, undefined);
    if (e.warp === undefined) fed.delete(key); else fed.add(key);
  }
  // A ship that died this frame left the mirror because it died, not because
  // it warped out: no departure (same keys as the sprite maps).
  if (mirror.explodingShips && mirror.explodingShips.size > 0) {
    for (const id of mirror.explodingShips) { fx.died(id); fed.delete(id); }
  }
  fx.endFrame();
  ctx.spoolFx.endFrame();
}

/** One ship's spool-up (progress-driven, sized from its own nozzles). */
function drawSpoolFx(ctx: WarpFxCtx, id: string, warp: number | undefined, kind: string | undefined, sp: Container, spoolMs: number | undefined): void {
  const now = ctx.fxNow();
  const phase = warp === 1 ? 1 : 0;
  if (phase !== (ctx.spoolPhase.get(id) ?? 0)) {
    if (phase === 1) { ctx.spoolPhase.set(id, 1); ctx.spoolStart.set(id, now); }
    else { ctx.spoolPhase.delete(id); ctx.spoolStart.delete(id); }
  }
  const kindId = kind ?? 'fighter';
  let k = ctx.spoolKind.get(kindId);
  if (!k) {
    // Classic-look ships have no baked nozzles: one at the stern.
    const stern = engineProfileForKind(kindId).sternOffset;
    k = { half: stern, nozzles: [{ x: 0, y: stern, r: Math.max(2, stern * 0.25) }] };
    ctx.spoolKind.set(kindId, k);
  }
  const s = ctx.spoolShip;
  s.x = sp.x; s.y = sp.y; s.rotation = sp.rotation;
  const dur = spoolMs ?? (WARP_SPOOL_TICKS / 60) * 1000;
  s.progress = phase === 1 ? Math.min(1, (now - (ctx.spoolStart.get(id) ?? now)) / dur) : -1;
  const art = ctx.artHandles.get(id)?.ship;
  s.nozzles = art && art.nozzles.length > 0 ? art.nozzles : k.nozzles;
  s.half = k.half;
  ctx.spoolFx.draw(id, s);
}

function droneWarpKey(ctx: WarpFxCtx, eid: number): string {
  let k = ctx.droneWarpKeys.get(eid);
  if (k === undefined) {
    k = `swarm-${eid}`;
    if (ctx.droneWarpKeys.size > 4096) ctx.droneWarpKeys.clear(); // bound it; rebuilt on demand
    ctx.droneWarpKeys.set(eid, k);
  }
  return k;
}
