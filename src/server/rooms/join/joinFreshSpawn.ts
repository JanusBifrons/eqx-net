/**
 * Player onJoin — the FRESH SPAWN path (`JoinHandler.handle`'s tail): take a
 * SAB slot, resolve the spawn point (URL / room anchor / scatter, roster
 * shipId-restore, hull gate, landing clearance), seed the SAB + schema +
 * pose cache, apply testMode join overrides, SPAWN the worker body, send
 * `welcome` and register the warp-in handshake (`pendingJoin`).
 *
 * Extracted from SectorRoom (god-file split). Body verbatim; `this.` became
 * `d.` (the `JoinHandlerDeps`).
 */

import type { Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  TICK_IDX,
  slotBase,
} from '../../../shared-types/sabLayout.js';
import { DEFAULT_SHIP_KIND, getShipKind } from '../../../shared-types/shipKinds.js';
import type { WelcomeMessage } from '../../../shared-types/messages.js';
import { factionLooksWelcomeField } from '../../../shared-types/factions.js';
import { STARTER_HULL_KINDS } from '../../../shared-types/blueprints.js';
import { tuningFor } from '../../../shared-types/shipScale/lookup.js';
import { nearestClearPoint } from '../../../core/bases/baseSite.js';
import { effectiveShipShieldMax, effectiveShipEnergyMax } from '../../../core/leveling/shipStats.js';
import { getUser } from '../../auth/AuthService.js';
import { getPlayerShipStore, getWallet, getHoldStore } from '../../db/PersistenceWorker.js';
import { setSession } from '../../transit/sessionRegistry.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { registerConnectedPlayer } from '../../push/connectedPlayers.js';
import { recordGameJoin } from '../../stats/StatsService.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { ShipState } from '../schema/SectorState.js';
import { shouldHonourResumedCooldown } from '../cooldownRestore.js';
import {
  ALLOW_DEV_OVERRIDES,
  CLIENT_READY_TIMEOUT_TICKS,
  JOIN_BROADCAST_GRACE_TICKS,
  NO_SITE_CIRCLES,
  hullExtent,
  withShipScale,
} from './joinConstants.js';
import type { ParsedJoinOptions } from './joinOptions.js';
import type { JoinHandlerDeps } from './joinDeps.js';

