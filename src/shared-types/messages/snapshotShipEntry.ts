import type { Hold } from '../goods.js';

/** One ship's entry in `SnapshotMessage.states` (keyed by shipInstanceId).
 *  Split out of snapshotMessages.ts (file cap); re-exported from there. */
export interface SnapshotShipEntry {
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
  /** Phase 6a — owner playerId for this hull. The map key is now
   *  shipInstanceId, so this is how the client recovers "who owns
   *  this ship" for display labels + damage-event correlation. */
  playerId: string;
  /** Phase 6a — true while a session is actively piloting this hull.
   *  Always true in 6a (one active ship per player per sector still
   *  invariant). Phase 6b introduces `isActive=false` for lingering
   *  hulls; client uses this to gate visibility / interaction. */
  isActive: boolean;
  /** Present on EVERY snapshot while any bit is held; absent = idle
   *  (RTS Part A S1, server `shouldIncludeLastInput`, client
   *  `preResetRemoteShips`). Never deduped: the client drops snapshots. */
  lastInput?: {
    thrust: boolean;
    turnLeft: boolean;
    turnRight: boolean;
    boost: boolean;
    reverse: boolean;
  };
  /** Multi-mount/turret refactor (Phase 4b.3, 2026-05-11). Per-mount
   *  rotation angle in arc-local frame, indexed by mount-order in the
   *  ship-kind catalogue. Authoritative — the server's
   *  WeaponMountController tick computes these and they drive both the
   *  server's hit-test geometry and remote observers' rendered turret
   *  rotation. Absent for ship-kinds with no rotating mounts (the
   *  legacy single-mount fighter/scout/heavy emit nothing). */
  mountAngles?: number[];
  /** Weapons/energy/AI overhaul (2026-06-01 §3.2). The ship's current
   *  energy pool, emitted ONLY on the recipient's OWN ship entry (energy
   *  is the local player's predicted resource — remote ships never need
   *  it). Integer-quantised. Absent on every other ship + all remote
   *  recipients (notepack skips `undefined`, same trick as `lastInput` /
   *  `mountAngles`). The client hard-sets `predEnergy` from this on each
   *  snapshot; `energyMax` (the bar denominator) is read from the kind
   *  catalogue client-side, never on the wire. */
  energy?: number;
  /** WS-12 / R2.32 — true when this hull's shield is DOWN (hull exposed).
   *  Emitted for BOTH active AND lingering hulls so the client can render
   *  the shield aura on a parked lingering hull (previously the lingering
   *  mirror entry carried no shield state, so it never showed an aura).
   *  Emit-when-true only (notepack skips `undefined`); absent ⇒ shield up.
   *  Byte-additive — an undamaged sector pays zero extra bytes. */
  shieldDown?: boolean;
  /** Phase 4 (Leveling & XP, WS-0) — this hull's PUBLIC level (≥ 1). Drives
   *  the small level badge rendered on the ship (visible to all) + in the
   *  roster. Emit-only-if-changed (the same emit-if-changed discipline as
   *  `energy`; the broadcaster wiring is owned by WS-B1) — absent ⇒ the
   *  client treats the hull as level 1, so undamaged/un-levelled sectors pay
   *  zero extra bytes. Integer; no `SWARM_WIRE_VERSION` bump (a slim JSON
   *  field on the snapshot states map, like `energy`/`mountAngles`). */
  level?: number;
  /** Phase 4 (Leveling & XP, WS-B2) — the hull's per-instance spent stat
   *  allocation (`statId → points`). Emitted ONLY on the recipient's OWN ship
   *  entry (like `energy`) AND only when non-empty (un-upgraded hulls + every
   *  remote ship omit it — zero byte cost). The client derives the PHYSICS
   *  multipliers from this and re-anchors its predWorld `setStatMultipliers`
   *  so prediction scales movement identically to the server (risk #1 — the
   *  authoritative re-anchor; the `ship_upgrade_applied` echo is just UI
   *  confirmation). No `SWARM_WIRE_VERSION` bump (slim JSON field). */
  statAlloc?: Record<string, number>;
  /** Living World P1a (plan peppy-jumping-pinwheel) — the hull's carried
   *  HOLD (goods / credits / blueprints). OWN active ship only, and only when
   *  non-empty (zero bytes otherwise). This is the AUTHORITATIVE cargo
   *  carrier (invariant #16) — the `loot_collected` message is only a UI
   *  accelerator. Shared reference, replaced only on a discrete transfer.
   *  No `SWARM_WIRE_VERSION` bump (slim JSON field). */
  cargo?: Hold;
  /** Economy v2 W1 — the OWN player's wallet balance (credits are virtual,
   *  one balance per player; emitted on the own active ship's entry). */
  wallet?: number;
  /** Join flow — the OWN player's free capital launches left. */
  freeLaunches?: number;
  /** v4 T2 — bumped when a teleporter moved this (own, active) hull;
   *  emitted when > 0. A change makes the client re-seed its prediction
   *  at the snapshot pose instead of reconciling a long jump. */
  poseEpoch?: number;
  /** v4 A — this (own, active) ship is DISABLED by an alien gate for this
   *  many more ms (engines and weapons offline); emitted when > 0. */
  disabledMs?: number;
  /** Phase 4 warp-to — 1 spooling, 2 on the run, 3 just dropped out;
   *  absent = idle. PUBLIC (#16): every client draws the build-up and the
   *  arrival. A ship on its run (2) is out of the world: other clients hide
   *  it and drop its collision body; only its own pilot keeps flying it. */
  warp?: 1 | 2 | 3;
  /** Living World P5 — the OWN active ship's fitted blueprint ids (emit-when-
   *  non-empty). Drives the cargo capacity + the upgrade modal's weapon gate. */
  fitted?: string[];
  /** Living World P1a-2 — auto-deposit progress 0..100 (own active ship only;
   *  absent ⇒ not depositing), or `DEPOSIT_WAITING` (parked on a freight
   *  dock whose crane is serving another ship); a crane cycle adds the
   *  cargo direction (`DEPOSIT_FLOW_STEP`). Drives the HUD deposit bar. */
  depositing?: number;
  /** Fire control (exp/fire-control) — the OWN active pilot's weapon groups:
   *  id, mode (m: 0 auto / 1 manual) and lock queue (t: target key,
   *  s: stage 0 failsafe / 1 acquiring / 2 locked, p: progress 0..100).
   *  Absent ⇒ not a fire-control pilot (or no groups). */
  groups?: Array<{ id: string; m: 0 | 1; l: Array<{ t: string; s: number; p: number; r?: 1; c?: 1; f?: number }> }>;
  /** Fire control — NPCs locking this pilot: `t` = `s:<entityId>`,
   *  `s` 1 acquiring / 2 locked, `p` 0..100. Own pilot only; absent ⇒ none.
   *  At most `LOCKED_BY_WIRE_ROWS` rows: completed locks first, then nearest. */
  lockedBy?: Array<{ t: string; s: 1 | 2; p: number }>;
  /** Fire control — how many NPCs lock this pilot in all, sent only when
   *  more than the `lockedBy` rows (absent ⇒ the rows are everyone). The
   *  HUD banner's count. No `SWARM_WIRE_VERSION` bump (slim JSON field). */
  lockedByN?: number;
  /** Fire control — how many of those hold a COMPLETED lock, sent only
   *  when some are off the `lockedBy` rows (absent ⇒ the locked rows are
   *  all of them). The banner's exact locked count. Slim JSON field. */
  lockedByL?: number;
  /** Phase 4 (Dynamic weapon mounts, WS-B3) — the hull's ACTIVATED latent
   *  mount slots (`{ slotId, weaponId }[]`). PUBLIC (unlike `statAlloc`):
   *  emitted for EVERY ship (active + lingering) that has ≥ 1 activated
   *  mount, so OTHER players see (and the renderer draws) the extra turrets.
   *  Emit-when-non-empty only — un-upgraded hulls omit it (zero byte cost).
   *  The activated mounts' GEOMETRY is looked up CLIENT-SIDE by
   *  `(shipKind, slotId)` from the catalogue — only this slim id/weapon pair
   *  rides the wire (the scrap-collider trick). The per-instance mount list
   *  is `[...kind.mounts, ...activated]`, so `mountAngles[]` (already
   *  variable-length) carries the activated slots' angles WITHOUT a
   *  `SWARM_WIRE_VERSION` bump (it's a slim JSON field on the states map). */
  mounts?: Array<{ slotId: string; weaponId: string }>;
  /** The pilot dropped this (own, active) ship's shields (`set_shields`):
   *  the HUD shield ring shows DOWN and a tap raises them. Own-only, emit-when-
   *  true (#16; the server's `ShipState.shieldsLowered`). */
  shieldsLowered?: true;
}
