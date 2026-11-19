import { useUIStore } from '../../state/store.js';
import { resolvePlacementPreviewStatus } from '../../structures/structurePlacementClient.js';
import { interpolateSwarmPose, DISPLAY_DELAY_MS as SHELL_DISPLAY_DELAY_MS } from '../swarmInterpolation.js';
import { isRemoteMovingSwarmKind } from '../snapshotRemoteSync.js';
import { slewDisplayMountAngles } from '../displayMountAngles.js';
import { getShipKind } from '@shared-types/shipKinds';
import { stepRemoteShipOffset } from '../remoteLerpOffsets.js';
import { liveBeamVisible, LIVE_BEAM_PERSIST_MS } from '../../combat/LocalBeam.js';
import { updateRemoteBeamDists } from '../../combat/remoteBeamRay.js';
import type { MirrorPassCtx } from './mirrorPassCtx.js';

/** One server tick in ms (shells as events: the display-tick estimate). */
const SHELL_TICK_MS = 1000 / 60;

/** `updateMirror` pass: the placement ghost while spectating (no local ship). */
export function updateSpectatorPlacement(ctx: MirrorPassCtx, localId: string | null): void {
  // Phase 4 WS-A1 — construction WITHOUT an active ship (spectator mode, D4).
  // The placement-preview block above lives inside the local-ship branch and
  // anchors the ghost AHEAD of the ship. After death there is NO local ship in
  // `mirror.ships`, so that branch never runs — yet the spectator must still
  // build. Set `pendingPlacementPreview` here from a zeroed placeholder pose;
  // the renderer overrides x/y to the CAMERA CENTRE (free-roam) via the
  // spectator centre-seed (`shouldCentreGhostOnActivate(..., spectator)`), so
  // the blueprint follows where the player is looking. Reuses the same scratch
  // (no per-frame alloc — invariant #14) + the same pending-ghost machinery.
  const noLocalShip = !localId || !ctx.mirror.ships.has(localId);
  if (noLocalShip && useUIStore.getState().pilotMode === 'spectator') {
    const placementKind = useUIStore.getState().placementKind;
    let allRenderable = true;
    if (ctx.pendingPlacement) {
      const structs = ctx.mirror.structures;
      const sw = ctx.mirror.swarm;
      if (structs && structs.size > 0) {
        if (!sw) {
          allRenderable = false;
        } else {
          for (const id of structs.keys()) {
            if (!sw.has(id)) { allRenderable = false; break; }
          }
        }
      }
    }
    // Zeroed placeholder ship — the renderer re-anchors the ghost to the
    // camera centre in spectator, so the resolver's ahead-of-ship pose is a
    // throwaway that's immediately overridden.
    ctx.placementShipScratch.x = 0;
    ctx.placementShipScratch.y = 0;
    ctx.placementShipScratch.angle = 0;
    const status = resolvePlacementPreviewStatus(
      placementKind,
      placementKind ? ctx.placementShipScratch : null,
      ctx.pendingPlacement,
      Date.now(),
      ctx.mirror.structures?.size ?? 0,
      allRenderable,
      ctx.placementPreviewScratch,
    );
    if (status === 'active' || status === 'pending') {
      ctx.mirror.pendingPlacementPreview = ctx.placementPreviewScratch;
    } else {
      if (status === 'cleared') ctx.pendingPlacement = null;
      if (ctx.mirror.pendingPlacementPreview) ctx.mirror.pendingPlacementPreview = null;
    }
  }
}

/** `updateMirror` pass: the server-ghost debug marker. */
export function updateServerGhost(ctx: MirrorPassCtx): void {
  // Server ghost position — orange diamond drawn at the raw snapshot coords.
  ctx.mirror.serverGhostPos = ctx.lastSnapshotPos;
  // Snapshot the user's debug visibility preference into the mirror once per
  // frame so the Pixi renderer never reaches into the Zustand subscription
  // path (per src/client/CLAUDE.md Zustand-purity rule).
  ctx.mirror.showServerGhost = useUIStore.getState().showServerGhost;
}

