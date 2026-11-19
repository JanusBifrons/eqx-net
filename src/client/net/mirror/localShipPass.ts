import { useUIStore } from '../../state/store.js';
import { logEvent, isFullDiagMode, isRammingProbeEnabled } from '../../debug/ClientLogger.js';
import { DEAD_RECKON_BACK_MS, DEAD_RECKON_CAP_MS } from '../renderTickPhase.js';
import { resolvePlacementPreviewStatus } from '../../structures/structurePlacementClient.js';
import type { MirrorPassCtx } from './mirrorPassCtx.js';

/** `updateMirror` pass: due predicted damage-number splits → the mirror. */
export function drainScheduledDamageSpawns(ctx: MirrorPassCtx): void {
  // Smooth-beam (2026-05-22): drain scheduled visual damage-number
  // spawns whose time has come. See `_scheduledDamageSpawns` field
  // declaration for the why; the splits are seeded inside
  // `sendFire` per predicted hit, share one `clientShotId`, and ride
  // the existing pendingDamageNumbers pipeline (which DamageNumberManager
  // drains in its own update() — cancelByTag on a mispredict cancels
  // ALREADY-SPAWNED numbers; the loop below also evicts not-yet-due
  // entries for the cancelled tag so a misprediction never produces
  // a delayed visual after the rollback). Bounded array (max ~5 ×
  // active predictions); the `cancelScheduledDamageSpawnsByTag`
  // hook is invoked from the existing reconcile path.
  if (ctx.scheduledDamageSpawns.length > 0) {
    const now = ctx.clock.now();
    const pending = ctx.mirror.pendingDamageNumbers;
    // Iterate from the tail so splice() is O(1) and ordering is
    // preserved for the kept entries.
    for (let i = ctx.scheduledDamageSpawns.length - 1; i >= 0; i--) {
      const s = ctx.scheduledDamageSpawns[i]!;
      if (s.atMs <= now) {
        pending?.push({ targetId: s.targetId, x: s.x, y: s.y, damage: s.damage, tag: s.tag });
        ctx.scheduledDamageSpawns.splice(i, 1);
        // Probe 4 (mobile-perf-investigation, 2026-05-24) — log spawn
        // separately from schedule. Previously `damage_number_predicted`
        // fired at SCHEDULE time, making it look like 5 damage numbers
        // spawned simultaneously per shot (confusing the "laser damage
        // applying inconsistently" investigation). Now schedule fires
        // once per shot with `count`, and spawn fires per actual emit
        // with `lateMs` (time between scheduled `atMs` and actual spawn
        // — measures how late the drain ran).
        logEvent('damage_number_spawned', {
          damage: s.damage,
          tag: s.tag,
          lateMs: parseFloat((now - s.atMs).toFixed(2)),
        });
      }
    }
  }
}

/** `updateMirror` pass: the local ship's drawn pose (prediction + dead-reckon
 *  + lerp), its placement ghost, and the local-pose diagnostics. */
