/**
 * Target locks per player per weapon group (exp/fire-control P2). Server
 * authority: a group may only fire at a target it has LOCKED, so locks gate
 * fire (`PlayerFireResolver`) and drive turret aim (`WeaponMountTicker`).
 *
 * Only players who joined with `fireControl` are tracked; everyone else plays
 * the legacy rules untouched.
 *
 * Steady state allocates nothing (#14): group/lock/wire objects are created on
 * join, on a new lock or on a ship change, then mutated in place.
 */
import { LOCK_TUNING, WEAPON_LOCK_PROFILE, lockCapacityFor, sensorFor, NO_PILOT_MODS, type MountSize } from '../../shared-types/combat/lockProfile.js';
import { lockSeconds, type LockInputs } from '../../core/combat/lockTime.js';
import { newLock, stepLock, LOCK_STAGE_CODE, type LockEntry } from '../../core/combat/lockState.js';
import { getWeapon, weaponAutoFireRange } from '../../core/combat/WeaponCatalogue.js';
import type { ShipKind, WeaponMount, WeaponSlot } from '../../shared-types/shipKinds/types.js';

/** A lockable target, resolved each lock step. */
export interface LockTargetView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Lock signature (u). */
  signature: number;
  /** Already hostile to the locking player (skips the failsafe ring). */
  hostile: boolean;
}

export interface LockShooterView {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface LockSubsystemDeps {
  /** Fill `out` with the target's pose; false when it is gone or can't be damaged. */
  resolveTarget(playerId: string, key: string, out: LockTargetView): boolean;
  /** Fill `out` with the player's active ship pose; false when they have none. */
  shooterPose(playerId: string, out: LockShooterView): boolean;
  /** The player's active ship kind + activated mounts, or null. */
  shipOf(playerId: string): { kind: ShipKind; activated: ReadonlyArray<WeaponMount> } | null;
  /** Best auto target for a group (hostile, in reach), or null. */
  autoPick(playerId: string, reach: number, sx: number, sy: number): string | null;
  /** A failsafe finished: the player has committed a hostile act on `key`. */
  commitHostileAct(playerId: string, key: string): void;
}

export type GroupMode = 'auto' | 'manual';

/** Wire shape of one group in the own-ship snapshot (`states[].groups`). */
export interface WireLock { t: string; s: number; p: number }
export interface WireGroup { id: string; m: 0 | 1; l: WireLock[] }

interface GroupState {
  id: string;
  mode: GroupMode;
  capacity: number;
  refSize: number;
  tracking: number;
  reach: number;
  mountIds: Set<string>;
  locks: LockEntry[];
  wire: WireGroup;
}

interface PlayerLocks {
  kindId: string;
  activatedSig: number;
  sensor: number;
  groups: GroupState[];
  wire: WireGroup[];
}

const SIZE_RANK: Record<MountSize | 'none', number> = { none: 0, AA: 1, S: 2, M: 3, L: 4, XL: 5 };

/** Build a group's lock geometry from its mounts (largest size wins). */
function groupGeometry(mounts: ReadonlyArray<WeaponMount>): { refSize: number; tracking: number; reach: number } {
  let size: MountSize | 'none' = 'none';
  let reach = 0;
  for (const m of mounts) {
    const s = (m.size ?? 'none') as MountSize | 'none';
    if (SIZE_RANK[s] > SIZE_RANK[size]) size = s;
    const r = weaponAutoFireRange(getWeapon(m.weaponId));
    if (r > reach) reach = r;
  }
  const p = WEAPON_LOCK_PROFILE[size];
  return { refSize: p.refSize, tracking: p.tracking, reach };
}

/** Weapon groups of a ship: its slots, with activated latent mounts as their own 'wing' group. */
export function shipGroups(
  kind: ShipKind,
  activated: ReadonlyArray<WeaponMount>,
): Array<{ slot: WeaponSlot; mounts: WeaponMount[] }> {
  const out: Array<{ slot: WeaponSlot; mounts: WeaponMount[] }> = [];
  const byId = new Map<string, WeaponMount>();
  for (const m of kind.mounts ?? []) byId.set(m.id, m);
  for (const slot of kind.slots ?? []) {
    const mounts: WeaponMount[] = [];
    for (const id of slot.mountIds) {
      const m = byId.get(id);
      if (m) mounts.push(m);
    }
    if (mounts.length > 0) out.push({ slot, mounts });
  }
  if (activated.length > 0) {
    out.push({ slot: { id: 'wing', displayName: 'Wing', mountIds: activated.map((m) => m.id) }, mounts: [...activated] });
  }
  return out;
}

const LOCK_DT = 0.1; // seconds per lock step (every 6 server ticks)

export class LockSubsystem {
  private readonly players = new Map<string, PlayerLocks>();
  private readonly target: LockTargetView = { x: 0, y: 0, vx: 0, vy: 0, signature: 1, hostile: false };
  private readonly shooter: LockShooterView = { x: 0, y: 0, vx: 0, vy: 0 };
  private readonly inputs: LockInputs = {
    refSize: 1, tracking: 1, reach: 1, sensor: 1, pilotSpeed: 1, signature: 1, dx: 0, dy: 0, dvx: 0, dvy: 0,
  };

  constructor(private readonly deps: LockSubsystemDeps) {}

