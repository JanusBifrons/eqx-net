/**
 * Target locks per player per weapon group (exp/fire-control P2). Server
 * authority: a group may only fire at a target it has LOCKED, so locks gate
 * fire (`PlayerFireResolver`) and drive turret aim (`WeaponMountTicker`).
 *
 * Every player is tracked from join (lock-to-fire is universal): an untracked
 * player has no locks, so it can't fire.
 *
 * Steady state allocates nothing (#14): group/lock/wire objects are created on
 * join, on a new lock or on a ship change, then mutated in place.
 */
import { LOCK_TUNING, WEAPON_LOCK_PROFILE, lockCapacityFor, sensorFor, NO_PILOT_MODS, type MountSize } from '../../shared-types/combat/lockProfile.js';
import { lockSeconds, type LockInputs } from '../../core/combat/lockTime.js';
import { newLock, stepLock, LOCK_STAGE_CODE, LOCK_TRACK, type LockEntry } from '../../core/combat/lockState.js';
import { lockLineHolds } from '../../core/combat/lockLine.js';
import { pickTurretLock, TURRET_NO_LOCK, TURRET_PICK_MAX } from '../../core/combat/turretLockPick.js';
import { lockSalvageFlags, type LockSalvageDeps } from './lockSalvage.js';
import { shipGroups } from './lockGroups.js';
import { mountInReach, mountWeaponReach, type MountRangeTarget } from '../../core/combat/mountReach.js';
import type { FireTargetShape } from '../../core/combat/fireControlBearing.js';
import { getWeapon, weaponAutoFireRange } from '../../core/combat/WeaponCatalogue.js';
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';

/** A lockable target, resolved each lock step. Its `FireTargetShape` half
 *  (pose, heading, hit shape; `radius` = lock signature, u) is what the
 *  fire gate measures range against (`mountInReach`). */
export interface LockTargetView extends FireTargetShape {
  vx: number;
  vy: number;
  /** Already hostile to the locking player (skips the failsafe ring). */
  hostile: boolean;
  /** Neutral terrain (asteroid, scrap / loot pod, wreck piece; shared
   *  `isTerrainLockKind`): no failsafe, never a hostile act, never a
   *  hostility refresh. */
  terrain: boolean;
}

/** A blank `LockTargetView` (scratch; allocate once, fill per call). */
export function newLockTargetView(): LockTargetView {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, ship: false, kindId: null, shieldUp: false, radius: 1, hostile: false, terrain: false };
}

export interface LockShooterView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Hull heading (game convention: forward = (-sin, cos)). */
  angle: number;
}

export interface LockSubsystemDeps extends LockSalvageDeps {
  /** Fill `out` with the target's pose; false when it is gone or can't be damaged. */
  resolveTarget(playerId: string, key: string, out: LockTargetView): boolean;
  /** Fill `out` with the player's active ship pose; false when they have none. */
  shooterPose(playerId: string, out: LockShooterView): boolean;
  /** The player's active ship kind + activated mounts, or null. */
  shipOf(playerId: string): { kind: ShipKind; activated: ReadonlyArray<WeaponMount> } | null;
  /** Best auto target for a group (hostile — or, with `anyTarget` (the testMode
   *  `anyTarget` trigger), any lockable non-player target — in reach and
   *  `bears(t)`: a mount of the group has it inside its arc AND within the
   *  mount's own reach of its hit shape), or null. Among those, the class
   *  the group's heaviest gun `size` prefers (`mountPriority`), then the
   *  nearest (owner 2026-11-14: heavy guns take what they can hurt). */
  autoPick(
    playerId: string, reach: number, sx: number, sy: number, bears: (t: FireTargetShape) => boolean, anyTarget: boolean,
    size: WeaponMount['size'],
  ): string | null;
  /** A failsafe finished: the player has committed a hostile act on `key`. */
  commitHostileAct(playerId: string, key: string): void;
  /** "Locks keep it hostile" (owner decision 2026-11-10): a lock that is
   *  LOCKING or LOCKED on an already-hostile target re-stamps that target's
   *  hostility to the pilot (each lock step, ~10 Hz), so a long shell flight
   *  doesn't let an NPC forget the pilot between hits. */
  refreshHostility(playerId: string, key: string): void;
}