/** `updateMirror` pass: drones and scrap at their interpolated pose. */
export function updateSwarmMirror(ctx: MirrorPassCtx): void {
  // Phase 5c: swarm entities (asteroids, drones) live in mirror.swarm,
  // populated by `decodeSwarmPacket` on every binary 'swarm' message. They
  // have no client prediction — server-authoritative @ 60 Hz lerped between
  // received frames. The renderer reads mirror.swarm directly each frame.

  // Drones (kind=1) AND scrap (kind=3): PURE snapshot interpolation off the
  // decoder-fed `poseRing` (drone-snapshot-interpolation pivot, 2026-05-18;
  // scrap joined this path in the Phase-5 desync fix, 2026-06-14). The SAME
  // `interpolateSwarmPose` the renderer uses (display-delay buffer + teleport
  // guard), computed ONCE here and written into the mirror entry so every
  // reader — renderer, HaloRadar, labels, health bars, MountVisualManager,
  // damage numbers, the local beam's hit test — sees one consistent pose.
  //
  // This loop does NOT touch the predWorld body any more (2026-11-08, the
  // remote-entity paradigm). The old "kinematic follower" re-posed the body
  // here every frame to this display-delayed pose (now − DISPLAY_DELAY_MS),
  // so the local ship, predicted AHEAD of the server, met each drone where
  // it was ~(100 ms + lead) ago: a correction on every melee contact
  // (docs/LESSONS.md 2026-11-08). Drone and scrap bodies now follow the same
  // path as remote player ships: anchored to the latest server state on
  // each snapshot (`anchorRemoteSwarmBodies`, inside `preResetRemoteShips`)
  // and stepped forward by the replay + `tickPhysics`, so they sit on the
  // local prediction's timeline and keep the local ship's own push. The
  // body may lead the sprite, exactly as a remote ship's body can lead its
  // lerp-offset sprite. Scrap stays a dynamic mass-1 body (never locked).
  //
  // Asteroids (kind=0) + structures (kind=2) keep their predWorld pose from
  // the binary packet (set in `syncSwarmIntoPredWorld`) and the renderer
  // interpolates them off the same poseRing — nothing to do for them here.
  if (ctx.predWorld && ctx.mirror.swarm) {
    const nowMs = ctx.clock.now();
    for (const entry of ctx.mirror.swarm.values()) {
      if (!isRemoteMovingSwarmKind(entry.kind)) continue;
      interpolateSwarmPose(entry, nowMs, ctx.swarmInterpScratch);
      entry.x = ctx.swarmInterpScratch.x;
      entry.y = ctx.swarmInterpScratch.y;
      entry.angle = ctx.swarmInterpScratch.angle;
      // Turret angles: carried forward between 20 Hz snapshots, at the same
      // single per-frame resolve as the pose (displayMountAngles.ts).
      if (entry.kind === 1 && (entry.mountAngles || entry.displayMountAngles)) {
        slewDisplayMountAngles(entry, entry.shipKind ? getShipKind(entry.shipKind).mounts : undefined, ctx.gameFrameMs() / 1000);
      }
    }    }
}

/** `updateMirror` pass: remote ships from predWorld plus their lerp offsets. */
export function updateRemoteShipsMirror(ctx: MirrorPassCtx, localId: string | null): void {
  // Remote ships — read from predWorld at 60 Hz with decaying lerp offsets.
  if (ctx.predWorld) {
    for (const remoteId of ctx.predRemoteShipIds) {
      if (remoteId === localId) continue;
      const s = ctx.predWorld.getShipState(remoteId);
      if (!s) continue;
      const off = ctx.remoteShipOffsets.get(remoteId);
      let ox = 0, oy = 0, oa = 0;
      if (off) {
        // Stage 1: critically-damped springs (x, y and angle; RTS Part A
        // S1 added the angle). Frame-rate independent and matches
        // Reconciler's local-ship offset shape; the entry ends once every
        // axis is at the noise floor (position and velocity).
        const stillMoving = stepRemoteShipOffset(off, ctx.lastFrameMs);
        ox = off.sx.x;
        oy = off.sy.x;
        oa = off.sa.x;
        if (!stillMoving) ctx.remoteShipOffsets.delete(remoteId);
      }
      // Probe 7 — mutate in place. Same rationale as the local-ship
      // pooling above: non-spatial fields (kind, displayName,
      // mountAngles) are preserved by NOT touching them.
      let entry = ctx.mirror.ships.get(remoteId);
      if (!entry) {
        entry = {
          x: s.x + ox,
          y: s.y + oy,
          vx: s.vx,
          vy: s.vy,
          angle: s.angle + oa,
        };
        ctx.mirror.ships.set(remoteId, entry);
      } else {
        entry.x = s.x + ox;
        entry.y = s.y + oy;
        entry.vx = s.vx;
        entry.vy = s.vy;
        entry.angle = s.angle + oa;
      }
    }
  }
}