export function joinFreshSpawn(
  d: JoinHandlerDeps,
  client: Client,
  parsed: ParsedJoinOptions,
  playerId: string,
  userId: string | null,
  requestedKind: string,
  transitToken: string | undefined,
): void {
  const logger = d.logger;
  // ── FRESH SPAWN PATH ───────────────────────────────────────────────────
  d.sessionToPlayer.set(client.sessionId, playerId);
  d.playerToSession.set(playerId, client.sessionId);

  const slot = d.freeSlots.pop();
  if (slot === undefined) {
    logger.error({ playerId }, 'no free SAB slots — room is full');
    client.leave(1001);
    return;
  }
  d.playerToSlot.set(playerId, slot);
  d.slotToPlayer.set(slot, playerId);
  d.snapshotRing.registerEntity(playerId);

  // URL-param wins; else room-level `defaultSpawnX/Y` (engineering test
  // rooms anchor at a known point); else legacy ±200 u random scatter.
  let spawnX = parsed.success && parsed.data.spawnX !== undefined
    ? parsed.data.spawnX
    : (d.defaultSpawnX ?? (Math.random() - 0.5) * 400);
  let spawnY = parsed.success && parsed.data.spawnY !== undefined
    ? parsed.data.spawnY
    : (d.defaultSpawnY ?? (Math.random() - 0.5) * 400);
  let resumedHealth: number | null = null;
  let resumedUserId: string | null = null;
  let resumedLastFireTick: number | null = null;
  let resumedVx = 0;
  let resumedVy = 0;
  let resumedAngle = 0;
  let resumedAngvel = 0;
  let resumedFromStore = false;
  /** Phase 3 — when the client supplied a valid `shipId` in JoinOptions,
   *  the bindRosterEntry call resolves to this exact row instead of the
   *  most-recent-updated default. Empty string means "no preference". */
  let preferredShipId = '';
  /** Kind to spawn with. Defaults to the requested kind; Limbo or
   *  shipId-restore override. */
  let chosenKind: string = requestedKind;

  // Phase 3 multi-ship roster — shipId-based restore. The client picked a
  // specific roster entry from the galaxy-map panel; hydrate from that row
  // and skip the Limbo path entirely. Owned-by-this-player check guards
  // against a malicious client claiming someone else's roster row.
  const requestedShipId = parsed.success && typeof parsed.data.shipId === 'string'
    ? parsed.data.shipId
    : '';
  if (d.sectorKey !== null && requestedShipId !== '') {
    let rec = getPlayerShipStore().get(requestedShipId);
    if (rec !== null && rec.playerId === playerId && rec.lastSectorKey === d.sectorKey) {
      // EVICT-THEN-RESTORE (playtest 2026-06-10 Issue 6 — "respawn as an
      // existing ship → locked/broken"). If the requested hull is STILL
      // LINGERING in this room (the player disconnected, or it was displaced
      // by a fresh spawn), it owns a `lingeringSlots` entry, a `linger-<id>`
      // worker body, AND an armed ownerless-evict timer keyed by this same
      // shipInstanceId. Without tearing those down first, the bind +
      // `state.ships.set(<id>)` below CLOBBERS the lingering ShipState under
      // the same key while the orphan body + timer survive: the body pins the
      // fresh hull (it never reads as active to the client — the user's
      // "fire/accelerate do nothing, snaps back to a static hull"), and the
      // surviving timer later DELETES the now-active ship. Reachable from any
      // "resume a ship that lingered in the target sector". `evictOwnerlessShip`
      // despawns `linger-<id>`, cancels the timer, frees the slot, deletes the
      // stale schema entry, and markStored's the hull's LIVE pose. That write
      // REPLACES the roster record (`put` stores a new object), so re-read the
      // row: the `rec` fetched above still holds the pose from when the hull
      // was parked, and a hull bumped or pushed since then came back at its
      // old spot (2026-11-13, exposed by the arcade-handling retune).
      if (d.lingeringSlots.has(requestedShipId) || d.ownerlessShips.has(requestedShipId)) {
        serverLogEvent('respawn_evict_lingering', { playerId, shipInstanceId: requestedShipId });
        d.evictOwnerlessShip(requestedShipId);
        rec = getPlayerShipStore().get(requestedShipId) ?? rec;
      }
      spawnX = rec.lastX;
      spawnY = rec.lastY;
      // Defensive: a stored health <= 0 should be impossible (the
      // ship would have been destroyed and the roster row deleted),
      // but we observed it 2026-05-13 after a 15-min lingering ship
      // was spawned back as 0/maxHealth. Most likely a race in the
      // linger-eviction path where ship.health was driven to 0 by
      // drones but SHIP_DESTROYED didn't propagate before the
      // evictOwnerlessShip call. Treat 0 as "give the user a fresh
      // hull" and log so we can find the underlying gap.
      const kind = getShipKind(rec.kind);
      if (rec.health <= 0) {
        logger.warn(
          { playerId, shipId: rec.shipId, storedHealth: rec.health, kind: rec.kind },
          'roster row has non-positive health on spawn — issuing fresh hull (root-cause TBD)',
        );
        resumedHealth = kind.maxHealth;
      } else {
        resumedHealth = rec.health;
      }
      resumedUserId = rec.userId;
      resumedLastFireTick = rec.lastFireClientTick;
      resumedVx = rec.lastVx;
      resumedVy = rec.lastVy;
      resumedAngle = rec.lastAngle;
      resumedAngvel = rec.lastAngvel;
      resumedFromStore = true;
      chosenKind = rec.kind;
      preferredShipId = rec.shipId;
      logger.info(
        { playerId, shipId: rec.shipId, sectorKey: d.sectorKey, x: spawnX, y: spawnY, health: resumedHealth },
        'restored from roster shipId',
      );
    } else if (rec === null) {
      logger.warn({ playerId, shipId: requestedShipId }, 'JoinOptions.shipId not found; fresh spawn');
    } else if (rec.playerId !== playerId) {
      logger.warn({ playerId, shipOwner: rec.playerId }, 'JoinOptions.shipId not owned by caller; fresh spawn');
    } else {
      logger.warn(
        { playerId, shipId: requestedShipId, shipSector: rec.lastSectorKey, joinSector: d.sectorKey },
        'JoinOptions.shipId is in a different sector; fresh spawn',
      );
    }
  }

  // Economy v2 W5b — the ship-picker gate. Starter hulls (scout, fighter)
  // are always free; any other kind must be a ship you OWN (a roster row,
  // e.g. one you unpacked). A fresh spawn asking for another kind gets a
  // starter hull instead, and is told how to get the one it wanted.
  if (!resumedFromStore && d.sectorKey !== null && d.enforceHullGate && !STARTER_HULL_KINDS.includes(chosenKind)) {
    const wanted = getShipKind(chosenKind).displayName;
    chosenKind = DEFAULT_SHIP_KIND;
    d.sendNotice(client, `You need a ${wanted}: buy a packed one on the Trade tab (or loot one), then unpack it at your storage.`);
    serverLogEvent('hull_gate_refused', { playerId, wanted });
  }

  // WS-B (Phase 5): the Limbo restore path is RETIRED. A returning player
  // resumes by shipId — the roster shipId-restore above, which is now the
  // path for BOTH reconnect and transit-arrival — and a lingering hull
  // persists in-world via the sector snapshot (`lingeringHulls[]`). A join
  // without a resolvable owned shipId fresh-spawns.

  // A sector trip lands clear of other pilots' ships and parked hulls (and
  // asteroids), like an in-sector warp. Every trip lands on the same point,
  // and a ship dropped on top of parked hulls is shoved away by the physics
  // (phone run 2026-11-07: "I arrived inside the base"). Only trip arrivals:
  // other joins keep their exact placement (tests set up collisions).
  if (transitToken !== undefined) {
    const clear = d.landingPoint(playerId, spawnX, spawnY, chosenKind);
    spawnX = clear.x;
    spawnY = clear.y;
  } else {
    // T1 — never spawn inside a structure (an NPC base can fill much of a
    // sector): nudge to the nearest clear point. Join path, not the hot loop.
    // A spawn without explicit coordinates also keeps the JOINING hull clear
    // of every other hull (#18: its own size, not a fighter's). Owner clip
    // 2026-11-12: a heavy cruiser joining the capital line-up was nudged off
    // a structure straight into the NPC heavy cruiser. Explicit spawnX/Y keep
    // their exact placement (tests set up collisions on purpose), and a
    // resumed hull comes back where it really is.
    const explicit = parsed.success && (parsed.data.spawnX !== undefined || parsed.data.spawnY !== undefined);
    const hulls = explicit || resumedFromStore ? NO_SITE_CIRCLES : d.obstacles.hullCircles(playerId);
    if (d.structureRegistry.size > 0 || hulls.length > 0) {
      const boxes = d.obstacles.structureBoxes();
      const clear = nearestClearPoint(spawnX, spawnY, boxes, tuningFor(chosenKind).spawnClearance, 6000, hulls, hullExtent(chosenKind));
      spawnX = clear.x;
      spawnY = clear.y;
    }
  }

  d.initialSpawnPositions.set(playerId, { x: spawnX, y: spawnY });

  // Pre-populate the SAB slot so the update() loop sees a sane position
  // immediately, before the worker processes the SPAWN command.
  const base = slotBase(slot);
  d.sabF32[base + SLOT_X_OFF] = spawnX;
  d.sabF32[base + SLOT_Y_OFF] = spawnY;
  if (resumedFromStore) {
    d.sabF32[base + SLOT_VX_OFF]     = resumedVx;
    d.sabF32[base + SLOT_VY_OFF]     = resumedVy;
    d.sabF32[base + SLOT_ANGLE_OFF]  = resumedAngle;
    d.sabF32[base + SLOT_ANGVEL_OFF] = resumedAngvel;
  } else {
    // Fresh spawn: zero the velocity/angle fields. This SAB slot may hold
    // STALE values from a previous occupant of the slot; the physics worker
    // would otherwise read them and drift the just-spawned ship (~30 u over
    // the first 500 ms — the spawn-position E2E regression). Position is set
    // unconditionally above; velocity must be too.
    d.sabF32[base + SLOT_VX_OFF]     = 0;
    d.sabF32[base + SLOT_VY_OFF]     = 0;
    d.sabF32[base + SLOT_ANGLE_OFF]  = 0;
    d.sabF32[base + SLOT_ANGVEL_OFF] = 0;
  }

  // Create Colyseus schema entry. The schema only carries identity +
  // health/alive + kind — pose lives in `shipPoseCache` (see field doc).
  const ship = new ShipState();
  ship.playerId = playerId;
  ship.kind = chosenKind;
  // Presence — mark this player connected (any room) so the Web Push trigger
  // only alerts OFFLINE base owners. Decremented in onLeave. Refcounted, so
  // a transit's brief leave→join (or two tabs) never flips them to offline.
  registerConnectedPlayer(playerId);
  if (resumedHealth !== null) ship.health = resumedHealth;
  // Phase 3 dual-write — pick or create a `player_ships` row for this
  // ship and stamp its UUID onto the schema. Engineering rooms skip
  // persistence and leave shipInstanceId empty. When the client supplied
  // a valid `shipId`, that row is the one we bind; when `isNewShip`
  // is set, we force a fresh row (subject to ROSTER_SOFT_GUARD); otherwise we
  // pick the most-recently-updated row (or create a fresh one).
  const forceFreshCreate = parsed.success && parsed.data.isNewShip === true;
  ship.shipInstanceId = d.bindRosterEntry(playerId, userId ?? resumedUserId, chosenKind, {
    x: spawnX,
    y: spawnY,
    vx: resumedFromStore ? resumedVx : 0,
    vy: resumedFromStore ? resumedVy : 0,
    angle: resumedFromStore ? resumedAngle : 0,
    angvel: resumedFromStore ? resumedAngvel : 0,
    health: resumedHealth ?? ship.health,
    lastFireClientTick: resumedLastFireTick ?? 0,
  }, preferredShipId, forceFreshCreate);
  // Phase 6a — engineering rooms (`sectorKey === null`) bypass the
  // roster entirely, so `bindRosterEntry` returns ''. Generate a
  // synthetic UUID so the snapshot wire key + downstream lookups
  // (PlayerShipStore.get etc.) never see an empty id. Two players in
  // the same engineering room each get a unique synthetic id, so
  // there's no collision.
  //
  // 2026-05-13 fix: scope to engineering rooms ONLY. A previous
  // version of this fallback fired unconditionally when
  // shipInstanceId was '', which also caught the GALAXY-room
  // roster-full case (bindRosterEntry returns '' on RosterFullError).
  // The synthetic UUID then had no roster row, so the 30-tick
  // abandon-detection sweep saw `store.get(syntheticUUID) === null`
  // and immediately reaped the ship — 18 ms after spawn.
  // Regression test:
  // `tests/integration/sectorRoom/rosterFullNoReap.test.ts`.
  if (ship.shipInstanceId === '' && d.sectorKey === null) {
    ship.shipInstanceId = randomUUID();
  }
  // Phase 4 (Leveling & XP, WS-B1) — seed the live level mirror from the
  // roster row so a previously-levelled ship shows its public badge from the
  // first snapshot. Engineering rooms / fresh ships have no row ⇒ level 1.
  // WS-B2 — also seed the per-instance stat allocation so a previously-upgraded
  // ship's multipliers take effect from the first tick (the SET_STAT_MUL post
  // is below, after the worker SPAWN).
  if (ship.shipInstanceId !== '') {
    const row = getPlayerShipStore().get(ship.shipInstanceId);
    ship.level = row?.level ?? 1;
    ship.statAlloc = row?.statAlloc ?? {};
    // WS-B3 — seed the per-instance activated latent mounts so a previously-
    // upgraded ship fires + renders its extra turrets from the first tick.
    ship.mounts = row?.mounts ?? [];
  }
  ship.isActive = true;
  // Populate the indirection map BEFORE setting the schema entry so
  // any synchronous observer (e.g. a re-entrant fire-handler) can
  // already resolve the player's active hull.
  d.playerToActiveShipInstance.set(playerId, ship.shipInstanceId);
  // Tripwire (playtest 2026-06-10 Issue 6): a fresh-spawn bind must never land
  // on a shipInstanceId already in the schema map — that means a lingering
  // hull under the same key was NOT torn down first (the evict-then-
  // restore above is the guard). Log loudly so any future regression of that
  // invariant is visible instead of silently clobbering a live ShipState.
  if (d.shipsMap.has(ship.shipInstanceId)) {
    logger.error(
      { playerId, shipInstanceId: ship.shipInstanceId, sectorKey: d.sectorKey },
      'duplicate state.ships key on fresh-spawn bind — lingering hull not evicted (Issue 6)',
    );
    serverLogEvent('ships_set_duplicate_key', { playerId, shipInstanceId: ship.shipInstanceId });
  }
  // Phase 6b — schema map is keyed by shipInstanceId. This supports
  // multiple entries per player (active + lingering hulls). All the
  // `state.ships.get(playerId)` callsites have been migrated to the
  // `getActiveShip(playerId)` helper which translates via
  // resolveActiveShipKey. The Colyseus diff broadcast now carries
  // ship records keyed by shipInstanceId; the snapshot wire format
  // already matched this since Phase 6a.
  d.shipsMap.set(ship.shipInstanceId, ship);
  // Phase 4 WS-B2 review must-fix #1 — the NON-PHYSICS stat upgrades
  // (maxHull / shield / energy) are applied server-authoritatively at their
  // seed sites via the `effectiveShip*` helpers (ONE source each, so the
  // hull-pct DENOMINATOR + the seed always agree). An un-upgraded ship gets
  // the rounded kind base (byte-identical for whole bases). `ship.statAlloc`
  // was seeded from the roster above (or `{}` for engineering rooms).
  const spawnKind = getShipKind(ship.kind);
  // Hull max — the active-spawn path never set ship.maxHealth before (it sat
  // at the schema default), so the hull-pct denominator was wrong; seed it
  // from the kind base × maxHull mul, matching the lingering-reconstruct path.
  ship.maxHealth = d.shipHullMax(spawnKind.maxHealth, ship.statAlloc, ship.shipInstanceId);
  // A fresh spawn (no resumed roster health) seeds full hull at the upgraded
  // max; a resumed hull keeps its stored (already-clamped) health.
  if (resumedHealth === null) ship.health = ship.maxHealth;
  // Shield seeds full on spawn (transient - never persisted; only hull
  // persists). Body spawns circle (exposed:false in spawnShip).
  ship.shield = effectiveShipShieldMax(spawnKind.shieldMax, ship.statAlloc);
  // Energy seeds full on spawn (transient like shield; weapons/energy/AI
  // overhaul §3). Fallback covers any kind that pre-dates the energy field.
  ship.energy = effectiveShipEnergyMax(spawnKind.energyMax ?? 100, ship.statAlloc);
  // Test-only initialHull / initialShield overrides. Gated to testMode
  // rooms (engineering, never galaxy) so live gameplay can't be nerfed
  // via the wire. Applied AFTER the kind-default hull/shield are
  // installed so the test spec gets the exact override it asked for.
  // E2E specs that just need "do they die when shot?" spawn with
  // initialHull=1, initialShield=0 → one beam tick kills.
  if ((d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success) {
    if (typeof parsed.data.initialHull === 'number') {
      ship.health = Math.max(1, parsed.data.initialHull);
    }
    if (typeof parsed.data.initialShield === 'number') {
      ship.shield = Math.max(0, parsed.data.initialShield);
    }
    // initialEnergy override — lets energy specs start near-empty so the
    // gate/regen flow is testable in a few ticks instead of seconds.
    if (typeof parsed.data.initialEnergy === 'number') {
      ship.energy = Math.max(0, parsed.data.initialEnergy);
    }
    // Economy v2 W1 — test-only wallet seed (join option, else the room's).
    const walletSeed = parsed.data.initialWallet ?? d.testWalletSeed;
    if (walletSeed > 0) {
      const have = getWallet().balance(playerId);
      if (have < walletSeed) getWallet().credit(playerId, walletSeed - have, 'test_seed');
    }
    // Living World P1a — seed the hull's carried hold (needs a roster-bound
    // shipInstanceId; engineering rooms have none ⇒ no-op).
    if (parsed.data.initialCargo !== undefined && ship.shipInstanceId !== '' && d.sectorKey !== null) {
      const c = parsed.data.initialCargo;
      getHoldStore().put({
        holderUid: ship.shipInstanceId, holderType: 'ship', ownerId: playerId,
        sectorKey: null, x: null, y: null,
        hold: { goods: { ...c.goods }, blueprints: [...c.blueprints] },
        expiresAt: null,
      });
    }
    // initialAngle is applied below — the angle lives in
    // `shipPoseCache` + the Rapier body (via SET_POSITION post-SPAWN),
    // not on the ShipState schema (per the spatial-fields-off-schema
    // invariant at the top of `SectorState.ts`).
    // lingerMs override — captured per-player so the NEXT onLeave uses a
    // short linger TTL (lets the despawn→return-to-pool E2E observe the
    // evict without waiting out the 15-min production window).
    if (typeof parsed.data.lingerMs === 'number') {
      d.playerToLingerMs.set(playerId, parsed.data.lingerMs);
    }
    // initialXp — pre-load the roster row's XP so a single kill levels the
    // ship (showcase level-up shot). Roster-backed rooms only; level kept.
    if (typeof parsed.data.initialXp === 'number' && ship.shipInstanceId !== '') {
      getPlayerShipStore().setProgress(ship.shipInstanceId, { xp: parsed.data.initialXp });
    }
  }
  ship.shieldLastDamageTick = d.serverTick;

  // plan: imperative-taco — pre-mark every drone hostile to this player
  // so a CDP allocation profile (combat-allocation-profile-hostile.spec.ts)
  // measures steady-state combat instead of the IDLE→COMBAT transition.
  // Mirrors the `markBotHostile` pattern in LivingWorldBotHooks: per-player
  // `aiController.markHostile` + `bot_aggro` broadcast so the client's
  // hostility ledger stays in lockstep. testMode-gated for safety.
  // Radar sandbox — pose drones flagged `hostile` render as hostile contacts
  // for every joiner (same channel as startHostile: ledger + bot_aggro).
  if (d.testMode && d.sandboxHostileDroneIds.length > 0) {
    const tick = d.serverTick;
    for (const id of d.sandboxHostileDroneIds) {
      const rec = d.swarmRegistry.get(id);
      if (!rec) continue;
      d.aiController.markHostile(rec.id, playerId, tick);
      d.broadcast('bot_aggro', {
        type: 'bot_aggro',
        botEntityId: `swarm-${rec.entityId}`,
        targetPlayerId: playerId,
        tick,
      });
    }
  }

  if ((d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.startHostile === true) {
    d.markAllDronesHostileTo(playerId);
  }
  // Fire control (universal): every pilot is tracked; its groups fire only
  // at LOCKED targets. `instantLock` (locks complete at once) and
  // `anyTarget` (AUTO picks non-hostile targets too) are testMode shortcuts.
  const instantLock = (d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.instantLock === true;
  const anyTarget = (d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.anyTarget === true;
  const groupMode = (d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success ? parsed.data.groupMode ?? null : null;
  d.locks.enable(playerId, instantLock, groupMode, anyTarget);
  // Structure turrets lock too; an `instantLock` joiner makes this room's
  // structure locks instant as well (room-wide, test rooms only).
  if (instantLock) d.structureGrid.setInstantTurretLocks(true);
  // `lockTimeCapS` on a join caps every NON-player lock in this room.
  if ((d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.lockTimeCapS !== undefined) {
    d.setLockTimeCap(parsed.data.lockTimeCapS);
  }
  // `chargeTicksCap` on a join caps every capital-turret charge in this room.
  if ((d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.chargeTicksCap !== undefined) {
    d.testChargeTicksCap = parsed.data.chargeTicksCap;
  }
  // `traverseTicksCap` on a join caps every capital turret's training in this room.
  if ((d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.traverseTicksCap !== undefined) {
    d.testTraverseTicksCap = parsed.data.traverseTicksCap;
  }
  // `timeScale` on a join sets this sector's game speed (test/recording).
  if ((d.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.timeScale !== undefined) {
    d.setTimeScale(parsed.data.timeScale);
  }

  // Seed the pose cache with the spawn pose so any pre-update read sees a
  // sane value (e.g. a fire request resolved on this same client.send turn).
  d.shipPoseCache.set(playerId, {
    x: spawnX,
    y: spawnY,
    vx: resumedFromStore ? resumedVx : 0,
    vy: resumedFromStore ? resumedVy : 0,
    angle: resumedFromStore ? resumedAngle : 0,
    angvel: resumedFromStore ? resumedAngvel : 0,
  });

  d.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY, kindId: chosenKind });
  // Phase 4 WS-B2 — push the per-instance physics multipliers to the freshly
  // spawned worker body (no-op when un-upgraded) so the very first applyInput
  // tick scales movement by the upgraded factors, identically to the client.
  d.applyStatMulToWorker(playerId, ship.statAlloc);

  // Test-only initialAngle: SPAWN creates the body at angle 0; force
  // the requested heading immediately via SET_POSITION so the spec
  // doesn't have to drive 2 s of keyboard rotation. Pose cache + ship
  // schema were already populated above; this just brings the Rapier
  // body in line with them.
  if (d.testMode && parsed.success && typeof parsed.data.initialAngle === 'number') {
    const a = parsed.data.initialAngle;
    d.postToWorker({
      type: 'SET_POSITION',
      entityId: playerId,
      x: spawnX, y: spawnY, angle: a,
      vx: 0, vy: 0, angvel: 0,
    });
    const poseEntry = d.shipPoseCache.get(playerId);
    if (poseEntry) poseEntry.angle = a;
  }

  const currentServerTick = Atomics.load(d.sabU32, TICK_IDX);

  if (resumedLastFireTick !== null && shouldHonourResumedCooldown(resumedLastFireTick, currentServerTick)) {
    d.lastFireClientTick.set(playerId, resumedLastFireTick);
  }
  const welcome: WelcomeMessage = {
    type: 'welcome',
    playerId,
    serverTick: currentServerTick,
    sectorKey: d.sectorKey,
    shipInstanceId: ship.shipInstanceId,
  };
  client.send('welcome', withShipScale({ ...welcome, ...d.shellWelcomeFields(client, playerId), ...d.wreckWelcomeFields(), ...d.cutField?.welcome, ...factionLooksWelcomeField() }));

  // Prefer the auth-validated userId from this connect; fall back to the
  // Limbo-resumed value when this connect was anonymous (covers the
  // "close-tab, reopen-without-relogging" path on the same browser).
  const effectiveUserId = userId ?? resumedUserId;
  d.playerToUser.set(playerId, effectiveUserId);
  recordGameJoin(effectiveUserId, playerId, d.sectorKey ?? d.roomId);

  // Phase 1 — propagate the player's display label so other clients can
  // render a name above their ship. `displayName` is preferred; the
  // email is the documented fallback (see plan). Anonymous players
  // leave an empty string and the client falls back to `Pilot ${id}`.
  if (effectiveUserId) {
    const user = getUser(effectiveUserId);
    if (user) ship.displayName = user.displayName ?? user.email ?? '';
  }

  // Phase 8 sub-phase B — register session for diag inspection and future
  // multi-VM transit routing.
  setSession(client.sessionId, {
    roomId: d.roomId,
    playerId,
    sectorKey: d.sectorKey,
  });

  d.bus.emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: spawnX, y: spawnY });
  // Fresh-spawn path: force snapshot broadcasts for a grace window so
  // the new client receives a steady stream to reconcile its
  // prediction world against the spawn pose BEFORE idle-suppression
  // short-circuits the broadcast loop. Without this, a stationary
  // freshly-spawned ship in an otherwise-quiet sector gets zero
  // snapshots until the player moves — then the first snapshot snaps
  // the (stale, free-run) prediction hundreds of units. See
  // JOIN_BROADCAST_GRACE_TICKS.
  d.forceBroadcastUntilTick = currentServerTick + JOIN_BROADCAST_GRACE_TICKS;
  serverLogEvent('player_join', { playerId, sessionId: client.sessionId, spawnX, spawnY });
  auditEvent({ event: 'player_joined', sector: d.sectorKey ?? undefined, playerId });
  logger.info(
    { playerId, sessionId: client.sessionId, userId: effectiveUserId, resumedFromStore },
    'player joined',
  );

  // Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
  // Ship enters the sector INVISIBLY (isActive=false). Drones won't
  // target it (aiTickRunner / LivingWorldBotHooks both filter on
  // `ship.isActive`); the snapshot translator on remote clients
  // skips isActive=false entries; the client snapshot apply on the
  // joining player ignores their own ship (predWorld is authoritative
  // for the local pose anyway). The ship becomes visible to all
  // observers — including the joiner — at the synchronised
  // `arrivalTick` once the client has called `client_ready`.
  //
  // Note: the LOCAL CLIENT's `mirror.ships[playerId]` is populated
  // from the bootstrap path (welcome → predWorld), so the joiner
  // still has a ship to predict / render — but the loading curtain
  // (Commit 1's `useIsLoadingActive`) hides it until the curtain
  // drops at `arrivalTick`.
  ship.isActive = false;
  d.pendingJoin.set(playerId, {
    joinTick: currentServerTick,
    watchdogTick: currentServerTick + CLIENT_READY_TIMEOUT_TICKS,
    arrivalTick: null,
    spawnX,
    spawnY,
    sessionId: client.sessionId,
  });
  serverLogEvent('pending_join_registered', {
    playerId,
    sessionId: client.sessionId,
    watchdogTick: currentServerTick + CLIENT_READY_TIMEOUT_TICKS,
  });

  // NOTE: the previous immediate `warp_in` broadcast (to other
  // occupants, with `except: client`) is REMOVED. The unified
  // handshake broadcasts `warp_in` from the `client_ready` handler
  // (or the watchdog) to ALL clients with an `arrivalTick`, so the
  // flash fires in sync everywhere.
}
