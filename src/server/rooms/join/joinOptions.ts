/**
 * Join options — the zod schemas a `SectorRoom` join (and the room's own
 * testMode caps) are validated against. Moved verbatim out of SectorRoom.ts
 * with the JoinHandler split.
 */

import { z } from 'zod';
import { StartModeSchema } from '../../../shared-types/messages.js';
import { HoldSchema } from '../../../shared-types/goods.js';
import { MIN_TIME_SCALE, MAX_TIME_SCALE } from '../../../core/clock/GameClock.js';

/**
 * testMode `lockTimeCapS` (room option, join option, URL `?lockTimeCapS=`):
 * the longest any NON-player lock may take, in seconds. 0 = the first step.
 * Applied by `capLockSeconds` (core/combat/lockTime.ts).
 */
export const LockTimeCapSchema = z.number().finite().min(0).max(600);

/**
 * testMode `chargeTicksCap` (room option, join option, URL `?chargeTicksCap=`):
 * the longest any capital-turret charge may take, in ticks (the railgun's ~6 s
 * wind-up without the wait). 0 = it fires on the next tick it may.
 */
export const ChargeTicksCapSchema = z.number().int().min(0).max(36_000);

/**
 * testMode `traverseTicksCap` (room option, join option, URL `?traverseTicksCap=`):
 * the longest any capital turret may take to train across a full turn, in
 * ticks (a 16" trains at ~4 deg/s, so ~15 s onto a target abeam). 0 = snap.
 */
export const TraverseTicksCapSchema = z.number().int().min(0).max(36_000);

/**
 * Game speed override for a sector (time scale stream): testMode room option,
 * join option and URL `?timeScale=`, or `EQX_TIME_SCALE` outside production.
 * The automatic load controller (Phase 5) may still slow a sector below it.
 */
export const TimeScaleSchema = z.number().finite().min(MIN_TIME_SCALE).max(MAX_TIME_SCALE);