  /** Opt a player in (they joined with `fireControl`). */
  enable(playerId: string): void {
    if (!this.players.has(playerId)) {
      this.players.set(playerId, { kindId: '', activatedSig: -1, sensor: 1, groups: [], wire: [] });
    }
  }

  isEnabled(playerId: string): boolean {
    return this.players.has(playerId);
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

  /** (Re)build the player's groups when their ship kind or activated mounts change. */
  private sync(playerId: string, p: PlayerLocks): boolean {
    const ship = this.deps.shipOf(playerId);
    if (!ship) return false;
    const sig = ship.activated.length;
    if (ship.kind.id === p.kindId && sig === p.activatedSig) return true;
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
      const mode: GroupMode = prevModes.get(slot.id) ?? slot.defaultMode ?? 'auto';
      const wire: WireGroup = { id: slot.id, m: mode === 'auto' ? 0 : 1, l: [] };
      p.groups.push({
        id: slot.id,
        mode,
        capacity: lockCapacityFor(ship.kind, slot, NO_PILOT_MODS),
        refSize: geo.refSize,
        tracking: geo.tracking,
        reach: geo.reach,
        mountIds: new Set(mounts.map((m) => m.id)),
        locks: [],
        wire,
      });
      p.wire.push(wire);
    }
    return true;
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
    for (const e of g.locks) if (e.target === key) return true; // already locking it
    if (!this.deps.resolveTarget(playerId, key, this.target)) return false;
    const entry = newLock(key, this.target.hostile);
    if (g.locks.length >= g.capacity) g.locks.shift(); // queue full: the oldest goes
    g.locks.push(entry);
    g.wire.l.push({ t: key, s: LOCK_STAGE_CODE[entry.stage], p: 0 });
    this.syncWireShape(g);
    return true;
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
  }

  /** True when `groupId` holds at least one LOCKED target — the fire gate. */
  hasLocked(playerId: string, groupId: string | undefined): boolean {
    const p = this.players.get(playerId);
    if (!p) return true; // not fire-control: legacy rules
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
      for (const e of g.locks) {
        if (e.stage === 'locked') return e.target;
        if (acquiring === null && e.stage === 'acquiring') acquiring = e.target;
      }
      return acquiring;
    }
    return null;
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
      if (!this.sync(playerId, p)) continue;
      if (!this.deps.shooterPose(playerId, this.shooter)) continue;
      for (const g of p.groups) this.stepGroup(playerId, p, g);
    }
  }

  private stepGroup(playerId: string, p: PlayerLocks, g: GroupState): void {
    // Auto groups acquire their own target when idle.
    if (g.locks.length === 0 && g.mode === 'auto') {
      const key = this.deps.autoPick(playerId, g.reach, this.shooter.x, this.shooter.y);
      if (key !== null && this.deps.resolveTarget(playerId, key, this.target)) {
        g.locks.push(newLock(key, true));
        g.wire.l.push({ t: key, s: LOCK_STAGE_CODE.acquiring, p: 0 });
      }
    }
    let removed = false;
    for (let i = g.locks.length - 1; i >= 0; i--) {
      const e = g.locks[i]!;
      let secs = Infinity;
      if (this.deps.resolveTarget(playerId, e.target, this.target)) {
        const inp = this.inputs;
        inp.refSize = g.refSize;
        inp.tracking = g.tracking;
        inp.reach = g.reach;
        inp.sensor = p.sensor;
        inp.pilotSpeed = 1;
        inp.signature = this.target.signature;
        inp.dx = this.target.x - this.shooter.x;
        inp.dy = this.target.y - this.shooter.y;
        inp.dvx = this.target.vx - this.shooter.vx;
        inp.dvy = this.target.vy - this.shooter.vy;
        secs = lockSeconds(inp, LOCK_TUNING);
      } else {
        // Gone (destroyed / left): drop now, no grace.
        g.locks.splice(i, 1);
        removed = true;
        continue;
      }
      const failsafeSecs = Number.isFinite(secs) ? secs * LOCK_TUNING.failsafeMul : LOCK_TUNING.baseSeconds * LOCK_TUNING.failsafeMul;
      const ev = stepLock(e, LOCK_DT, secs, failsafeSecs, LOCK_TUNING.lostGraceSeconds);
      if (ev === 'commit') this.deps.commitHostileAct(playerId, e.target);
      if (ev === 'dropped') {
        g.locks.splice(i, 1);
        removed = true;
      }
    }
    if (removed || g.wire.l.length !== g.locks.length) this.syncWireShape(g);
    else for (let i = 0; i < g.locks.length; i++) this.writeWire(g.wire.l[i]!, g.locks[i]!);
  }

  private writeWire(w: WireLock, e: LockEntry): void {
    w.t = e.target;
    w.s = LOCK_STAGE_CODE[e.stage];
    w.p = Math.round(Math.min(1, e.progress) * 100);
  }

  /** Re-shape a group's wire list to match its locks (only on add/remove). */
  private syncWireShape(g: GroupState): void {
    const l = g.wire.l;
    while (l.length > g.locks.length) l.pop();
    while (l.length < g.locks.length) l.push({ t: '', s: 0, p: 0 });
    for (let i = 0; i < g.locks.length; i++) this.writeWire(l[i]!, g.locks[i]!);
  }
}
