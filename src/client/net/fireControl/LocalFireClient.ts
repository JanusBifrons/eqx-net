/**
 * The local ship's own fire (#19): `sendFire` (the `fire` send, predicted
 * ghosts, energy drain and hit prediction for one trigger) and the continuous
 * hitscan beam (`updateLiveBeam`, recast from the RENDERED pose every frame).
 * `FireControlClient.fcFireTick` decides WHEN to fire and calls these through
 * `FireControlHost`; `ColyseusClient` owns one and keeps one-line delegates.
 * Fire ticks feed prediction, so call order matches the pre-split code.
 * Allocation: unchanged from the inline code (#14; `sendFire`'s per-trigger
 * `mountGeom` / sink are low-cadence, at most once per cooldown).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { PhysicsWorld } from '@core/physics/World';
import type { Reconciler } from '@core/prediction/Reconciler';
import type { HitPredictionLedger } from '@core/combat/HitPrediction';
import { HITSCAN_RANGE, beamHalfWidth } from '@core/combat/Weapons';
import { shipShotMuzzle } from '@core/combat/muzzle';
import { mountRangeFactor } from '@core/combat/mountReach';
import { getWeapon, isMiningTool } from '@core/combat/WeaponCatalogue';
import { spendEnergy, resolveSlotEnergyCost } from '@core/combat/Energy';
import { tuningFor } from '@shared-types/shipScale/lookup';
import { resolveInstanceMounts, resolveInstanceFireMounts } from '@shared-types/shipKinds/slots';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';
import { predictShotOutcome, type PredictedFeedbackSink, type MountFireGeom } from '../../combat/HitPrediction.client';
import { localFireSpawnsGhost, localFirePredicts } from '../../combat/LocalBeam';
import type { GhostManager } from '../../combat/GhostProjectile';
import type { DisplayPoseHitscan } from '../../combat/displayPoseHitscan.js';
import { beamOptimalDist, beamMaxDist, beamNoHitSolidDist } from '../../combat/beamBands.js';
import { beamShieldEdgeDist } from '../../combat/remoteBeamRay.js';
import { mountMuzzleRay, type MuzzleRay } from '../../render/beamStyles';
import { useUIStore } from '../../state/store';
import { logEvent, isGhostProbeEnabled } from '../../debug/ClientLogger';
import { isNoDamageNumberTarget } from '../damageNumberTargets.js';
import type { FireControlClient } from '../FireControlClient';
import type { ScheduledDamageSpawn } from '../mirror/mirrorPassCtx.js';

/** Simple monotonically incrementing shot ID generator. */
let _shotCounter = 0;
function nextShotId(): string {
  return `shot-${_shotCounter++}`;
}

/** What local fire reads from / writes on `ColyseusClient`. Built ONCE (#14):
 *  reassigned fields are getters (`predEnergy` also a setter). */
export interface LocalFireHost {
  readonly mirror: RenderMirror;
  readonly predWorld: PhysicsWorld | null;
  readonly room: Room | null;
  readonly reconciler: Reconciler | null;
  readonly fc: FireControlClient;
  readonly ghostManager: GhostManager;
  readonly clock: Clock;
  predEnergy: number;
  readonly scheduledDamageSpawns: ScheduledDamageSpawn[];
  readonly damageFlashFrames: Map<string, number>;
  readonly hitLedger: HitPredictionLedger;
  /** `?nohitscan=1`: skip the per-mount visual ray cast. */
  readonly skipHitscanVisual: boolean;
  /** The beam / hit-prediction ray world (live predWorld + swarm mirror). */
  displayHitscan(): DisplayPoseHitscan;
}

export class LocalFireClient {
  constructor(private readonly h: LocalFireHost) {}

  /** Per-frame scratch for `updateLiveBeam` (cleared at the top of each call). */
  private readonly _liveBeamMountIdsScratch = new Set<string>();
  private readonly _liveRayScratch: MuzzleRay = { fromX: 0, fromY: 0, fwdX: 0, fwdY: 0 };