export const JoinOptionsSchema = z
  .object({
    playerId: z.string().nullable().optional(),
    authToken: z.string().optional(),
    /** PR 3a — server-issued single-use transit proof (set by the source
     *  room's TransitOrchestrator in the seat reservation, never by a client). */
    transitToken: z.string().max(64).optional(),
    spawnX: z.number().optional(),
    spawnY: z.number().optional(),
    /** Test-only initial hull override. Honoured only when the room has
     *  `testMode === true` (engineering rooms like `test-sector`). Lets
     *  E2E specs that just need "do they die when shot?" spawn with
     *  1 HP so the kill resolves in a single beam tick instead of
     *  fighting full 500 HP + shield. Ignored on galaxy rooms. */
    initialHull: z.number().int().min(1).optional(),
    /** Test-only initial shield override; same testMode gate. 0 lets the
     *  first beam hit hull immediately. */
    initialShield: z.number().int().min(0).optional(),
    /** Living World P1a — test-only: seed the joining ship's carried hold (so
     *  spill / deposit specs don't have to farm loot first). testMode-gated. */
    initialCargo: HoldSchema.optional(),
    /** Economy v2 W1 — test-only: top the joining player's WALLET up to this
     *  many credits (credits are virtual; never seeded into a hold). */
    initialWallet: z.number().int().min(0).max(10_000_000).optional(),
    /** Test-only initial energy override; same testMode gate. Lets energy
     *  specs start near-empty so the fire-gate / regen flow resolves in a
     *  few ticks. (weapons/energy/AI overhaul §3) */
    initialEnergy: z.number().int().min(0).optional(),
    /** Mobile-perf gate test-only leak rate (bytes per RAF tick). Server
     *  accepts and ignores — the value is consumed CLIENT-SIDE by
     *  `src/client/debug/testLeakHook.ts` reading the URL param directly.
     *  Validated here only for schema parity with the other test
     *  primitives + so the URL → joinOption echo round-trips cleanly. */
    injectLeak: z.number().int().min(0).max(10_000_000).optional(),
    /** Test-only initial angle override (radians, standard math CCW).
     *  Lets a spec spawn pointing at a specific target without burning
     *  ~2 seconds rotating the ship via keyboard input. testMode gate. */
    initialAngle: z.number().finite().optional(),
    /** Per-test room isolation knob. Combined with the test rooms'
     *  `filterBy(['testId'])` (in `src/server/index.ts`), passing a
     *  unique testId routes each Playwright spec to its own physics-
     *  worker-backed Colyseus room — enabling safe `fullyParallel`
     *  execution across specs without cross-test state pollution.
     *  Omit (default) → shared room for back-compat with pre-filterBy
     *  specs. The server doesn't otherwise consume this field; Colyseus
     *  routes by it at the matchmaker layer. */
    testId: z.string().optional(),
    /** Player-chosen ship kind id (e.g. 'scout' | 'fighter' | 'heavy').
     *  Validated against `isShipKindId` in `onJoin`; unknown / missing values
     *  fall back to `DEFAULT_SHIP_KIND`. Ignored on Limbo rebind paths so a
     *  bad-actor client cannot mid-session swap kind. */
    shipKind: z.string().optional(),
    /** Phase 3 multi-ship roster — the specific roster entry to spawn into.
     *  Validated against `getPlayerShipStore().get(shipId).playerId === playerId`
     *  in `onJoin`; unowned / missing ids fall through to the legacy
     *  Limbo-restore-or-fresh-spawn path. Present ⇒ hydrate from the named
     *  roster row's stored pose / kind / health; ignore Limbo for this join. */
    shipId: z.string().optional(),
    /** Phase 3 multi-ship roster — force fresh creation even when the
     *  player already has entries in their roster. Sent by the galaxy
     *  map's "spawn a new ship in this sector" flow (sector click →
     *  kind picker). Without this flag, the dual-write defaults to
     *  reusing the most-recent roster row, which would mean clicking a
     *  fresh sector silently resumed the player's old ship. */
    isNewShip: z.boolean().optional(),
    /** Test-only: pre-mark every drone in this sector hostile to the
     *  joining player at spawn time. Lets a 20-25 s CDP allocation
     *  profile (or any combat-shaped E2E) measure steady-state combat
     *  without the IDLE→COMBAT transition tail polluting the window.
     *  testMode-gated; ignored on galaxy rooms so a malicious client
     *  can't force-aggro a live sector. plan: imperative-taco. */
    startHostile: z.boolean().optional(),
    /** Test-only bespoke trigger (fire control): every lock of this pilot
     *  completes on the next lock step, so a spec that isn't about locking can
     *  fire without waiting ~1.5 s per lock. It does NOT widen AUTO targeting
     *  (that is `anyTarget`). testMode-gated (ignored on galaxy rooms). */
    instantLock: z.boolean().optional(),
    /** Test-only bespoke trigger (fire control): the longest any NON-player
     *  lock in this room may take, in seconds (NPC drones and capitals on
     *  pilots, capital turrets on structures, structure and coastal turrets).
     *  0 = locks complete on the first step. Room-wide: read in `onCreate`
     *  (room option, or the room-creating client's join option) and on any
     *  join that passes it. testMode-gated. */
    lockTimeCapS: LockTimeCapSchema.optional(),
    /** Test-only bespoke trigger (charge-up): the longest any capital-turret
     *  charge in this room may take, in ticks. Room-wide; testMode-gated. */
    chargeTicksCap: ChargeTicksCapSchema.optional(),
    /** Test-only bespoke trigger (turret traverse): the longest any capital
     *  turret takes to train a full turn, in ticks. Room-wide; testMode-gated. */
    traverseTicksCap: TraverseTicksCapSchema.optional(),
    /** Test/recording trigger (time scale): set this sector's game speed
     *  (0.25–4). Room-wide. testMode-gated. */
    timeScale: TimeScaleSchema.optional(),
    /** Test-only bespoke trigger (fire control): this pilot's AUTO groups
     *  also pick NON-hostile targets (NPC ships, structures not their own) in
     *  reach + arc. Never players. Usually paired with `instantLock`.
     *  testMode-gated (ignored on galaxy rooms). */
    anyTarget: z.boolean().optional(),
    /** Test-only bespoke trigger (fire control): every weapon group of this
     *  pilot starts in MAN, so AUTO never self-picks a target before the test
     *  sets the group it wants (`anyTarget` + `instantLock` let AUTO lock anything at once,
     *  which can kill a fragile target first). testMode-gated. */
    groupMode: z.enum(['manual']).optional(),
    /** Test-only: override the disconnect-linger TTL (ms) for THIS player.
     *  On disconnect the room normally lingers the hull for
     *  `LIMBO_DISCONNECT_TTL_MS` (15 min) before the ownerless-evict timer
     *  returns it to the virtual pool. That's far too long for an E2E to
     *  observe the despawn→return-to-pool transition, so the linger E2E
     *  suite passes e.g. `?lingerMs=2000` to make the evict fire in ~2 s.
     *  testMode-gated (honoured only on `galaxy-test` / engineering rooms);
     *  ignored on live galaxy rooms so a malicious client can't force a
     *  short or huge linger window. */
    lingerMs: z.number().int().min(1).max(900_000).optional(),
    /** Showcase / E2E bespoke trigger — pre-load the joining ship's roster XP
     *  so ONE kill crosses a level threshold (the level-up + upgrade-modal
     *  shot) instead of a dozen. testMode-gated; needs a roster row (a room
     *  with a real sectorKey). Level is unchanged — only the XP bar fills. */
    initialXp: z.number().int().min(0).max(100_000).optional(),
    /** Structures plan (Phase 3/4) test-only override of the grid pulse
     *  interval (ms). On the room-creating client it reaches `onCreate` and
     *  sets the pulse timer; lets the mining/construction E2E fast-forward the
     *  wall-clock pulse (which `testTimeScale` can't, being physics-tick-only).
     *  testMode-gated. */
    structureGridPulseMs: z.number().int().min(20).max(2000).optional(),
    /** Equinox Phase 5 (WS-3) — join the sector as a SPECTATOR. The galaxy
     *  "Join as spectator" CTA sends this (skipping the ship-kind picker). The
     *  hull still spawns through the normal handshake (so the client's join
     *  readiness lifts the load curtain the proven way), but at the arrival
     *  flip it is PARKED as a lingering hull — the player has NO active hull
     *  and arrives in free-roam spectator mode (pilotable later via the in-
     *  world Pilot dropdown). Galaxy rooms only (`sectorKey !== null`); ignored
     *  on engineering rooms which have no roster to park a lingering hull into.
     *  NOT testMode-gated — it's a real player-facing entry mode. */
    spectator: z.boolean().optional(),
    /** RTS command layer (slice 10) — how the player lands: `command` parks
     *  the hull as an AI-flown lingering hull at the arrival flip (the same
     *  path as the `command` / `spectate` messages) and tells the client
     *  (`control_mode`), so they arrive in command view; `fly` (and absent)
     *  = at the controls, as before. Galaxy rooms only (an engineering room
     *  has no roster to park into, nor a way to take the helm back). The
     *  client sends `command` for normal galaxy play; server-reserved transit
     *  arrivals carry none, so a pilot who warps keeps flying. */
    startMode: StartModeSchema.optional(),
  })
  .passthrough();

/** A parsed join (`JoinOptionsSchema.safeParse`). */
export type ParsedJoinOptions = ReturnType<typeof JoinOptionsSchema.safeParse>;
