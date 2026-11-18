/**
 * Per-frame remote, mining and live beam drawing — lifted out of
 * `PixiRenderer.update()` (god-file split, Phase 4).
 *
 * `updateBeams(mirror, ctx)` fills the pooled slot caches from this frame's
 * mirror and hands them to the sprite pools (and the `?fx=new` beam layers).
 * The ctx, its slot caches and its scratch line are built once by
 * `createBeamCtx` in `PixiRenderer.init`; the caller writes `cameraScale` and
 * `fxShieldsOn` before each call. Nothing here allocates per beam (invariant
 * #14): slots are reused in place, the pools only write transforms.
 */

import type { Container } from 'pixi.js';
import type { RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { shipShotMuzzle } from '@core/combat/muzzle';
import { shipTuning } from '@shared-types/shipScale/tuning';
import { getShipKind } from '../../../shared-types/shipKinds';
import { interpolateSwarmPose, type InterpolatedPose } from '../../net/swarmInterpolation';
import type { BeamSpritePool, BeamSpriteStyle } from '../BeamSpritePool';
import { liveBeamLook, liveBeamLine, remoteBeamStyleForMount, remoteBeamLine, remoteBeamSolidLen, BeamHitMemory, type RemoteBeamLine } from '../beamStyles';
import type { FxBeams } from '../art/fx/FxWeapons.js';
import type { FxFences, FxShields, ShieldPoseFn } from '../art/fx/FxShields.js';
import { applyMountOffset } from './spriteBuilders.js';

/** One remote (or mining) beam slot; the pools read the BeamView subset. */
export interface RemoteBeamSlot {
  shooterId: string;
  mountId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  alpha: number;
  /** Per-beam style override (the capital heavy beam); null = pool style. */
  style: BeamSpriteStyle | null;
  /** Solid length (`remoteBeamSolidLen`): the heavy beam is solid to its
   *  hit; undefined = the pool's taper (fighter beams). */
  solidLen?: number;
}

/** One live (local ship) beam slot. */
export interface LiveBeamSlot {
  mountId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  solidLen?: number;
  style?: BeamSpriteStyle | null;
}

export interface BeamCtx {
  /** Written by the caller each frame. */
  cameraScale: number;
  /** New shields are on this frame (the caller opened the shield frame). */
  fxShieldsOn: boolean;
  beamsDisabled: boolean;
  fxNow: () => number;
  remoteBeamPool: BeamSpritePool | null;
  remoteBeamGfx: Container | null;
  /** WS-4 Phase 4 (R2.27) — the Miner's drill beam pool (mountId `drill`). */
  miningBeamPool: BeamSpritePool | null;
  miningBeamGfx: Container | null;
  liveBeamPool: BeamSpritePool | null;
  liveBeamGfx: Container | null;
  fxRemoteBeams: FxBeams | null;
  fxLiveBeams: FxBeams | null;
  fxShields: FxShields | null;
  fxFences: FxFences | null;
  fxShieldPose: ShieldPoseFn;
  /** Shared with the swarm updater (reused per frame, no allocation). */
  swarmPoseScratch: InterpolatedPose;
  feedback: RendererFeedback;
  /**
   * Plan: combat-fx-hunt (2026-05-31) — reused per-mount beam slots
   * (invariant #14). `liveBeamCacheCount` is the number of valid entries
   * this frame, read by the renderer's beam lights.
   */
  liveBeamCache: LiveBeamSlot[];
  liveBeamCacheCount: number;
  /** Same for remote shooters' beams (per-shooter + per-mount). Flat array;
   *  iteration order is stable across frames (JS Map insertion order). */
  remoteBeamCache: RemoteBeamSlot[];
  remoteBeamCacheCount: number;
  /** WS-4 Phase 4 — drill-beam slots routed out of the remote-laser loop
   *  into the dedicated mining pool; reused in place (invariant #14). */
  miningBeamCache: RemoteBeamSlot[];
  miningBeamCacheCount: number;
  /** Scratch for `remoteBeamLine` (one per frame loop, #14). */
  remoteBeamLine: RemoteBeamLine;
  /** The cut stays lit through a kill follow-through. */
  beamHitMem: BeamHitMemory;
  /** Per remote beam this frame: did it land on something (FxBeams' flare). */
  fxRemoteHit: boolean[];
}

export type BeamCtxRefs = Omit<BeamCtx,
  'cameraScale' | 'fxShieldsOn' | 'liveBeamCache' | 'liveBeamCacheCount' | 'remoteBeamCache' | 'remoteBeamCacheCount' |
  'miningBeamCache' | 'miningBeamCacheCount' | 'remoteBeamLine' | 'beamHitMem' | 'fxRemoteHit'>;

/** Build the pooled beam ctx once (renderer init). */
export function createBeamCtx(refs: BeamCtxRefs): BeamCtx {
  return {
    ...refs,
    cameraScale: 1,
    fxShieldsOn: false,
    liveBeamCache: [],
    liveBeamCacheCount: 0,
    remoteBeamCache: [],
    remoteBeamCacheCount: 0,
    miningBeamCache: [],
    miningBeamCacheCount: 0,
    remoteBeamLine: { fromX: 0, fromY: 0, toX: 0, toY: 0 },
    beamHitMem: new BeamHitMemory(),
    fxRemoteHit: [],
  };
}

export function updateBeams(mirror: RenderMirror, ctx: BeamCtx): void {
  // Remote beams from other players — orange, continuously tracking shooter rotation.
  // Uses shooter's current angle from mirror.ships so the beam sweeps smoothly between
  // server-acked shot events (every ~167ms).
  //
  // Multi-mount/turret refactor (Phase 2c): `mirror.remoteLasers` is now
  // `Map<shooterId, Map<mountId, laser>>`. We iterate the nested map and
  // resolve each mount's local offset from the shooter's ship-kind catalogue
  // entry, so multi-mount ships emit beams from the correct barrel positions
  // (not all stacked at the ship centre). Legacy single-mount ships have
  // mount.localX/Y = (0, 0) and baseAngle = 0, so the geometry collapses to
  // the pre-refactor "ship.pos + 20 u forward" path.
  if (!ctx.beamsDisabled && mirror.remoteLasers && mirror.remoteLasers.size > 0 && ctx.remoteBeamPool) {

    // Origin tracking: the shooter pose moves every frame (drones each
    // tick, players while turning), so we recompute every beam's
    // endpoints from the live mirror/swarm pose and ALWAYS call
    // `setBeams`. The old `BEAM_EPSILON` dirty-cache (combat-fx-hunt
    // 2026-05-31) compared this frame's pose to the PREVIOUS frame, not
    // to the last DRAWN frame — so coasting under the epsilon froze the
    // drawn beam while the shooter flew on, snapping to catch up only
    // when one frame exceeded the threshold (the laser-detach bug, smoke
    // handoff 2026-06-06, Issue 1 Bug #1). `setBeams` is O(count)
    // transform writes (no Graphics triangulation), so always-calling
    // for a handful of beams is free and adds no allocation (invariant
    // #14 — reuses the pooled slot array + pooled sprites).
    const now = ctx.fxNow();
    let slotIdx = 0;
    // WS-4 Phase 4 — drill beams route to the dedicated mining pool instead.
    let miningIdx = 0;

    for (const [shooterId, perShooter] of mirror.remoteLasers) {
      // Player shooters track their live ship pose; the beam sweeps with the
      // ship's rotation between fire events. AI shooters track their
      // mirror.swarm pose for the same reason — drones move every tick, so
      // a wire-frozen beam origin would re-anchor on each fire (visible
      // jump). Falls back to the wire endpoints if the shooter isn't found
      // (defensive — e.g. ID mapping mismatch).
      const shooter = mirror.ships.get(shooterId);
      let swarmShooter: { x: number; y: number; angle: number; radius: number; shipKind?: string } | null = null;
      if (!shooter && shooterId.startsWith('swarm-')) {
        const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
        if (!Number.isNaN(entityId)) {
          const sw = mirror.swarm?.get(entityId);
          if (sw) {
            // Use the SAME pose the sprite is drawn at — drones (kind=1)
            // render from `entry.x/y/angle` directly post-2026-05-09 reset
            // (predWorld pose synced into the mirror each frame). Asteroids
            // stay on the lerp path for parity with their sprite render.
            if (sw.kind === 1) {
              swarmShooter = { x: sw.x, y: sw.y, angle: sw.angle, radius: sw.radius, shipKind: sw.shipKind };
            } else {
              const lerped = interpolateSwarmPose(sw, now, ctx.swarmPoseScratch);
              swarmShooter = { x: lerped.x, y: lerped.y, angle: lerped.angle, radius: sw.radius, shipKind: sw.shipKind };
            }
          }
        }
      }

      const shooterKindId = shooter?.kind ?? swarmShooter?.shipKind ?? null;
      const shooterKind = getShipKind(shooterKindId);

      for (const [mountId, laser] of perShooter) {
        // Hold full brightness while shooter is actively firing; fade only
        // in the last 150 ms of TTL (i.e. after they stop shooting). With
        // WEAPON_COOLDOWN = 167 ms and TTL = 400 ms, each new shot resets
        // expiresAt well before the fade window, so the beam is solid-on
        // while space is held.
        const ttlRemaining = laser.expiresAt - now;
        const alpha = ttlRemaining > 150 ? 1.0 : Math.max(0, ttlRemaining / 150);

        // Resolve the mount's ship-local offset from the catalogue. Falls
        // back to a zero-offset zero-baseAngle stub for unknown mount ids
        // so a pre-2c server (no mountId in the wire) still renders.
        // Phase 4b.2: pick up the shooter's per-mount slewed angle from
        // `mirror.ships.get(id).mountAngles` (player shooters); Phase 4c
        // adds the same for drone shooters via `mirror.swarm.get(id).
        // mountAngles` (snapshot-anchored, in-interest drones only).
        const mount = shooterKind.mounts?.find((m) => m.id === mountId);
        const mountIdx = shooterKind.mounts?.findIndex((m) => m.id === mountId) ?? -1;
        // Undefined = this viewer has no angle for the turret (an
        // out-of-interest drone): the beam then aims at the wire end point.
        let currentMountAngle: number | undefined = 0;
        if (shooter && mount && mountIdx >= 0) {
          currentMountAngle = shooter.mountAngles?.[mountIdx] ?? 0;
        } else if (swarmShooter && mount && mountIdx >= 0) {
          // Pull the drone's per-mount angle out of the swarm mirror —
          // ColyseusClient writes it from `snap.drones[].mountAngles`
          // when the drone is in-interest. Out-of-interest → undefined
          // → currentMountAngle stays 0 (barrel at baseAngle, no rotation).
          const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
          if (!Number.isNaN(entityId)) {
            const sw = mirror.swarm?.get(entityId);
            // The angle the turret is DRAWN at (swarmSpriteUpdater), so the
            // beam leaves down the barrel on screen, not the raw 20 Hz step.
            currentMountAngle = (sw?.displayMountAngles ?? sw?.mountAngles)?.[mountIdx];
          }
        }

        let fromX: number;
        let fromY: number;
        let toX: number;
        let toY: number;
        const isMining = mountId === 'drill';
        // The capital heavy beam (plan beam-slices §8) draws thick and violet
        // in the SAME pool: the style comes from the mount's catalogue weapon
        // (shooter kind + mountId), no wire field. A styled pulse runs down
        // the live barrel to the client ray's stop (`laser.dist`), else to
        // the server's end point (`remoteBeamLine`).
        const style = isMining ? null : remoteBeamStyleForMount(mount);
        const line = ctx.remoteBeamLine;
        if (shooter) {
          const origin = applyMountOffset(shooter.x, shooter.y, shooter.angle, mount);
          // The barrel tip (shared with the server, core/combat/muzzle.ts).
          const muzzleD = mount ? shipShotMuzzle(shooterKind, mount) : shipTuning(shooterKind).muzzleClearance;
          remoteBeamLine(
            style !== null, shooter.angle, mount?.baseAngle ?? 0, currentMountAngle ?? 0,
            origin.x, origin.y, muzzleD, laser.range, laser.toX, laser.toY, line, laser.dist,
          );
          fromX = line.fromX; fromY = line.fromY; toX = line.toX; toY = line.toY;
        } else if (swarmShooter) {
          const origin = applyMountOffset(swarmShooter.x, swarmShooter.y, swarmShooter.angle, mount);
          // Drone barrel offset is `radius + 2` along the mount's fire
          // direction (no mount → centre of drone). Matches the
          // pre-refactor visual where the beam clears the drone hull.
          // A drone's turning turret fires from its barrel tip (the server's
          // AiFireResolver uses the same shared muzzle).
          const barrelOffset = mount ? shipShotMuzzle(shooterKind, mount, true) : swarmShooter.radius + 2;
          // A turning mount with no known angle (out of this viewer's
          // interest, so no `drones[].mountAngles`) aims at the wire end.
          remoteBeamLine(
            style !== null, swarmShooter.angle, mount?.baseAngle ?? 0, mount ? currentMountAngle : 0,
            origin.x, origin.y, barrelOffset, laser.range, laser.toX, laser.toY, line, laser.dist,
          );
          fromX = line.fromX; fromY = line.fromY; toX = line.toX; toY = line.toY;
        } else {
          fromX = laser.fromX;
          fromY = laser.fromY;
          toX = laser.toX;
          toY = laser.toY;
        }
        // Fill the reused pooled slot (no per-beam allocation). The Miner's
        // mining beam (mountId 'drill') routes into the dedicated mining pool
        // (WS-4 Phase 4) so it draws as a distinct fat amber drill beam and is
        // isolatable for the E2E; everything else stays in the remote pool.
        const cache = isMining ? ctx.miningBeamCache : ctx.remoteBeamCache;
        const idx = isMining ? miningIdx : slotIdx;
        let slot = cache[idx];
        if (!slot) {
          slot = { shooterId, mountId, fromX, fromY, toX, toY, alpha, style: null };
          cache[idx] = slot;
        }
        slot.shooterId = shooterId; slot.mountId = mountId;
        slot.fromX = fromX; slot.fromY = fromY; slot.toX = toX; slot.toY = toY;
        slot.alpha = alpha;
        slot.style = style;
        // ...and burns full width to its hit point (a short fade past a miss).
        slot.solidLen = remoteBeamSolidLen(style, Math.hypot(toX - fromX, toY - fromY), laser.hit === true);
        if (!isMining) { ctx.fxRemoteHit[idx] = laser.hit === true; ctx.beamHitMem.track(shooterId, mountId, laser.hit === true, slot); }
        // A beam landing on a shield is a held contact there.
        if (ctx.fxShieldsOn && !isMining && laser.hit && laser.targetId) ctx.fxShields!.beam(laser.targetId, 1 + idx, toX, toY, ctx.fxShieldPose);
        // A beam that hit something with no target id stopped on a fence.
        else if (!isMining && laser.hit && !laser.targetId) ctx.fxFences?.beam(1 + idx, toX, toY);
        if (isMining) miningIdx++;
        else slotIdx++;
      }
    }
    ctx.remoteBeamCacheCount = slotIdx; ctx.beamHitMem.endFrame();
    ctx.miningBeamCacheCount = miningIdx;

    // Sprite-pool driven render — no clear/redraw, just transforms.
    // Always re-set: the pool resolves its own pooling + visibility and
    // the transform writes are cheap (see the always-call rationale above).
    ctx.remoteBeamPool.setBeams(ctx.remoteBeamCache, slotIdx, ctx.cameraScale);
    ctx.remoteBeamGfx!.visible = true;
    ctx.fxRemoteBeams?.setBeams(ctx.remoteBeamCache, slotIdx, ctx.fxNow(), ctx.fxRemoteHit, ctx.cameraScale);
    if (ctx.miningBeamPool && ctx.miningBeamGfx) {
      ctx.miningBeamPool.setBeams(ctx.miningBeamCache, miningIdx);
      ctx.miningBeamGfx.visible = miningIdx > 0;
      ctx.feedback.miningBeamCount = ctx.miningBeamPool.liveCount;
    }
  } else if (ctx.remoteBeamPool && ctx.remoteBeamGfx) {
    ctx.remoteBeamGfx.visible = false;
    ctx.remoteBeamPool.hideAll();
    ctx.fxRemoteBeams?.hideAll();
    ctx.remoteBeamCacheCount = 0; ctx.beamHitMem.endFrame();
    if (ctx.miningBeamPool && ctx.miningBeamGfx) {
      ctx.miningBeamGfx.visible = false;
      ctx.miningBeamPool.hideAll();
      ctx.miningBeamCacheCount = 0;
      ctx.feedback.miningBeamCount = 0;
    }
  }

  // Live hitscan beams — one per mount in the local ship's active slot.
  // Derive geometry from the local ship's lerped pose in mirror.ships each
  // frame so beams stay glued to the ship sprite even during a server-
  // correction lerp. (Mirrors the remote-beam pattern above — single source
  // of truth: "where the ship is visually right now".)
  //
  // Multi-mount/turret refactor (Phase 2c): `mirror.liveBeams` is now a
  // per-mount map. Legacy single-mount fighter/scout/heavy has exactly one
  // entry keyed by `'forward'`; multi-mount kinds (Phase 3) get one entry
  // per barrel and each draws independently.
  const localShip = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : null;
  if (!ctx.beamsDisabled && mirror.liveBeams && mirror.liveBeams.size > 0 && localShip && ctx.liveBeamPool) {
    const localKind = getShipKind(localShip.kind ?? null);
    const localMounts = localKind.mounts ?? [];

    // Recompute every beam's endpoints from the live ship pose and
    // ALWAYS call `setBeams`. The old `BEAM_EPSILON` dirty-cache
    // (combat-fx-hunt 2026-05-31) compared this frame's pose to the
    // PREVIOUS frame, not to the last DRAWN frame, and overwrote the
    // cache every frame — so coasting/flying under 4 u/frame never
    // tripped `dirty`, `setBeams` was never called, and the DRAWN beam
    // froze in place while the ship flew on (snapping to catch up only
    // when one frame exceeded 4 u). That is the no-enemy fly-forward
    // laser-detach repro (smoke handoff 2026-06-06, Issue 1 Bug #1).
    // `setBeams` is O(count) transform writes — free for 1–2 beams,
    // adds no allocation (invariant #14 — pooled slots + pooled sprites).
    let slotIdx = 0;
    for (const [mountId, beam] of mirror.liveBeams) {
      const mountIdx = localMounts.findIndex((m) => m.id === mountId);
      const mount = mountIdx >= 0 ? localMounts[mountIdx] : undefined;
      const currentMountAngle = mountIdx >= 0 ? (localShip.mountAngles?.[mountIdx] ?? 0) : 0;
      // From the barrel tip (the shared muzzle the client ray is cast from).
      const line = liveBeamLine(localKind, mount, localShip.x, localShip.y, localShip.angle, currentMountAngle, beam.dist, ctx.remoteBeamLine);
      const fromX = line.fromX, fromY = line.fromY, toX = line.toX, toY = line.toY;
      let slot = ctx.liveBeamCache[slotIdx];
      if (!slot) {
        slot = { mountId, fromX: 0, fromY: 0, toX: 0, toY: 0 };
        ctx.liveBeamCache[slotIdx] = slot;
      }
      slot.mountId = mountId;
      slot.fromX = fromX;
      slot.fromY = fromY;
      slot.toX = toX;
      slot.toY = toY;
      // P1a — the full-strength solid length (== aim guide / optimal range when
      // not clipped; beyond it the pool fades the beam to nothing) and the
      // per-beam style of the mount's weapon.
      liveBeamLook(mount, beam.dist, beam.solidDist, beam.hitId !== undefined, slot);
      if (ctx.fxShieldsOn && beam.hitId) ctx.fxShields!.beam(beam.hitId, 500 + slotIdx, toX, toY, ctx.fxShieldPose);
      // The local beam stops on a fence's prediction collider.
      if (beam.hitId?.startsWith('predwall-')) ctx.fxFences?.beam(500 + slotIdx, toX, toY);
      slotIdx++;
    }
    ctx.liveBeamCacheCount = slotIdx;

    // Sprite-pool driven render (matches remoteBeam path) — always re-set.
    ctx.liveBeamPool.setBeams(ctx.liveBeamCache, slotIdx, ctx.cameraScale);
    ctx.liveBeamGfx!.visible = true;
    ctx.fxLiveBeams?.setBeams(ctx.liveBeamCache, slotIdx, ctx.fxNow(), undefined, ctx.cameraScale);
    // E2E observable: publish the ACTUAL drawn beam origin (the sprite
    // transform), not a recompute — this is what catches the detach bug.
    ctx.feedback.liveBeamRenderedFromX = ctx.liveBeamPool.renderedFromX;
    ctx.feedback.liveBeamRenderedFromY = ctx.liveBeamPool.renderedFromY;
  } else {
    if (ctx.liveBeamGfx) ctx.liveBeamGfx.visible = false;
    ctx.liveBeamPool?.hideAll();
    ctx.fxLiveBeams?.hideAll();
    ctx.liveBeamCacheCount = 0;
    ctx.feedback.liveBeamRenderedFromX = null;
    ctx.feedback.liveBeamRenderedFromY = null;
  }}