/** `updateMirror` pass: ghost bolts, drawn shells, projectile extrapolation. */
export function updateProjectilesMirror(ctx: MirrorPassCtx, frameNowMs: number | undefined): void {
  // Ghost projectiles — advance and write to mirror.projectiles.
  if (ctx.mirror.projectiles) {
    ctx.ghostManager.update(ctx.gameFrameMs(), ctx.mirror.projectiles);
    // Shells as events (slice 2b): draw salvo shells at the display tick
    // (server tick estimate minus the remote-entity display delay), and
    // burst them when the display reaches their hit. At the FRAME's own
    // time (RAF stamp), not `gameClock.now()` (shellFrameTime.test.ts).
    if (ctx.shellEvents) {
      const displayTick = ctx.clockAnchorServerTick
        + (ctx.gameClock.at(frameNowMs ?? ctx.clock.now()) - ctx.clockAnchorPerfNow) / SHELL_TICK_MS
        - SHELL_DISPLAY_DELAY_MS / SHELL_TICK_MS;
      ctx.placeShells(displayTick);
    }

    // Authoritative projectile extrapolation. Snapshots arrive at 20 Hz, but
    // we render at RAF cadence — without per-frame integration the bolt is
    // frozen between snapshots and visibly stutters. Server-side projectiles
    // are constant-velocity (no forces), so straight-line extrapolation is
    // exact between snapshots. Ghosts are advanced by GhostManager above.
    // GAME seconds (time scale): at 0.4× a bolt drawn on wall dt flew at full
    // speed between snapshots and snapped back (hostile review 2026-11-12).
    const dtSec = ctx.gameFrameMs() / 1000;
    for (const entry of ctx.mirror.projectiles.values()) {
      if (entry.isGhost || entry.event === true) continue;
      entry.x += entry.vx * dtSec;
      entry.y += entry.vy * dtSec;
    }
  }
}

/** `updateMirror` pass: damage flash, hit-prediction TTL, beam/laser expiry. */
export function expireFrameState(ctx: MirrorPassCtx): void {
  // Damage flash — advance counters, populate mirror.damagedShips.
  ctx.mirror.damagedShips?.clear();
  for (const [id, frames] of ctx.damageFlashFrames) {
    if (frames <= 0) {
      ctx.damageFlashFrames.delete(id);
    } else {
      ctx.mirror.damagedShips?.add(id);
      ctx.damageFlashFrames.set(id, frames - 1);
    }
  }

  // weapon-hit-prediction Phase 2 — TTL-expire predictions whose
  // confirmation never arrived and hard-cancel their predicted numbers
  // (lost-ack / projectile-that-missed failsafe). Phase 3 adds the
  // hit_ack/DamageEvent-driven cancels on top of this one channel.
  const expiredShots = ctx.hitLedger.tick(ctx.clock.now());
  if (expiredShots.length > 0) {
    const cancels = ctx.mirror.pendingDamageNumberCancels;
    if (cancels) for (const e of expiredShots) cancels.push(e.clientShotId);
  }

  // beam-attach fix (capture pe6rdt): expire the persisted local
  // hitscan beam once its post-fire window has elapsed. While within
  // the window the renderer keeps drawing `mirror.liveBeams` from
  // `mirror.ships` every frame (ship-attached); past it, clear so a
  // released / switched weapon doesn't leave a beam lingering.
  if (
    ctx.mirror.liveBeams &&
    ctx.mirror.liveBeams.size > 0 &&
    !liveBeamVisible(ctx.clock.now(), ctx.lastHitscanFireMs, LIVE_BEAM_PERSIST_MS)
  ) {
    ctx.mirror.liveBeams.clear();
  }

  // explodingShips is cleared in App.tsx AFTER renderer.update() so the renderer
  // actually sees the set on the frame it was populated.

  // Expire remote lasers past their TTL. Per-mount, so different mounts on
  // the same shooter independently fade out as their cooldown windows end.
  if (ctx.mirror.remoteLasers && ctx.mirror.remoteLasers.size > 0) {
    const now = ctx.clock.now();
    for (const [shooterId, perShooter] of ctx.mirror.remoteLasers) {
      for (const [mountId, laser] of perShooter) {
        if (laser.expiresAt <= now) perShooter.delete(mountId);
      }
      if (perShooter.size === 0) ctx.mirror.remoteLasers.delete(shooterId);
    }
    // Heavy beams follow the live barrel to the client ray's stop (remoteBeamRay.ts).
    const skipRay = ctx.skipHitscanVisual || !ctx.predWorld;
    updateRemoteBeamDists(ctx.mirror, skipRay ? null : ctx.displayHitscan());
  }
}

/** `updateMirror` pass: each drone's hostility to the local player. */
export function updateDroneHostility(ctx: MirrorPassCtx, localId: string | null): void {
  // Phase F — drone hostility flag, driven by the per-drone AI behaviour's
  // `hostileTo` set. The radar (and any future hostility-aware surface)
  // reads `entry.isHostileToLocal` to colour entities. O(N) per frame
  // over registered drones; the underlying lookup is a Set.has().
  if (ctx.mirror.swarm && localId) {
    for (const [entityId, entry] of ctx.mirror.swarm) {
      if (entry.kind !== 1) continue; // asteroid — no hostility concept
      entry.isHostileToLocal = ctx.aiController.isEntityHostileToPlayer(
        `${entityId}`,
        localId,
      );
    }
  }
}