/** What `shipOf` returns: the ship's kind and activated mounts. */
type LockShip = NonNullable<ReturnType<LockSubsystemDeps['shipOf']>>;

export type GroupMode = 'auto' | 'manual';

/** One lock of a group in the own-ship snapshot (`states[].groups`). `r`: released
 *  (draining). `c`: can't lock right now (untrackable: too small or fast for the
 *  group's guns; locks work at any distance); the HUD shows CAN'T TRACK. `f`: salvage
 *  bits (`LOCK_SALVAGE` | `LOCK_HAULABLE`; absent = 0), the client's `pickTurretLock` input. */
export interface WireLock { t: string; s: number; p: number; r?: 1; c?: 1; f?: number }
export interface WireGroup { id: string; m: 0 | 1; l: WireLock[] }

interface GroupState {
  id: string;
  mode: GroupMode;
  /** The slot's own start mode (`defaultMode`, else AUTO), before any pilot override. */
  slotMode: GroupMode;
  capacity: number;
  refSize: number;
  tracking: number;
  /** Heavy group (M/L/XL): lock time reads absolute distance. */
  absRange: boolean;
  reach: number;
  /** The group's heaviest gun (AUTO picks the class it prefers); undefined = ordinary guns. */
  size: WeaponMount['size'];
  /** Where the group's barrels can point, relative to the hull heading:
   *  [lo0, hi0, lo1, hi1, …] (fixed guns get a small window). */
  arcs: number[];
  mountIds: Set<string>;
  /** The group's mounts in slot order (a mount's index is its ordinal for `pickTurretLock`). */
  mounts: WeaponMount[];
  locks: LockEntry[];
  wire: WireGroup;
}

interface PlayerLocks {
  /** testMode `instantLock`: every lock completes at once. */
  instant: boolean;
  /** testMode `anyTarget`: AUTO picks any lockable non-player target, not
   *  only hostile ones. */
  anyTarget: boolean;
  /** testMode `groupMode: 'manual'`: every group starts in MAN (a later
   *  `setMode` still switches it). */
  startManual: boolean;
  kindId: string;
  activatedSig: number;
  sensor: number;
  groups: GroupState[];
  wire: WireGroup[];
}

const SIZE_RANK: Record<MountSize | 'none', number> = { none: 0, AA: 1, S: 2, M: 3, L: 4, XL: 5 };

/** Build a group's lock geometry from its mounts (largest size wins). */
export function groupGeometry(mounts: ReadonlyArray<WeaponMount>): {
  refSize: number; tracking: number; reach: number; absRange: boolean; size: WeaponMount['size'];
} {
  let size: MountSize | 'none' = 'none';
  let reach = 0;
  for (const m of mounts) {
    const s = (m.size ?? 'none') as MountSize | 'none';
    if (SIZE_RANK[s] > SIZE_RANK[size]) size = s;
    const r = weaponAutoFireRange(getWeapon(m.weaponId));
    if (r > reach) reach = r;
  }
  const p = WEAPON_LOCK_PROFILE[size];
  return { refSize: p.refSize, tracking: p.tracking, reach, absRange: p.absRange, size: size === 'none' ? undefined : size };
}

/** Half-width (rad) a fixed gun counts as bearing on a target. */
const FIXED_BEAR = 0.3;

/** Relative arcs a group's barrels cover: [lo, hi] per mount. */
export function groupArcs(mounts: ReadonlyArray<WeaponMount>): number[] {
  const out: number[] = [];
  for (const m of mounts) {
    const fixed = m.arcMin === m.arcMax;
    out.push(m.baseAngle + (fixed ? -FIXED_BEAR : m.arcMin), m.baseAngle + (fixed ? FIXED_BEAR : m.arcMax));
  }
  return out;
}

const LOCK_DT = 0.1; // seconds per lock step (every 6 server ticks)