export function updateLocalShipMirror(ctx: MirrorPassCtx, frameNowMs: number | undefined, localId: string | null): void {
  // Local ship — prediction + lerp correction.
  if (localId && ctx.predWorld && ctx.reconciler) {
    const state = ctx.predWorld.getShipState(localId);
    if (state) {
      const ox = ctx.reconciler.lerpOffset.x;
      const oy = ctx.reconciler.lerpOffset.y;
      const oa = ctx.reconciler.lerpAngleOffset;
      ctx.reconciler.advanceLerp(ctx.lastFrameMs);

      // Render-jitter-fix Phase 1 (2026-05-21): dead-reckon the
      // rendered pose forward by `(clock.now() - _lastLocalTickAtMs) ×
      // velocity` so 0-step RAFs show smooth motion instead of a
      // frozen pose. The pre-fix renderer composed `predWorld + lerp`
      // each RAF — but on a 90 Hz mobile display with 60 Hz physics,
      // some RAFs fire without advancing a physics tick, so the
      // rendered pose was identical to the prior frame. Cluster of
      // 0-step RAFs = sprite holds for 3-5 display frames = user-
      // perceived "stop-start" jitter. Locked by `assertFramePacingSmooth`
      // on the 2q0jxw capture.
      //
      // Dead-reckon dt is capped at DEAD_RECKON_CAP_MS (~2 ticks) to avoid wild
      // extrapolation across multi-second stalls (tab background,
      // OS process reap) — those become discrete "freeze events"
      // visually, not glide-overshoot artifacts.
      //
      // When the next physics tick fires, `state.x` will equal
      // `prev_state.x + vx × dt + accel × dt²/2` ≈ the dead-reckoned
      // pose (acceleration term is sub-pixel for typical ship
      // accelerations over 16.7 ms), so the transition from dead-
      // reckon to authoritative tick is visually continuous.
      // From the frame's timestamp; a tick that fell due after the frame
      // started (during this frame's work) makes it slightly negative, i.e.
      // the pose a fraction of a tick before the state: still continuous.
      const tickElapsedMs = ctx.lastLocalTickAtMs >= 0
        ? Math.max(-DEAD_RECKON_BACK_MS, Math.min(DEAD_RECKON_CAP_MS, ctx.gameClock.at(frameNowMs ?? ctx.clock.now()) - ctx.lastLocalTickAtMs))
        : 0;
      const dtSec = tickElapsedMs / 1000;
      const drX = state.x + state.vx * dtSec;
      const drY = state.y + state.vy * dtSec;
      const drAngle = state.angle + (state.angvel ?? 0) * dtSec;

      // Preserve non-spatial fields across per-frame rewrites so the
      // renderer keeps drawing the correct silhouette and the local-
      // turret rotation state survives the per-frame mirror rebuild.
      // `kind` was the first such field; `displayName` follows the same
      // pattern; `mountAngles` (Phase 4b.2) is critical — `tickLocalMountAim`
      // writes it on the same frame and `updateLiveBeam` re-derives the
      // beam geometry from it, so wiping it here makes the visible beam
      // flip back to baseAngle every render frame (visible bug: a solid
      // unrotated beam under the flickering correctly-rotated ghost).
      // Probe 7 (mobile-perf-investigation, 2026-05-24) — mutate
      // the existing entry in place instead of allocating a new
      // object literal per RAF. Non-spatial fields (`kind`,
      // `displayName`, `mountAngles`) are PRESERVED by not touching
      // them — they were written previously by `syncMirror` (kind/
      // displayName) and `tickLocalMountAim` (mountAngles) and stay
      // on the entry across rebuilds. Pre-fix the conditional-spread
      // pattern allocated 2-4 objects per ship per RAF, ~9000
      // allocations/sec at 25 in-interest entities. Pooling eliminates
      // these allocations entirely after the first-spawn create.
      let entry = ctx.mirror.ships.get(localId);
      if (!entry) {
        entry = {
          x: drX + ox,
          y: drY + oy,
          vx: state.vx,
          vy: state.vy,
          angle: drAngle + oa,
        };
        ctx.mirror.ships.set(localId, entry);
      } else {
        entry.x = drX + ox;
        entry.y = drY + oy;
        entry.vx = state.vx;
        entry.vy = state.vy;
        entry.angle = drAngle + oa;
      }
      // Warp-to (#16): the local ship shows its PREDICTED phase (others take
      // the snapshot's), so the build-up starts on the frame the pilot asks.
      {
        const wp = ctx.predWorld ? ctx.predWorld.warpPhase(localId) : 'idle';
        // A sector transit's spool shows the same build-up.
        const w = wp === 'spool' || (wp === 'idle' && useUIStore.getState().transitState === 'SPOOLING') ? 1
          : wp === 'cruise' ? 2 : undefined;
        if (entry.warp !== w) entry.warp = w;
      }

      // Structure placement ghost preview (smoke handoff 2026-06-06, Issue 5;
      // post-Confirm "pending" ghost added playtest 2026-06-10 Issue 7). The
      // live (positioning) ghost is anchored to the RENDERED local-ship pose
      // (the same dead-reckoned + lerp pose the sprite is drawn at) so it
      // tracks the ship; the dim "pending" ghost sits at the sent point until
      // the structure lands (slice count grows) or times out — bridging the
      // RTT+snapshot gap where the blueprint used to vanish. Spatial pose →
      // render mirror, NOT Zustand (#2 — only the discrete `placementKind` id
      // lives in Zustand). The resolver reuses `computePlacementPose` so the
      // live ghost lands EXACTLY where Confirm sends (no preview/commit drift).
      const placementKind = useUIStore.getState().placementKind;
      const ship = ctx.placementShipScratch;
      ship.x = entry.x;
      ship.y = entry.y;
      ship.angle = entry.angle;
      // R2.1 — a structure RENDERS only when its entityId has a swarm pose
      // (mirror.swarm, kind 2); the JSON structures slice that grows the count
      // arrives on a SEPARATE channel. The pending ghost must persist until the
      // structure is actually renderable (every slice entry has a swarm pose),
      // not merely until the slice count grew, or it vanishes for the channel
      // gap. Computed alloc-free (Map keys() iterator, reused maps) and ONLY
      // while a placement is pending — the common no-pending frame pays nothing.
      let allRenderable = true;
      if (ctx.pendingPlacement) {
        const structs = ctx.mirror.structures;
        const sw = ctx.mirror.swarm;
        if (structs && structs.size > 0) {
          if (!sw) {
            allRenderable = false;
          } else {
            for (const id of structs.keys()) {
              if (!sw.has(id)) {
                allRenderable = false;
                break;
              }
            }
          }
        }
      }
      const placementStatus = resolvePlacementPreviewStatus(
        placementKind,
        placementKind ? ship : null,
        ctx.pendingPlacement,
        Date.now(),
        ctx.mirror.structures?.size ?? 0,
        allRenderable,
        ctx.placementPreviewScratch,
      );
      if (placementStatus === 'active' || placementStatus === 'pending') {
        ctx.mirror.pendingPlacementPreview = ctx.placementPreviewScratch;
      } else {
        if (placementStatus === 'cleared') ctx.pendingPlacement = null;
        if (ctx.mirror.pendingPlacementPreview) ctx.mirror.pendingPlacementPreview = null;
      }

      // Replay-grade per-RAF rendered-pose capture (plan: replay infra
      // Phase A, 2026-05-21). This is the EXACT position+angle the
      // renderer will draw this frame — dead-reckoned predWorld +
      // lerpOffset. The GROUND TRUTH for the on-device user experience
      // and the basis for `assertFramePacingSmooth` (plan: render-
      // jitter-fix Phase 0a) and `assertNoTeleport`.
      // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). `logEvent`
      // would discard this in production but the object literal was
      // being built per-RAF regardless. Gate at the callsite so the
      // literal is never even allocated on a production session.
      if (isFullDiagMode()) {
        logEvent('local_pose_rendered', {
          inputTick: ctx.inputTick,
          x: Math.round((drX + ox) * 1000) / 1000,
          y: Math.round((drY + oy) * 1000) / 1000,
          angle: Math.round((drAngle + oa) * 10000) / 10000,
          lerpOffsetX: Math.round(ox * 1000) / 1000,
          lerpOffsetY: Math.round(oy * 1000) / 1000,
          lerpAngleOffset: Math.round(oa * 10000) / 10000,
        });
      }

      // 2026-05-28 — Ramming probe: per-frame snapshot of all the
      // pose surfaces that could contribute to visual-vs-physics
      // divergence during a player ↔ drone collision. Logged ONLY
      // when the player is within 400 u of the nearest drone (the
      // only situation where the gap matters — otherwise this
      // would flood the diag at 60 Hz). Used by
      // `tests/e2e/ramming-probe-armpit.spec.ts` and on-device
      // smoke captures to diagnose the 2026-05-28 "fly inside the
      // T-ship" report (user observation: speed-dependent visible
      // penetration into the rendered hull silhouette).
      //
      // TODO: alloc-debt (Invariant #14) — this block runs every
      // frame within 1500 u of any drone and builds a ~12-field
      // diagnostic object literal that feeds `logEvent`. Should be
      // gated on `isFullDiagMode()` so production never allocates
      // here. Deferred per fuzzy-gray integration plan; sweep with
      // `grep -rn 'TODO: alloc-debt' src/` follow-up.
      //
      // Captured surfaces:
      //   - physPos     : local player predWorld position (collider).
      //   - physVel/Spd : predWorld velocity (drives dead-reckon).
      //   - visPos      : what the renderer DRAWS (= drX + ox).
      //   - drOffset    : dead-reckon contribution = vel × dtSec.
      //   - lerpOffset  : reconciliation smoothing residue (ox, oy).
      //   - dronePos    : drone's interpolated/rendered position
      //                   (same value the kinematic-follower will
      //                   write to predWorld this frame).
      //   - physDist    : center-to-center physics distance.
      //   - visDist     : center-to-center visual distance.
      //   - visVsPhys   : |visDist − physDist| — pure visual vs
      //                   physics divergence, the smoking-gun
      //                   number for "I see myself inside but
      //                   physics says I'm not". Always ≥ 0.
      //
      // Gated on isRammingProbeEnabled() (2026-05-29, plan: lazy-mochi
      // — supersedes the 2026-05-28 isFullDiagMode() gate). Capture
      // ilhqk6 surfaced the unconditional alloc cost; b7b18d1 gated it
      // on isFullDiagMode but Playwright auto-enables diag via
      // navigator.webdriver, so every E2E spec that touches drones
      // (combat-heap-growth, heap-growth-gate, every netgate rep,
      // every smoke spec) still paid the ~12-field nested literal
      // per RAF — driving updateMirror's share of CDP-sampled
      // allocation from 4.6 % on main to 15.1 % on integration HEAD
      // (lazy-mochi P2). Opt-in via `?probe=ram` only; the ramming-
      // probe-armpit.spec.ts sets it explicitly. No E2E that isn't
      // investigating ramming behaviour pays anything now.
      if (isRammingProbeEnabled() && ctx.mirror.swarm) {
        let nearestId = -1;
        let nearestDx = 0;
        let nearestDy = 0;
        let nearestDistSq = Infinity;
        for (const [entityId, entry] of ctx.mirror.swarm) {
          if (entry.kind !== 1) continue;
          const dx = entry.x - state.x;
          const dy = entry.y - state.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < nearestDistSq) {
            nearestDistSq = distSq;
            nearestId = entityId;
            nearestDx = dx;
            nearestDy = dy;
          }
        }
        // 1500 u threshold accommodates gigantic test ships like the
        // L-shape (polygon extent ~2000 from body center). For normal
        // gameplay this still filters out most far-off drones — only
        // ones the player could plausibly collide with get logged.
        if (nearestId >= 0 && nearestDistSq < 1500 * 1500) {
          const droneEntry = ctx.mirror.swarm.get(nearestId);
          if (droneEntry) {
            const physDist = Math.sqrt(nearestDistSq);
            const visDx = (drX + ox) - droneEntry.x;
            const visDy = (drY + oy) - droneEntry.y;
            const visDist = Math.sqrt(visDx * visDx + visDy * visDy);
            const physSpd = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
            void nearestDx; void nearestDy; // diagnostics: relative direction kept here for callsites that need it
            logEvent('ramming_probe', {
              inputTick: ctx.inputTick,
              physPos: {
                x: Math.round(state.x * 1000) / 1000,
                y: Math.round(state.y * 1000) / 1000,
              },
              physVel: {
                x: Math.round(state.vx * 1000) / 1000,
                y: Math.round(state.vy * 1000) / 1000,
              },
              physSpd: Math.round(physSpd * 10) / 10,
              visPos: {
                x: Math.round((drX + ox) * 1000) / 1000,
                y: Math.round((drY + oy) * 1000) / 1000,
              },
              drOffset: {
                x: Math.round((drX - state.x) * 1000) / 1000,
                y: Math.round((drY - state.y) * 1000) / 1000,
              },
              lerpOffset: {
                x: Math.round(ox * 1000) / 1000,
                y: Math.round(oy * 1000) / 1000,
              },
              droneId: nearestId,
              dronePos: {
                x: Math.round(droneEntry.x * 1000) / 1000,
                y: Math.round(droneEntry.y * 1000) / 1000,
              },
              droneShieldDown: droneEntry.shieldDown ?? false,
              droneKind: droneEntry.shipKind ?? null,
              physDist: Math.round(physDist * 100) / 100,
              visDist: Math.round(visDist * 100) / 100,
              visVsPhys: Math.round(Math.abs(visDist - physDist) * 100) / 100,
              // 2026-05-28 contact-state probe — directly ask Rapier what
              // the resolver produced THIS tick for the player ball:
              //   - normal       : world-space normal the resolver chose
              //                    to push the player along (should point
              //                    AWAY from the polygon edge).
              //   - penetration  : Rapier's own measured overlap (negative
              //                    contactDist, in world units). If this
              //                    matches the body-local penetration we
              //                    compute geometrically, the resolver is
              //                    SEEING the overlap correctly. If the
              //                    resolver reports 0 while we measure 20u
              //                    geometrically, the contact isn't even
              //                    being generated → polygon decomposition
              //                    seam problem.
              //   - impulse      : the impulse magnitude applied this step.
              //                    If thrust = 9000 N and impulse < 9000,
              //                    the resolver is under-pushing → param /
              //                    iteration count too low.
              //   - contactCount : number of contact points (multi-edge =
              //                    concave-corner contact).
              //   - otherBodyId  : which body the player is contacting
              //                    (sanity-check it's a swarm drone, not
              //                    something else).
              contactState: ctx.predWorld.queryContactState(localId) ?? null,
            });
          }
        }
      }

      // Diagnostic — track swarm entities entering/leaving overlap range.
      // The user reported "overlapping with enemy ships" (drones, since
      // ship-on-ship interactions wouldn't show in single-player rooms).
      // We log entry/exit events for any swarm entity within
      // SWARM_OVERLAP_LOG_DIST of the local ship's RENDERED position
      // (mirror, includes lerp). Entry and exit are logged with both
      // the rendered local position AND the predWorld position so we
      // can tell if the overlap is real (predWorld distance also small)
      // or render-only (predWorld distance fine, lerp pulled the sprite).
      if (ctx.mirror.swarm) {
        const renderedX = state.x + ox;
        const renderedY = state.y + oy;
        const SWARM_OVERLAP_LOG_DIST = 100; // ~ ship radius + drone radius + buffer
        // 2026-05-25 heap-growth gate step 2: two-Set swap.
        const nowNear = ctx.swarmNearbySwapScratch;
        nowNear.clear();
        for (const [entityId, entry] of ctx.mirror.swarm) {
          const dx = entry.x - renderedX;
          const dy = entry.y - renderedY;
          if (dx * dx + dy * dy < SWARM_OVERLAP_LOG_DIST * SWARM_OVERLAP_LOG_DIST) {
            nowNear.add(entityId);
            if (!ctx.swarmNearbyIds.has(entityId)) {
              logEvent('swarm_near_enter', {
                entityId,
                kind: entry.kind,
                swarmPos: {
                  x: parseFloat(entry.x.toFixed(2)),
                  y: parseFloat(entry.y.toFixed(2)),
                },
                rendered: {
                  x: parseFloat(renderedX.toFixed(2)),
                  y: parseFloat(renderedY.toFixed(2)),
                },
                predWorld: {
                  x: parseFloat(state.x.toFixed(2)),
                  y: parseFloat(state.y.toFixed(2)),
                },
                lerpOffset: {
                  x: parseFloat(ox.toFixed(2)),
                  y: parseFloat(oy.toFixed(2)),
                },
                distRendered: parseFloat(Math.sqrt(dx * dx + dy * dy).toFixed(2)),
              });
            }
          }
        }
        for (const oldId of ctx.swarmNearbyIds) {
          if (!nowNear.has(oldId)) {
            logEvent('swarm_near_exit', { entityId: oldId });
          }
        }
        const oldActive = ctx.swarmNearbyIds;
        ctx.swarmNearbyIds = nowNear;
        ctx.swarmNearbySwapScratch = oldActive;
      }
    }
  }
}