  /** Compute (and cache in `mirror.liveBeams`) the local player's hitscan
   *  beam state — one entry per mount in the firing slot. Multi-mount/turret
   *  refactor (Phase 2c): replaces the pre-2c single `liveBeam` write. For
   *  legacy single-mount ships the map has exactly one entry keyed by
   *  `'forward'`; multi-mount kinds (interceptor / gunship, Phase 3) get one
   *  entry per barrel so each renders independently.
   *
   *  Mount origin = `ship.pos + rotate(mount.local, ship.angle)`. Mount fire
   *  direction = `ship.angle + mount.baseAngle + currentMountAngle` (4b.2
   *  adds rotation; pre-4b.2 the current angle was always 0). The 20 u
   *  barrel offset is applied along the mount's world fire direction. */
  updateLiveBeam(): void {
    const localId = this.h.mirror.localPlayerId;
    if (!localId || !this.h.predWorld) return;
    // Cast the visual beam from the SAME rendered (mirror) pose the
    // renderer draws it from (PixiRenderer `applyMountOffset(ship.x/y/angle)`
    // + `mirror.liveBeams[mount].dist`), NOT the raw predWorld pose. The
    // predicted pose lags the mirror by the reconciler lerp offset (up to
    // ~45 u during a correction), so casting `dist` from predWorld made it
    // belong to a different ray than the one drawn — the far endpoint
    // popped frame-to-frame (laser detach/jitter; on-device capture
    // 2026-06-02T15-04-54Z-e628gi). Locked by
    // ColyseusClient.liveBeamPose.test.ts.
    const ship = this.h.mirror.ships.get(localId);
    // The predWorld body is the collision world the ray is cast INTO; it
    // must still exist, but its POSE is not used for the beam geometry.
    if (!ship || !this.h.predWorld.getShipState(localId)) return;

    const liveBeams = (this.h.mirror.liveBeams ??= new Map());
    const mounts = this.localShipMounts();
    if (mounts.length === 0) {
      // Defensive: ship-kind has no mounts. Clear any stale beams.
      liveBeams.clear();
      return;
    }

    // ?nohitscan=1 — A/B switch to bypass the per-mount-per-frame Rapier
    // ray cast against predWorld. Beam length defaults to full
    // HITSCAN_RANGE (beams visually shoot through everything). The
    // hitscan is suspected of being a non-trivial per-frame cost under
    // heavy combat (35 drones × 1 cast against 40+ bodies). PURE
    // VISUAL test; server-authoritative hit resolution is unaffected.
    const skipHitscan = this.h.skipHitscanVisual;

    // Drop entries for mounts no longer present (e.g. ship-kind changed
    // mid-life — currently impossible but cheap to guard).
    // A capital group fires each turret only while it bears (`fcFireMounts`):
    // a turret aimed away draws no beam (it once drew one to max range).
    const bearingOnly = this.h.fc._fcPerMount && this.h.fc._fireSlotOverride !== null;
    const mountIds = this._liveBeamMountIdsScratch;
    mountIds.clear();
    for (const m of mounts) if (!bearingOnly || this.h.fc._fcBearing.has(m.id)) mountIds.add(m.id);
    for (const id of liveBeams.keys()) if (!mountIds.has(id)) liveBeams.delete(id);

    const mountAngles = ship.mountAngles;
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      if (!mountIds.has(mount.id)) continue;
      const angleIdx = this.instanceMountIndex(ship.kind, ship.activatedMounts, mount.id);
      const currentMountAngle = angleIdx >= 0 ? (mountAngles?.[angleIdx] ?? 0) : 0;
      // The shared muzzle maths (beamStyles `mountMuzzleRay`), as the remote heavy beam's ray.
      const r = mountMuzzleRay(ship.x, ship.y, ship.angle, mount, currentMountAngle, this.localMuzzle(mount), this._liveRayScratch);
      const fromX = r.fromX, fromY = r.fromY, fwdX = r.fwdX, fwdY = r.fwdY;
      // P3.13 / campaign 5.2 — the beam bands DERIVE from the catalogue def
      // via the unit-locked `beamBands` seam (the SAME numbers the server
      // damage falloff reads, so the visible taper == the damage band by
      // construction). SOLID to optimal (== the aim guide), fading to nothing
      // across optimal→max. Alloc-free: cached lookup + scalar helpers (#14).
      const wdef = getWeapon(mount.weaponId);
      const rangeMul = mountRangeFactor(mount.weaponId, mount.size); // a mining tool's sized beam, as the server ray
      const optimalDist = beamOptimalDist(wdef, rangeMul);
      const beamMax = beamMaxDist(wdef, rangeMul);
      // Remote drones/scrap are tested at their DRAWN pose (the pose the
      // turret aims at), not their predicted-timeline body.
      const hit = skipHitscan ? null : this.h.displayHitscan().hitscan(fromX, fromY, fwdX, fwdY, beamMax, localId, beamHalfWidth(wdef), isMiningTool(mount.weaponId));
      // `?probe=ghost` diagnostic (laser "ghost at (0,0)" investigation,
      // 2026-06-03). When the beam stops on a body whose pose is within
      // ε of world origin, log the hitId — its namespace prefix names the
      // culprit class (`swarm-`/raw playerId or shipInstanceId). Gate is
      // cached + webdriver-OFF, so production / E2E / netgate allocate
      // nothing here; the object literal is only built on a rare actual
      // origin-hit while the probe is on. Confirms the lingering-hull fix
      // on-device (and would surface any OTHER origin-body path).
      if (isGhostProbeEnabled() && hit) {
        const hitPose = this.h.predWorld.getShipState(hit.hitId);
        if (hitPose && Math.abs(hitPose.x) < 2 && Math.abs(hitPose.y) < 2) {
          logEvent('beam_hit_origin', { hitId: hit.hitId, x: hitPose.x, y: hitPose.y });
        }
      }
      // Clipped at a real hit ⇒ solid all the way to the target (solidDist===dist,
      // no fade). No hit ⇒ draw to max with the solid part capped at the optimal
      // range and a fade beyond it to nothing.
      const drawDist = hit ? this.shieldEdgeDist(hit, fromX, fromY, fwdX, fwdY, beamMax, beamHalfWidth(wdef)) : beamMax;
      liveBeams.set(mount.id, {
        dist: drawDist,
        // No hit ⇒ the SOLID core is only VISUAL_BEAM_SOLID_FRAC of the optimal
        // range so the beam fades over a long, gradual tail to nothing at maxRange
        // (visual taper only — never affects damage). A hit stays solid to target.
        solidDist: hit ? drawDist : beamNoHitSolidDist(optimalDist, drawDist),
        hitId: hit?.hitId,
      });
    }
  }

  /**
   * Snap the visible beam endpoint to the rendered SHIELD ring when the
   * ray stops on a shield-up target (2026-06-03). The shield collider IS
   * `targetRadius + SHIELD_RADIUS_PAD` — the same radius the cyan aura is
   * drawn at — but the predWorld collider can lag the shield by one
   * physics step right after a shield 0-cross or a drone's first
   * in-interest tick (Rapier query-pipeline lag), so the raw
   * `timeOfImpact` makes the endpoint pop slightly off the aura edge.
   * Recomputing the distance to the shield sphere ANALYTICALLY guarantees
   * the beam terminates exactly on the ring. Returns the predWorld dist
   * unchanged for a shield-DOWN/hull hit, an asteroid, or a miss.
   * A wide beam (`halfWidth`, the heavy beam) meets the ring grown by its half-width (#15).
   * Allocation-free — `rayHitsSphere` is pure scalar (Invariant #14).
   */
  shieldEdgeDist(
    hit: { hitId: string; dist: number },
    fromX: number, fromY: number, fwdX: number, fwdY: number,
    maxRange: number = HITSCAN_RANGE, halfWidth = 0,
  ): number {
    return beamShieldEdgeDist(this.h.mirror, hit, fromX, fromY, fwdX, fwdY, maxRange, halfWidth);
  }

  /** Resolve the local player's currently-active slot's mount list. Returns
   *  the first slot's mounts when no `slotId` is in play (today's only path;
   *  multi-slot UI lands in a future phase). Empty array if the ship-kind
   *  has no mounts/slots or the local player hasn't joined yet. */
  /** Where the local ship's shot leaves a mount: the barrel tip of a turning
   *  turret, else the shared clearance — the SAME function the server's
   *  PlayerFireResolver uses (core/combat/muzzle.ts, invariant #15). */
  private localMuzzle(mount: WeaponMount): number {
    const kind = getShipKind(this.h.mirror.ships.get(this.h.mirror.localPlayerId ?? '')?.kind ?? null);
    return shipShotMuzzle(kind, mount);
  }

  // Per-instance mount list cache (kind + activated-mounts identity), so the
  // per-frame index lookup below never re-resolves or allocates (#14).
  private _instMountsKind: string | null | undefined = undefined;
  private _instMountsAct: unknown = undefined;
  private _instMounts: ReadonlyArray<WeaponMount> = [];

  /**
   * Index of `mountId` in the ship's full per-instance mount list
   * (`[...kind.mounts, ...activated]`) — the index space `mountAngles` is
   * written in on both sides. The fire set is a SUBSET/REORDER of that list
   * once a ship has several weapon groups, so reading `mountAngles[i]` by
   * fire-set position aimed the wrong barrel (exp/fire-control P0).
   */
  private instanceMountIndex(kindId: string | null | undefined, activated: unknown, mountId: string): number {
    if (kindId !== this._instMountsKind || activated !== this._instMountsAct) {
      this._instMountsKind = kindId;
      this._instMountsAct = activated;
      this._instMounts = resolveInstanceMounts(getShipKind(kindId ?? null), activated as Parameters<typeof resolveInstanceMounts>[1]);
    }
    const list = this._instMounts;
    for (let i = 0; i < list.length; i++) if (list[i]!.id === mountId) return i;
    return -1;
  }

  localShipMounts(): ReadonlyArray<WeaponMount> {
    const localId = this.h.mirror.localPlayerId;
    if (!localId) return [];
    const ship = this.h.mirror.ships.get(localId);
    const kindId = ship?.kind ?? null;
    // Active-slot mounts (weapons/energy/AI overhaul §5.2) PLUS any WS-B3
    // activated latent mounts (they always fire). The pilot selects the slot;
    // the server fires each mount's bound weapon. Same shared resolver the
    // server uses (resolveInstanceFireMounts) so client ghost geometry matches.
    // Un-upgraded ⇒ exactly the active slot (byte-identical).
    return resolveInstanceFireMounts(getShipKind(kindId), ship?.activatedMounts, this.h.fc._fireSlotOverride ?? useUIStore.getState().activeSlotId);
  }

  sendFire(tick: number): void {
    const localId = this.h.mirror.localPlayerId;
    if (!localId || !this.h.predWorld || !this.h.room) return;
    const state = this.h.predWorld.getShipState(localId);
    if (!state) return;
    const activeSlotId = this.h.fc._fireSlotOverride ?? useUIStore.getState().activeSlotId;
    const shotId = nextShotId();

    // Multi-mount/turret refactor (Phase 3 fix-up): spawn one ghost per mount
    // in the active slot, at each mount's world origin. Pre-fix the single
    // ghost spawned at `state.x/y + 20 u forward` rendered a third visual
    // between the two wing beams on the interceptor (and similarly between
    // the gunship's fore/aft mounts) because the ghost sat at the ship
    // centre rather than at the firing barrel. All N ghosts share one wire
    // `clientShotId` (shotGroup) so the single `hit_ack` fades the whole
    // salvo together.
    const mounts = this.localShipMounts();
    // Each barrel fires its catalogue-bound weapon (slots are homogeneous
    // today, so the first mount's weapon sets the salvo's ghost sprite + the
    // hitscan/projectile branch). Replaces the removed client weapon picker.
    const slotWeapon = mounts[0]?.weaponId ?? 'hitscan';
    const cosA = Math.cos(state.angle);
    const sinA = Math.sin(state.angle);
    const localShip = this.h.mirror.ships.get(localId);
    const mountAngles = localShip?.mountAngles;
    // weapon-hit-prediction Phase 2 — collect each mount's fire ray
    // (identical geometry to the ghost spawn) so the predicted-hit
    // resolver can aggregate the closest mount-hit, exactly as the server
    // aggregates its hit_ack.
    const mountGeom: MountFireGeom[] = [];
    // beam-attach fix (capture 2026-05-19T10-55-36-274Z-pe6rdt): a LOCAL
    // hitscan fire spawns NO ghost. The continuous liveBeam — recomputed
    // from the ship's RENDERED pose (`mirror.ships`) every frame — is the
    // sole local hitscan visual, so it is rigidly ship-attached and
    // server lag/correction is invisible. A ghost frozen at this
    // input-tick `predWorld` sample is the redundant layer that visibly
    // detached from the ship under lag. Projectiles still ghost — the
    // bolt actually travels. `mountGeom` is collected regardless (the
    // predicted-hit resolver still needs every mount's ray).
    // Naval shells are not predicted (no ghost, no instant hit): they reach
    // the client as shell_salvo events and fly for tens of seconds.
    const spawnGhost = localFireSpawnsGhost(getWeapon(slotWeapon).mode) && localFirePredicts(slotWeapon);
    if (mounts.length === 0) {
      // Defensive fallback: no mounts → (projectile only) spawn the
      // legacy single ghost at ship centre. Should not happen for any
      // shipped kind today.
      const fwdX = -Math.sin(state.angle);
      const fwdY = Math.cos(state.angle);
      const clear = tuningFor(this.h.mirror.ships.get(localId)?.kind).muzzleClearance;
      const fromX = state.x + fwdX * clear;
      const fromY = state.y + fwdY * clear;
      if (spawnGhost) {
        this.h.ghostManager.spawn(shotId, localId, fromX, fromY, fwdX, fwdY, slotWeapon, state.vx, state.vy);
      }
      mountGeom.push({ fromX, fromY, fwdX, fwdY });
    } else {
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        const mountWorldX = state.x + (mount.localX * cosA - mount.localY * sinA);
        const mountWorldY = state.y + (mount.localX * sinA + mount.localY * cosA);
        // Phase 4b.2: include the per-mount slewed angle in the fire
        // direction so the ghost emerges in the same direction the
        // visible barrel is aimed.
        const localShip = this.h.mirror.ships.get(localId);
        const angleIdx = this.instanceMountIndex(localShip?.kind, localShip?.activatedMounts, mount.id);
        const currentMountAngle = angleIdx >= 0 ? (mountAngles?.[angleIdx] ?? 0) : 0;
        const mountFireAngle = state.angle + mount.baseAngle + currentMountAngle;
        // Fire control: the server fires only mounts that bear on their lock,
        // so a mount that doesn't gets no predicted bolt (the "ghost bolts"
        // from capital turrets still slewing). Same rule, shared (#15).
        if (this.h.fc._fireSlotOverride !== null && !this.h.fc.fcMountBears(mount.id, mount.weaponId, mount.size, mountWorldX, mountWorldY, mountFireAngle)) continue;
        const fwdX = -Math.sin(mountFireAngle);
        const fwdY = Math.cos(mountFireAngle);
        const muzzleD = this.localMuzzle(mount);
        const fromX = mountWorldX + fwdX * muzzleD;
        const fromY = mountWorldY + fwdY * muzzleD;
        if (spawnGhost) {
          this.h.ghostManager.spawn(
            shotId,
            localId,
            fromX,
            fromY,
            fwdX,
            fwdY,
            mount.weaponId,
            state.vx,
            state.vy,
            mount.id,
          );
        }
        mountGeom.push({ fromX, fromY, fwdX, fwdY });
      }
    }

    this.h.room.send('fire', {
      type: 'fire',
      tick,
      clientShotId: shotId,
      weapon: slotWeapon,
      slotId: activeSlotId,
      dirAngle: state.angle,
    });

    // Predict the slot's energy drain (weapons/energy/AI overhaul §3.2):
    // drain ONCE per trigger (not per mount), matching the server. The
    // snapshot reconcile hard-sets predEnergy each frame, so a small
    // mispredict is invisible.
    this.h.predEnergy = spendEnergy(
      this.h.predEnergy,
      resolveSlotEnergyCost(getShipKind(this.h.mirror.ships.get(localId)?.kind ?? null), activeSlotId),
    );

    // Stamp the wall-clock fire time into Zustand (`lastFireMs`) for the
    // HUD's cooldown readouts.
    // Low-cadence — at most every cooldown interval (167 ms hitscan to
    // 3 s heat-seeker) — so the Zustand notification cost is bounded.
    useUIStore.getState().setLastFireMs(this.h.clock.now());

    // weapon-hit-prediction Phase 2 — predict the outcome against the pose
    // the player SEES (predWorld.hitscan, the exact seam updateLiveBeam
    // uses; NO client lag-comp ring) and show immediate tagged feedback.
    // Presentation-only: the server stays 100% hit-authoritative. The
    // prediction just TTL-expires until Phase 3 wires the single
    // hit_ack/DamageEvent reconcile path. Mode/damage read off the
    // catalogue def (no weapon-id branch). Projectile uses the same ray as
    // a straight-flight proxy for the predicted target (decision #2: the
    // bolt itself is untouched and reconciles via the eventual DamageEvent).
    const weaponDef = getWeapon(slotWeapon);
    const predMaxDist =
      weaponDef.mode === 'hitscan'
        ? HITSCAN_RANGE
        : weaponDef.mode === 'projectile'
          ? (weaponDef.speed * weaponDef.maxTicks) / 60
          : (weaponDef.speed * weaponDef.lifetimeTicks) / 60;
    // Smooth-beam visual splitting (2026-05-22). Hitscan: split the
    // predicted damage into N small ticks spread across the cooldown
    // window so the on-screen damage feels continuous; server stays at
    // the original cadence so wire load is unchanged. Projectile keeps
    // the single-spawn behaviour — its bolt is its own visual stream.
    // Splits share one `clientShotId` so cancelByTag /
    // reconcileDamageToFeedback wipe them together on misprediction.
    const isHitscan = weaponDef.mode === 'hitscan';
    const SMOOTH_BEAM_SPLITS = 5;
    const splitIntervalMs = isHitscan
      ? (weaponDef.cooldownTicks / 60) * 1000 / SMOOTH_BEAM_SPLITS
      : 0;
    const scheduledRef = this.h.scheduledDamageSpawns;
    const clockNow = this.h.clock.now();
    const predSink: PredictedFeedbackSink = {
      pushDamageNumber: (targetId, x, y, damage, tag) => {
        // Debris and rocks: never a number (the authoritative path skips them too).
        if (isNoDamageNumberTarget(targetId, this.h.mirror.swarm)) return;
        if (!isHitscan || damage <= 0) {
          this.h.mirror.pendingDamageNumbers?.push({ targetId, x, y, damage, tag });
          // Probe 4 (mobile-perf-investigation, 2026-05-24) — replaced the
          // five-events-at-the-same-ts pattern with one event per shot
          // (schedule) + one event per actual spawn (damage_number_spawned
          // in the drain). `count: 1` here distinguishes the
          // single-spawn projectile/no-damage path from the hitscan
          // split path below.
          logEvent('damage_number_scheduled', {
            tag,
            totalDamage: damage,
            count: 1,
            intervalMs: 0,
            firstSpawnImmediate: true,
          });
          return;
        }
        // Hitscan: schedule N visual ticks. Floor-divide the damage,
        // put the remainder on the last tick so the cumulative shown
        // matches the authoritative damage exactly (reconcile/suppress
        // can then match cleanly).
        const base = Math.floor(damage / SMOOTH_BEAM_SPLITS);
        const remainder = damage - base * SMOOTH_BEAM_SPLITS;
        let actualCount = 0;
        for (let i = 0; i < SMOOTH_BEAM_SPLITS; i++) {
          const tickDamage = i === SMOOTH_BEAM_SPLITS - 1 ? base + remainder : base;
          if (tickDamage <= 0) continue;
          actualCount++;
          if (i === 0) {
            // First tick spawns immediately so the player feels the
            // first hit without any latency.
            this.h.mirror.pendingDamageNumbers?.push({ targetId, x, y, damage: tickDamage, tag });
          } else {
            scheduledRef.push({
              atMs: clockNow + i * splitIntervalMs,
              targetId,
              x, y,
              damage: tickDamage,
              tag,
            });
          }
        }
        // Single per-shot event — the count vs actual `damage_number_spawned`
        // count diff (with `cancelled` subtracted) reveals dropped spawns,
        // which would explain the user-reported "damage applying
        // inconsistently".
        logEvent('damage_number_scheduled', {
          tag,
          totalDamage: damage,
          count: actualCount,
          intervalMs: parseFloat(splitIntervalMs.toFixed(2)),
          firstSpawnImmediate: true,
        });
      },
      flashTarget: (id) => {
        this.h.damageFlashFrames.set(id, 6);
      },
    };
    if (localFirePredicts(slotWeapon)) {
    predictShotOutcome({
      ledger: this.h.hitLedger,
      sink: predSink,
      world: this.h.displayHitscan(),
      clientShotId: shotId,
      mode: weaponDef.mode, halfWidth: beamHalfWidth(weaponDef), passLootPods: isMiningTool(slotWeapon),
      damage: weaponDef.damage,
      mounts: mountGeom,
      maxDist: predMaxDist,
      excludeId: localId,
      nowMs: this.h.clock.now(),
    });
    }
    // Diagnostic — captures the three reference points needed to debug
    // "lasers firing from the wrong place". `spawnPos` is the legacy
    // ship-centre+20-u-forward reference (NOT per-mount post-Phase-3, so
    // the diagnostic stays comparable across single-mount and multi-mount
    // ships); per-mount geometry is reconstructable from `predState` + the
    // ship-kind catalogue if a capture needs it. The visible ship is
    // rendered from `mirror.ships[localId]` which DOES include the
    // reconciler's lerp offset, so `predState` vs `mirrorPose` shows the
    // current divergence. The server's lag-comp validates the shot against
    // the SnapshotRing pose at `tick`, captured in `fire_received`.
    const mirrorPose = this.h.mirror.ships.get(localId);
    const lerpOff = this.h.reconciler?.lerpOffset;
    const lerpAng = this.h.reconciler?.lerpAngleOffset ?? 0;
    const legacyFwdX = -Math.sin(state.angle);
    const legacyFwdY = Math.cos(state.angle);
    logEvent('fire', {
      tick,
      shotId,
      weapon: slotWeapon,
      mountCount: mounts.length,
      predState: {
        x: parseFloat(state.x.toFixed(3)),
        y: parseFloat(state.y.toFixed(3)),
        angle: parseFloat(state.angle.toFixed(4)),
      },
      mirrorPose: mirrorPose ? {
        x: parseFloat(mirrorPose.x.toFixed(3)),
        y: parseFloat(mirrorPose.y.toFixed(3)),
        angle: parseFloat(mirrorPose.angle.toFixed(4)),
      } : null,
      lerpOffset: lerpOff ? {
        x: parseFloat(lerpOff.x.toFixed(3)),
        y: parseFloat(lerpOff.y.toFixed(3)),
        angle: parseFloat(lerpAng.toFixed(4)),
      } : null,
      spawnPos: {
        x: parseFloat((state.x + legacyFwdX * 20).toFixed(3)),
        y: parseFloat((state.y + legacyFwdY * 20).toFixed(3)),
      },
      lerping: this.h.reconciler?.isLerping ?? false,
    });
  }}