export class LockSubsystem {
  private readonly players = new Map<string, PlayerLocks>();
  private readonly target: LockTargetView = newLockTargetView();
  private readonly shooter: LockShooterView = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };
  /** The group `bears` is testing (set before each autoPick; no closure per call). */
  private bearGroup: GroupState | null = null;
  /**
   * AUTO pick: some mount of the group has the target inside its ARC and
   * reaches its hit shape from where the mount sits (`mountInReach`,
   * the range half of the shared fire gate `mountFiresOn`, the same function
   * the client's `fcGroupBears` calls, #15). The angular half is the arc, not
   * the barrel: a turret trains onto what AUTO picks, then the fire gate
   * checks its barrel.
   */
  private readonly bears = (t: FireTargetShape): boolean => {
    const g = this.bearGroup;
    if (!g) return true;
    const s = this.shooter;
    let rel = Math.atan2(-(t.x - s.x), t.y - s.y) - s.angle;
    rel -= Math.round(rel / (2 * Math.PI)) * 2 * Math.PI;
    const cosA = Math.cos(s.angle);
    const sinA = Math.sin(s.angle);
    for (let i = 0; i < g.arcs.length; i += 2) {
      let lo = g.arcs[i]!, hi = g.arcs[i + 1]!;
      // Normalise the arc around rel so wrap-around arcs (e.g. the rear) work.
      const mid = (lo + hi) / 2;
      const shift = Math.round((rel - mid) / (2 * Math.PI)) * 2 * Math.PI;
      lo += shift; hi += shift;
      if (rel < lo || rel > hi) continue;
      const m = g.mounts[i >> 1]!;
      const ox = s.x + (m.localX * cosA - m.localY * sinA);
      const oy = s.y + (m.localX * sinA + m.localY * cosA);
      if (mountInReach(t.x - ox, t.y - oy, mountWeaponReach(m), t)) return true;
    }
    return false;
  };
  private readonly inputs: LockInputs = {
    refSize: 1, tracking: 1, reach: 1, sensor: 1, pilotSpeed: 1, signature: 1, dx: 0, dy: 0, dvx: 0, dvy: 0,
  };

  constructor(private readonly deps: LockSubsystemDeps) {}

  /** Start tracking a player (every player, on join). `instant` = the testMode
   *  `instantLock` trigger (locks complete at once); `groupMode: 'manual'` =
   *  the testMode trigger that starts every weapon group in MAN (AUTO never
   *  self-picks until the test switches a group); `anyTarget` = the testMode
   *  trigger that lets AUTO pick any lockable non-player target. */
  enable(playerId: string, instant = false, groupMode: GroupMode | null = null, anyTarget = false): void {
    const startManual = groupMode === 'manual';
    const p = this.players.get(playerId);
    if (p) { p.instant = instant; p.startManual = startManual; p.anyTarget = anyTarget; return; }
    this.players.set(playerId, { instant, anyTarget, startManual, kindId: '', activatedSig: -1, sensor: 1, groups: [], wire: [] });
  }

  /** The testMode `instantLock` trigger is on for this player. */
  isInstant(playerId: string): boolean {
    return this.players.get(playerId)?.instant === true;
  }

  /** Tracked pilots (iteration only; do not mutate while iterating). */
  enabledPlayers(): IterableIterator<string> {
    return this.players.keys();
  }

  /** Forget a player (leave, transit, death). */
  forget(playerId: string): void {
    this.players.delete(playerId);
  }

  /** Clear a player's locks (e.g. ship swap) but keep them opted in. */
  clearLocks(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.kindId = '';
    p.groups.length = 0;
    p.wire.length = 0;
  }

  /**
   * A ship's key moved: its owner took its controls (shipInstanceId → their
   * playerId) or let go of them (playerId → shipInstanceId). It is the SAME
   * ship, so its locks follow it (RTS Part A, "lockable whoever flies it"):
   *  - every lock held ON it, here and in `into`, is re-keyed `p:<from>` →
   *    `p:<to>` (stage, progress and track kept);
   *  - the ship's OWN weapon groups (with their locks) move from `from` in
   *    this machine to `to` in `into` (this one, or the sibling: a pilot's
   *    `locks` ↔ the AI pilots' `wingmanLocks`). The destination keeps its
   *    own testMode flags, and its start mode sets each group's mode (an AI
   *    pilot flies MAN; a pilot gets the slots' start modes back).
   * `into` null: nobody flies the ship any more (no AI pilot), so its own
   * locks drop. Rare (a hand-over), never per tick.
   */
  shipKeyMoved(from: string, to: string, into: LockSubsystem | null): void {
    if (from === to) return;
    const fromKey = `p:${from}`;
    const toKey = `p:${to}`;
    this.renameTarget(fromKey, toKey);
    if (into !== null && into !== this) into.renameTarget(fromKey, toKey);
    const src = this.players.get(from);
    if (src === undefined) return;
    if (into === null) { this.clearLocks(from); return; }
    let dst = into.players.get(to);
    if (dst === undefined) {
      dst = { instant: src.instant, anyTarget: src.anyTarget, startManual: src.startManual, kindId: '', activatedSig: -1, sensor: 1, groups: [], wire: [] };
      into.players.set(to, dst);
    }
    // Swap the group lists: the destination takes the ship's, the source is left empty.
    const groups = src.groups;
    const wire = src.wire;
    src.groups = dst.groups;
    src.wire = dst.wire;
    dst.groups = groups;
    dst.wire = wire;
    dst.kindId = src.kindId;
    dst.activatedSig = src.activatedSig;
    dst.sensor = src.sensor;
    this.clearLocks(from);
    for (const g of groups) {
      g.mode = dst.startManual ? 'manual' : g.slotMode;
      g.wire.m = g.mode === 'auto' ? 0 : 1;
    }
  }

  /** Re-key every lock on target `fromKey` to `toKey` (see `shipKeyMoved`). */
  private renameTarget(fromKey: string, toKey: string): void {
    for (const p of this.players.values()) {
      for (const g of p.groups) {
        let hit = false;
        for (const e of g.locks) if (e.target === fromKey) { e.target = toKey; hit = true; }
        if (hit) this.syncWireShape(g);
      }
    }
  }

  /** (Re)build the player's groups when their ship kind or activated mounts change. */
  private sync(playerId: string, p: PlayerLocks): boolean {
    return this.syncShip(playerId, p) !== null;
  }

  /** `sync`, returning the ship it read (null: none), so a lock step asks
   *  `shipOf` once per player, not once per group (#14). */
  private syncShip(playerId: string, p: PlayerLocks): LockShip | null {
    const ship = this.deps.shipOf(playerId);
    if (!ship) return null;
    const sig = ship.activated.length;
    if (ship.kind.id === p.kindId && sig === p.activatedSig) return ship;
    // Keep each group's mode across a rebuild of the same kind; locks reset.
    const prevModes = new Map<string, GroupMode>();
    if (ship.kind.id === p.kindId) for (const g of p.groups) prevModes.set(g.id, g.mode);
    p.kindId = ship.kind.id;
    p.activatedSig = sig;
    p.sensor = sensorFor(ship.kind) * NO_PILOT_MODS.lockSpeed;
    p.groups.length = 0;
    p.wire.length = 0;
    for (const { slot, mounts } of shipGroups(ship.kind, ship.activated)) {
      const geo = groupGeometry(mounts);
      const mode: GroupMode = prevModes.get(slot.id) ?? (p.startManual ? 'manual' : slot.defaultMode ?? 'auto');
      const wire: WireGroup = { id: slot.id, m: mode === 'auto' ? 0 : 1, l: [] };
      p.groups.push({
        id: slot.id,
        mode,
        slotMode: slot.defaultMode ?? 'auto',
        capacity: lockCapacityFor(ship.kind, slot, NO_PILOT_MODS),
        refSize: geo.refSize,
        tracking: geo.tracking,
        absRange: geo.absRange,
        reach: geo.reach,
        size: geo.size,
        arcs: groupArcs(mounts),
        mountIds: new Set(mounts.map((m) => m.id)),
        mounts,
        locks: [],
        wire,
      });
      p.wire.push(wire);
    }
    return ship;
  }

  private group(p: PlayerLocks, groupId: string): GroupState | null {
    for (const g of p.groups) if (g.id === groupId) return g;
    return null;
  }

  /** Player asked to lock `key` with `groupId`. Returns false when refused. */
  requestLock(playerId: string, groupId: string, key: string): boolean {
    const p = this.players.get(playerId);
    if (!p || !this.sync(playerId, p)) return false;
    const g = this.group(p, groupId);
    if (!g) return false;
    for (const e of g.locks) {
      if (e.target !== key) continue;
      e.track = LOCK_TRACK.commit; // e.g. a draining held lock: now it runs to completion
      this.syncWireShape(g);
      return true;
    }
    if (!this.deps.resolveTarget(playerId, key, this.target)) return false;
    const entry = newLock(key, this.target.hostile || this.target.terrain);
    entry.flags = lockSalvageFlags(this.deps, this.deps.shipOf(playerId), playerId, key);
    // testMode `instantLock`: complete it here, not at the next lock step, so
    // the wire never shows it one step at LOCKING 0% (a red ring flash).
    if (p.instant && this.deps.shooterPose(playerId, this.shooter) && Number.isFinite(this.lockSecsNow(p, g))) {
      this.completeInstant(playerId, entry);
    }
    this.makeRoom(g);
    g.locks.push(entry);
    g.wire.l.push({ t: key, s: LOCK_STAGE_CODE[entry.stage], p: 0 });
    this.syncWireShape(g);
    return true;
  }

  /**
   * The pilot's lock line is on `key` (null = on nothing / let go). The held
   * target builds; any other held lock in the group is released and drains.
   * The line coming back onto a draining target resumes it.
   *
   * Verified, not trusted: the target must lie on the line along `bearing`
   * (world, ship-angle convention) by the shared rule `lockLineHolds`
   * (core/combat/lockLine.ts: the client's own pick rule, sticky cone). A claim
   * that fails, or carries no bearing, counts as "on nothing": the held lock
   * is released.
   */
  trackLock(playerId: string, groupId: string, key: string | null, bearing?: number): void {
    const p = this.players.get(playerId);
    if (!p || !this.sync(playerId, p)) return;
    const g = this.group(p, groupId);
    if (!g) return;
    if (key !== null && !this.onLine(playerId, g, key, bearing)) key = null;
    let found = false;
    for (const e of g.locks) {
      if (key !== null && e.target === key) {
        found = true;
        if (e.track === LOCK_TRACK.released) e.track = LOCK_TRACK.held;
      } else if (e.track === LOCK_TRACK.held) {
        e.track = LOCK_TRACK.released;
      }
    }
    if (key !== null && !found && this.deps.resolveTarget(playerId, key, this.target)) {
      this.makeRoom(g);
      g.locks.push(newLock(key, this.target.hostile || this.target.terrain, LOCK_TRACK.held));
    }
    this.syncWireShape(g);
  }

  /** Does `key` lie on the pilot's lock line along `bearing`? (Fills `this.target`.) */
  private onLine(playerId: string, g: GroupState, key: string, bearing: number | undefined): boolean {
    if (bearing === undefined || !Number.isFinite(bearing)) return false;
    if (!this.deps.shooterPose(playerId, this.shooter)) return false;
    if (!this.deps.resolveTarget(playerId, key, this.target)) return false;
    return lockLineHolds(this.target.x - this.shooter.x, this.target.y - this.shooter.y, bearing, this.target.radius, g.reach);
  }

  /**
   * Test hook (integration `_internals.forceLock`): make `key` a completed
   * lock of `groupId` (every group when absent) now. Returns how many groups
   * took it (0 when the pilot, group or target doesn't resolve).
   */
  forceLock(playerId: string, key: string, groupId?: string): number {
    const p = this.players.get(playerId);
    if (!p || !this.sync(playerId, p)) return 0;
    if (!this.deps.resolveTarget(playerId, key, this.target)) return 0;
    let n = 0;
    for (const g of p.groups) {
      if (groupId !== undefined && g.id !== groupId) continue;
      let e: LockEntry | undefined;
      for (const x of g.locks) if (x.target === key) e = x;
      if (!e) {
        this.makeRoom(g);
        e = newLock(key, true);
        g.locks.push(e);
      }
      e.stage = 'locked';
      e.progress = 1;
      e.lostFor = 0;
      e.flags = lockSalvageFlags(this.deps, this.deps.shipOf(playerId), playerId, key);
      this.syncWireShape(g);
      n++;
    }
    return n;
  }

  /** Free a slot when the group is full: a draining lock goes first, else the oldest. */
  private makeRoom(g: GroupState): void {
    if (g.locks.length < g.capacity) return;
    let i = g.locks.findIndex((e) => e.track === LOCK_TRACK.released && e.stage !== 'locked');
    if (i < 0) i = 0;
    g.locks.splice(i, 1);
  }

  /** Cancel one lock (or every lock in the group when `key` is absent). */
  cancelLock(playerId: string, groupId: string, key?: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    const g = this.group(p, groupId);
    if (!g) return;
    if (key === undefined) g.locks.length = 0;
    else {
      const i = g.locks.findIndex((e) => e.target === key);
      if (i >= 0) g.locks.splice(i, 1);
    }
    this.syncWireShape(g);
  }

  setMode(playerId: string, groupId: string, mode: GroupMode): void {
    const p = this.players.get(playerId);
    if (!p || !this.sync(playerId, p)) return;
    const g = this.group(p, groupId);
    if (!g) return;
    g.mode = mode;
    g.wire.m = mode === 'auto' ? 0 : 1;
    if (mode === 'manual') {
      // A lock AUTO was still building belongs to AUTO: MAN never self-picks, so
      // drop it (1v3 clip: both groups ended up on one fighter). Finished locks
      // and locks the pilot asked for stay.
      let removed = false;
      for (let i = g.locks.length - 1; i >= 0; i--) {
        const e = g.locks[i]!;
        if (e.auto && e.stage !== 'locked') { g.locks.splice(i, 1); removed = true; }
      }
      if (removed) this.syncWireShape(g);
    }
  }

  /** True when `groupId` holds at least one LOCKED target — the fire gate. */
  hasLocked(playerId: string, groupId: string | undefined): boolean {
    const p = this.players.get(playerId);
    if (!p) return false; // untracked: no locks, so no fire
    const g = groupId === undefined ? p.groups[0] : this.group(p, groupId);
    if (!g) return false;
    for (const e of g.locks) if (e.stage === 'locked') return true;
    return false;
  }

  /**
   * The target a mount should aim at: its group's first LOCKED target, else the
   * first acquiring one (turrets pre-slew while locking). Null = no target.
   */
  aimKeyFor(playerId: string, mountId: string): string | null {
    const p = this.players.get(playerId);
    if (!p) return null;
    for (const g of p.groups) {
      if (!g.mountIds.has(mountId)) continue;
      let acquiring: string | null = null;
      let first: LockEntry | null = null;
      let n = 0;
      for (const e of g.locks) {
        if (e.stage === 'locked') {
          if (first === null) first = e;
          n++;
        } else if (acquiring === null && e.stage === 'acquiring') acquiring = e.target;
      }
      if (first === null) return acquiring;
      // One plain lock: every mount on it. A salvage lock goes through the pick (a laser skips a haulable piece).
      if (n === 1 && first.flags === 0) return first.target;
      const k = this.pickLocked(playerId, g, mountId);
      return k === undefined ? first.target : k;
    }
    return null;
  }

  private readonly pickX = new Float64Array(TURRET_PICK_MAX);
  private readonly pickY = new Float64Array(TURRET_PICK_MAX);
  private readonly pickFlags = new Uint8Array(TURRET_PICK_MAX);
  private readonly pickKeys: string[] = [];
  /** Per-lock hit shapes for `pickTurretLock`'s hull range gate (reused, #14). */
  private readonly pickShapes: { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] }[] =
    Array.from({ length: TURRET_PICK_MAX }, () => ({ kindId: null, angle: 0, shieldUp: false, radius: 0 }));

  /**
   * Which LOCKED target this turret takes (shared `pickTurretLock` with the
   * locks' salvage bits, the same rule as the client's predicted aim, #15).
   * Null = no aim (`TURRET_NO_LOCK`: a mining laser whose locks are all
   * haulable); undefined when the ship pose or the mount can't be resolved
   * (the caller falls back to the first lock).
   */
  private pickLocked(playerId: string, g: GroupState, mountId: string): string | null | undefined {
    let ordinal = -1;
    for (let i = 0; i < g.mounts.length; i++) if (g.mounts[i]!.id === mountId) { ordinal = i; break; }
    if (ordinal < 0 || !this.deps.shooterPose(playerId, this.shooter)) return undefined;
    const keys = this.pickKeys;
    keys.length = 0;
    // Every LOCKED lock, as the client's `FcMountPicker` lists the wire locks
    // (#15): one it can't resolve gets a NaN pose (never engageable), as the
    // client does for a lock outside its mirror.
    for (const e of g.locks) {
      if (e.stage !== 'locked' || keys.length >= this.pickX.length) continue;
      this.pickFlags[keys.length] = e.flags;
      const sh = this.pickShapes[keys.length]!;
      if (this.deps.resolveTarget(playerId, e.target, this.target)) {
        this.pickX[keys.length] = this.target.x;
        this.pickY[keys.length] = this.target.y;
        sh.kindId = this.target.ship ? this.target.kindId : null;
        sh.angle = this.target.angle;
        sh.shieldUp = this.target.shieldUp;
        sh.radius = this.target.ship ? 0 : this.target.radius;
      } else {
        this.pickX[keys.length] = NaN;
        this.pickY[keys.length] = NaN;
        sh.kindId = null; sh.angle = 0; sh.shieldUp = false; sh.radius = 0;
      }
      keys.push(e.target);
    }
    if (keys.length === 0) return undefined;
    const m = g.mounts[ordinal]!;
    const s = this.shooter;
    const cosA = Math.cos(s.angle);
    const sinA = Math.sin(s.angle);
    const mx = s.x + (m.localX * cosA - m.localY * sinA);
    const my = s.y + (m.localX * sinA + m.localY * cosA);
    const i = pickTurretLock(m, s.angle, mx, my, mountWeaponReach(m), ordinal, keys.length, this.pickX, this.pickY, this.pickShapes, this.pickFlags, g.mounts);
    return i === TURRET_NO_LOCK ? null : keys[i]!;
  }

  /** Build the tracked id's groups now (they are otherwise built lazily by the
   *  first lock request) and return them, or undefined when it has none.
   *  RTS slice 5: a wingman reads its group ids before asking for locks. */
  ensureGroups(playerId: string): WireGroup[] | undefined {
    const p = this.players.get(playerId);
    if (!p || !this.sync(playerId, p)) return undefined;
    return p.wire.length > 0 ? p.wire : undefined;
  }

  /** Own-ship snapshot slice (shared ref, mutated in place), or undefined when empty. */
  wireFor(playerId: string): WireGroup[] | undefined {
    const p = this.players.get(playerId);
    if (!p || p.wire.length === 0) return undefined;
    return p.wire;
  }

  /** Advance every lock by one lock step. Call every 6 server ticks. */
  step(): void {
    for (const [playerId, p] of this.players) {
      const ship = this.syncShip(playerId, p);
      if (ship === null) continue;
      if (!this.deps.shooterPose(playerId, this.shooter)) continue;
      for (const g of p.groups) this.stepGroup(playerId, p, g, ship);
    }
  }

  /** `this.target` is inside the group's FIRE range: some mount reaches its
   *  hit shape within its reach × `slack`, by the player fire gate's own
   *  range test (`mountInReach`). `this.shooter` must be current. */
  private inFireRange(g: GroupState, slack: number): boolean {
    const s = this.shooter;
    const cosA = Math.cos(s.angle);
    const sinA = Math.sin(s.angle);
    for (let i = 0; i < g.mounts.length; i++) {
      const m = g.mounts[i]!;
      const ox = s.x + (m.localX * cosA - m.localY * sinA);
      const oy = s.y + (m.localX * sinA + m.localY * cosA);
      if (mountInReach(this.target.x - ox, this.target.y - oy, mountWeaponReach(m) * slack, this.target)) return true;
    }
    return false;
  }

  private stepGroup(playerId: string, p: PlayerLocks, g: GroupState, ship: LockShip): void {
    // Locks work at any distance (owner 2026-11-14). An AUTO group's own pick
    // is released once its target leaves the group's FIRE range (reach ×
    // `reachSlack`, the hysteresis over the in-reach pick), so AUTO re-picks
    // instead of sitting on a target it can't shoot. A lock the pilot asked
    // for (manual, or a lock line) persists at any distance.
    if (g.mode === 'auto') {
      for (let i = g.locks.length - 1; i >= 0; i--) {
        const e = g.locks[i]!;
        if (!e.auto) continue;
        if (this.deps.resolveTarget(playerId, e.target, this.target) && this.inFireRange(g, LOCK_TUNING.reachSlack)) continue;
        g.locks.splice(i, 1);
        this.syncWireShape(g);
      }
    }
    // Auto groups acquire their own target when idle.
    if (g.locks.length === 0 && g.mode === 'auto') {
      this.bearGroup = g;
      const key = this.deps.autoPick(playerId, g.reach, this.shooter.x, this.shooter.y, this.bears, p.anyTarget, g.size);
      this.bearGroup = null;
      if (key !== null && this.deps.resolveTarget(playerId, key, this.target)) {
        const auto = newLock(key, true);
        auto.auto = true;
        g.locks.push(auto);
        g.wire.l.push({ t: key, s: LOCK_STAGE_CODE.acquiring, p: 0 });
      }
    }
    let removed = false;
    for (let i = g.locks.length - 1; i >= 0; i--) {
      const e = g.locks[i]!;
      let secs = Infinity;
      if (this.deps.resolveTarget(playerId, e.target, this.target)) {
        secs = this.lockSecsNow(p, g);
        e.flags = lockSalvageFlags(this.deps, ship, playerId, e.target); // hold fills, pieces split: per step
      } else {
        // Gone (destroyed / left): drop now, no grace.
        g.locks.splice(i, 1);
        removed = true;
        continue;
      }
      const failsafeSecs = Number.isFinite(secs) ? secs * LOCK_TUNING.failsafeMul : LOCK_TUNING.baseSeconds * LOCK_TUNING.failsafeMul;
      if (p.instant && Number.isFinite(secs) && e.stage !== 'locked' && e.track !== LOCK_TRACK.released) {
        this.completeInstant(playerId, e);
        continue;
      }
      const ev = stepLock(e, LOCK_DT, secs, failsafeSecs, LOCK_TUNING.lostGraceSeconds, LOCK_TUNING.decayMul);
      // Terrain is never a hostile act (it never enters `failsafe` either).
      if (ev === 'commit') { if (!this.target.terrain) this.deps.commitHostileAct(playerId, e.target); }
      // Being targeted is a hostile act: a live (not draining) lock past its
      // failsafe keeps the target's hostility current. A failsafe ring is still
      // harmless until it commits; a non-hostile target never gets here
      // except through that commit.
      else if (ev !== 'dropped' && this.target.hostile && !this.target.terrain && e.stage !== 'failsafe'
        && (e.track !== LOCK_TRACK.released || e.stage === 'locked')) {
        this.deps.refreshHostility(playerId, e.target);
      }
      if (ev === 'dropped') {
        g.locks.splice(i, 1);
        removed = true;
      }
    }
    if (removed || g.wire.l.length !== g.locks.length) this.syncWireShape(g);
    else for (let i = 0; i < g.locks.length; i++) this.writeWire(g.wire.l[i]!, g.locks[i]!);
  }

  /** Lock time (s) of `this.target` for group `g` from `this.shooter` (both
   *  current). Infinity = can't lock right now. */
  private lockSecsNow(p: PlayerLocks, g: GroupState): number {
    const inp = this.inputs, t = this.target, s = this.shooter;
    inp.refSize = g.refSize; inp.tracking = g.tracking; inp.absRange = g.absRange; inp.reach = g.reach;
    inp.sensor = p.sensor; inp.pilotSpeed = 1; inp.signature = t.radius;
    inp.dx = t.x - s.x; inp.dy = t.y - s.y; inp.dvx = t.vx - s.vx; inp.dvy = t.vy - s.vy;
    return lockSeconds(inp, LOCK_TUNING);
  }

  /** testMode `instantLock`: lock `e` (on `this.target`) completes now (a failsafe still commits). */
  private completeInstant(playerId: string, e: LockEntry): void {
    if (e.stage === 'failsafe' && !this.target.terrain) this.deps.commitHostileAct(playerId, e.target);
    e.stage = 'locked'; e.progress = 1; e.lostFor = 0;
  }

  private writeWire(w: WireLock, e: LockEntry): void {
    w.t = e.target;
    w.s = LOCK_STAGE_CODE[e.stage];
    w.p = Math.round(Math.max(0, Math.min(1, e.progress)) * 100);
    if (e.track === LOCK_TRACK.released && e.stage !== 'locked') w.r = 1;
    else if (w.r !== undefined) delete w.r;
    if (e.lostFor > 0) w.c = 1;
    else if (w.c !== undefined) delete w.c;
    if (e.flags !== 0) w.f = e.flags;
    else if (w.f !== undefined) delete w.f;
  }

  /** Re-shape a group's wire list to match its locks (only on add/remove). */
  private syncWireShape(g: GroupState): void {
    const l = g.wire.l;
    while (l.length > g.locks.length) l.pop();
    while (l.length < g.locks.length) l.push({ t: '', s: 0, p: 0 });
    for (let i = 0; i < g.locks.length; i++) this.writeWire(l[i]!, g.locks[i]!);
  }
}
