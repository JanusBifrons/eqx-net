/**
 * Client fire control (#16, #19): the own groups and their locks from the
 * snapshot, the lock line (`lock_track`), lock requests, per-mount turret aim
 * (`fcTickMountAngles`, #12) and the fire pass (`fcFireTick`, the only client
 * fire path). `ColyseusClient` owns one and keeps one-line delegates for its
 * public lock methods; fire dispatch, prediction and the clock stay there and
 * are reached through `FireControlHost`.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { isOwnedByMe } from '../render/shipOwnership.js';
import { useUIStore } from '../state/store';
import { fillFireTargetShape, fillRangeShape, mountFiresOn, newFireTargetShape, type FireTargetShape } from '@core/combat/fireControlBearing';
import { FcMountPicker, fcNeedsPick, type FcMountDef } from './fcMountPick';
import { hasTurretFireControl, mountWeaponReach, weaponIdReach, type MountRangeTarget } from '@core/combat/mountReach';
import { getWeapon, type WeaponDef, type WeaponId } from '@core/combat/WeaponCatalogue';
import { canAfford, resolveSlotEnergyCost } from '@core/combat/Energy';
import { resolveSlotMounts } from '@shared-types/shipKinds/slots';
import { LockLineClient } from './fireControl/LockLineClient';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';
import { rotateMountToward, wrapPi } from '@core/ai/WeaponMountController';
import type { FcGroupSummary } from '../state/storeTypes';

/** What fire control reads from / does through its `ColyseusClient` (built once). */
export interface FireControlHost {
  room(): Room | null;
  /** Wall-clock ms (`clock.now()`). */
  now(): number;
  /** Local ship alive, predicted, connected and not disabled. */
  canFire(): boolean;
  /** Predicted own-ship pose (predWorld). */
  shipState(localId: string): { x: number; y: number; angle: number } | null | undefined;
  predEnergy(): number;
  inputTick(): number;
  sendFire(tick: number): void;
  updateLiveBeam(): void;
  /** A group fire went out at `tick` (`lastFiredAtTick`). */
  fired(tick: number): void;
  /** A hitscan group fired at `nowMs` (`_lastHitscanFireMs`). */
  hitscanFired(nowMs: number): void;
}

export class FireControlClient {
  constructor(private readonly mirror: RenderMirror, private readonly host: FireControlHost) {
    this.line = new LockLineClient(mirror, () => host.room());
  }

  private get room(): Room | null { return this.host.room(); }
  /** The lock line (pick + `lock_track`). */
  private readonly line: LockLineClient;
  private get inputTick(): number { return this.host.inputTick(); }
  private get predEnergy(): number { return this.host.predEnergy(); }

  // ── Fire control (universal: every weapon group fires only at a lock) ────
  /** The own-ship snapshot's groups (server truth; replaced each snapshot). */
  private _fcGroups: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number; c?: number; f?: number }> }> = [];
  /** Hash of the HUD-visible group summary; the store is written on change only. */
  private _fcSummarySig = -1;
  /** Group the pilot is holding to fire (manual mode), or null. */
  private _fcHeld: string | null = null;
  private readonly _fcLastFireMs = new Map<string, number>();
  private readonly _fcLastFireTick = new Map<string, number>();
  /** Per-kind group info, rebuilt when the ship kind changes. */
  private _fcInfoKind: string | null | undefined = undefined;
  private readonly _fcInfo = new Map<string, { cooldownMs: number; cooldownTicks: number; mode: WeaponDef['mode']; reach: number; energyCost: number; name: string; colour: number; capacity: number }>();
  private readonly _fcMountGroup = new Map<string, string>();
  /** Per mount: its definition, its place in its group (the `pickTurretLock`
   *  ordinal), its reach and its group's mounts. Rebuilt with `_fcMountGroup`. */
  private readonly _fcMountDef = new Map<string, FcMountDef>();
  /** True when the ship's turrets fire one by one on their own reload (capitals). */
  _fcPerMount = false;
  /** Per-mount fire ledger (capitals): wall ms + input tick of each mount's last shot. */
  private readonly _fcMountLastMs = new Map<string, number>();
  private readonly _fcMountLastTick = new Map<string, number>();
  /** Mounts in the salvo being sent (capitals; empty = every bearing mount). */
  private readonly _fcSalvo = new Set<string>();
  /** Mounts that bore on their target this fire tick (capitals): the only
   *  ones `updateLiveBeam` draws a beam from. */
  readonly _fcBearing = new Set<string>();
  /** Per-mount lock pick (shared `pickTurretLock` with the salvage bits, #15). */
  private readonly _fcPicker = new FcMountPicker((k, o) => this.fcTargetPose(k, o), (k, o) => this.fcTargetShape(k, o));
  /** Parsed lock keys (`s:<n>` / `p:<id>`), so per-frame lookups never slice strings. */
  private readonly _fcKeys = new Map<string, { swarm: number; player: string | null }>();
  private readonly _fcPose: FireTargetShape = newFireTargetShape();
  /** Slot to fire in `sendFire` / `localShipMounts` instead of the store's active slot. */
  _fireSlotOverride: string | null = null;

  /** Ask the server to lock `targetKey` with weapon group `groupId`. */
  requestLock(groupId: string, targetKey: string): void {
    if (!this.room) return;
    this.room.send('lock_request', { type: 'lock_request', groupId, target: targetKey });
  }

  /** A weapon group's lock-reach basis (u, before `LOCK_TUNING.reachSlack`) for the local
   *  ship: the same `mountWeaponReach` max the server's `groupGeometry` uses. 0 = unknown.
   *  Read by the contacts overview at 4 Hz, never per frame. */
  fcGroupReach(groupId: string): number {
    const id = this.mirror.localPlayerId;
    const ship = id ? this.mirror.ships.get(id) : undefined;
    if (!ship) return 0;
    this.fcSyncKind(ship.kind ?? null);
    return this._fcInfo.get(groupId)?.reach ?? 0;
  }

  /** Drop one lock (or all of a group's locks when no key). */
  cancelLock(groupId: string, targetKey?: string): void {
    if (!this.room) return;
    this.room.send('lock_cancel', targetKey === undefined
      ? { type: 'lock_cancel', groupId }
      : { type: 'lock_cancel', groupId, target: targetKey });
  }

  setGroupMode(groupId: string, mode: 'auto' | 'manual'): void {
    if (!this.room) return;
    this.room.send('set_group_mode', { type: 'set_group_mode', groupId, mode });
  }

  /** Manual mode: hold a group's chip to fire it (null = release). */
  setGroupHeld(groupId: string | null): void {
    this._fcHeld = groupId;
  }

  /**
   * Smart-aim lock: the pilot is dragging a guideline along `bearing` (world,
   * ship-angle convention). Picks the lockable target nearest the line within
   * the active group's reach — the shared `lockLineScore` rule, the same one
   * the server uses to verify `lock_track` (#15) — and publishes guide +
   * candidate for the renderer. Called from pointer handlers (not the frame
   * loop), but still alloc-free per candidate (#14): cached key strings, a
   * bound visitor instead of a per-call closure. NaN clears the guide.
   */
  updateLockGuide(bearing: number): string | null {
    const m = this.mirror;
    if (Number.isNaN(bearing)) {
      m.localLockGuide = NaN;
      m.localLockCandidate = null;
      return null;
    }
    const localId = m.localPlayerId;
    const ship = localId ? m.ships.get(localId) : undefined;
    if (!localId || !ship) return null;
    this.fcSyncKind(ship.kind ?? null);
    const active = useUIStore.getState().activeGroupId;
    const reach = (active && this._fcInfo.get(active)?.reach) || 600;
    m.localLockGuide = bearing;
    m.localAimReach = reach;
    const best = this.line.pick(localId, ship.x, ship.y, bearing, reach, m.localLockCandidate ?? null);
    m.localLockCandidate = best;
    return best;
  }

  /**
   * Held lock line: point the line along `bearing` and hold whatever it lands
   * on. The server builds a lock only while it's held; moving off (or letting
   * go) releases it and it drains back to 0. Sends only when the held target
   * changes. Call on every drag move AND periodically while held (targets move).
   */
  guideLock(bearing: number): void {
    const key = this.updateLockGuide(bearing);
    this.line.trackLock(key, bearing);
  }

  /** Let go of the lock line: whatever it held drains unless already locked. */
  releaseLockGuide(): void {
    this.mirror.localLockGuide = NaN;
    this.mirror.localLockCandidate = null;
    this.line.trackLock(null, NaN);
  }

  /** Lock whatever the pilot has selected (inspector Target button / T key). */
  lockSelected(): boolean {
    const st = useUIStore.getState();
    const id = st.selection.focusId;
    const active = st.activeGroupId;
    if (!id || !active) return false;
    let key: string | null = null;
    if (id.startsWith('swarm-')) key = `s:${id.slice(6)}`;
    else {
      // Another player's ship, pilot- or AI-flown (the mirror key is the lock
      // key); never one of your own.
      const ship = this.mirror.ships.get(id);
      if (ship !== undefined && !isOwnedByMe(this.mirror, id, ship)) key = `p:${id}`;
    }
    if (key === null) return false;
    this.requestLock(active, key);
    return true;
  }

  /** Rebuild per-kind group info (only when the ship kind changes). */
  fcSyncKind(kindStr: string | null): void {
    if (kindStr === this._fcInfoKind) return;
    this._fcInfoKind = kindStr;
    this._fcInfo.clear();
    this._fcMountGroup.clear();
    this._fcMountDef.clear();
    this._fcMountLastMs.clear();
    this._fcMountLastTick.clear();
    const kind = getShipKind(kindStr);
    this._fcPerMount = hasTurretFireControl(kind);
    const slots = kind.slots ?? [];
    for (let si = 0; si < slots.length; si++) {
      const slot = slots[si]!;
      const mounts = resolveSlotMounts(kind, slot.id);
      let cd = 0;
      let reach = 0;
      for (let mi = 0; mi < mounts.length; mi++) {
        const m = mounts[mi]!;
        const w = getWeapon(m.weaponId);
        if (w.cooldownTicks > cd) cd = w.cooldownTicks;
        const r = mountWeaponReach(m);
        if (r > reach) reach = r;
        this._fcMountGroup.set(m.id, slot.id);
        this._fcMountDef.set(m.id, { mount: m, ordinal: mi, reach: r, group: mounts });
      }
      this._fcInfo.set(slot.id, {
        cooldownMs: (cd * 1000) / 60,
        cooldownTicks: cd,
        mode: getWeapon(mounts[0]?.weaponId ?? 'hitscan').mode,
        reach,
        energyCost: resolveSlotEnergyCost(kind, slot.id),
        name: slot.displayName,
        colour: slot.colour ?? si,
        capacity: slot.lockCapacity ?? (kind.sizeClass === 'capital' ? 3 : 1),
      });
    }
  }

  /** Parse a lock key once; cached. */
  private fcKey(key: string): { swarm: number; player: string | null } {
    let k = this._fcKeys.get(key);
    if (!k) {
      k = key.startsWith('s:') ? { swarm: Number(key.slice(2)), player: null } : { swarm: -1, player: key.slice(2) };
      if (this._fcKeys.size > 512) this._fcKeys.clear();
      this._fcKeys.set(key, k);
    }
    return k;
  }

  /** A lock target's hit shape for the shared turret range gate
   *  (`pickTurretLock` → `mountInReach`), from the mirror: the same fields the
   *  server's `resolveLockTarget` fills (#15). */
  private fcTargetShape(key: string, out: { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] }): void {
    const k = this.fcKey(key);
    if (k.player !== null) {
      const s = this.mirror.ships.get(k.player);
      if (s) fillRangeShape(out, s.angle, true, s.kind ?? null, s.shieldDown !== true, 0);
      else fillRangeShape(out, 0, false, null, false, 0); // not visible: a point
      return;
    }
    const e = this.mirror.swarm?.get(k.swarm);
    if (!e) { fillRangeShape(out, 0, false, null, false, 0); return; }
    const ship = e.kind === 1;
    fillRangeShape(out, ship ? e.angle : 0, ship, e.shipKind ?? null, ship && e.shieldDown !== true, e.radius);
  }

  /**
   * World pose + hit shape of a lock target from the render mirror (false =
   * not visible). The same fields the server's `resolveLockTarget` fills
   * (#15): a ship (pilot or NPC) by kind, heading and shield, so the fire gate
   * `mountFiresOn` measures range to the shape its hits use; a structure by
   * its radius (its lock signature).
   */
  private fcTargetPose(key: string, out: FireTargetShape): boolean {
    const k = this.fcKey(key);
    if (k.player !== null) {
      const s = this.mirror.ships.get(k.player);
      if (!s) return false;
      fillFireTargetShape(out, s.x, s.y, s.angle, true, s.kind ?? null, s.shieldDown !== true, 0);
      return true;
    }
    const e = this.mirror.swarm?.get(k.swarm);
    if (!e) return false;
    fillFireTargetShape(out, e.x, e.y, e.angle, e.kind === 1, e.shipKind ?? null, e.shieldDown !== true, e.radius);
    return true;
  }

  /** The group's aim key: first LOCKED target, else first acquiring (pre-slew). */
  private fcGroupAimKey(groupId: string): string | null {
    for (const g of this._fcGroups) {
      if (g.id !== groupId) continue;
      let acquiring: string | null = null;
      for (const l of g.l) {
        if (l.s === 2) return l.t;
        if (acquiring === null && l.s === 1) acquiring = l.t;
      }
      return acquiring;
    }
    return null;
  }

  /**
   * The lock one mount aims at (null = no aim, so no fire). One plain lock
   * (every non-capital group): the group's aim key. Several, or a salvage
   * lock (`f`): the shared `pickTurretLock` share-out with the same salvage
   * bits as the server's `LockSubsystem.aimKeyFor` (#15; `fcMountPick.ts`).
   * (sx, sy, sAngle) is the ship pose the mount is placed from.
   */
  private fcMountAimKey(mountId: string, sx: number, sy: number, sAngle: number): string | null {
    const gid = this._fcMountGroup.get(mountId);
    if (gid === undefined) return null;
    let group: (typeof this._fcGroups)[number] | null = null;
    for (const g of this._fcGroups) if (g.id === gid) { group = g; break; }
    if (group === null) return null;
    if (!fcNeedsPick(group.l)) return this.fcGroupAimKey(gid);
    let first: string | null = null;
    for (const l of group.l) if (l.s === 2) { first = l.t; break; }
    const def = this._fcMountDef.get(mountId);
    return def ? this._fcPicker.pick(group.l, def, sx, sy, sAngle, first) : first;
  }

  /** Apply the own-ship snapshot's groups (#16). Store write only on change. */
  applyFcGroups(groups: ReadonlyArray<{ id: string; m: number; l: ReadonlyArray<{ t: string; s: number; p: number; r?: number; c?: number; f?: number }> }> | undefined): void {
    this._fcGroups = groups ?? [];
    this.mirror.localGroups = this._fcGroups;
    // Cheap change signature over ids / modes / lock targets / stages.
    let sig = this._fcGroups.length;
    for (const g of this._fcGroups) {
      sig = (sig * 31 + g.m + 7) | 0;
      for (let i = 0; i < g.id.length; i++) sig = (sig * 31 + g.id.charCodeAt(i)) | 0;
      for (const l of g.l) {
        sig = (sig * 31 + l.s + 3 + (l.c === 1 ? 11 : 0)) | 0;
        for (let i = 0; i < l.t.length; i++) sig = (sig * 31 + l.t.charCodeAt(i)) | 0;
      }
    }
    if (sig === this._fcSummarySig) return;
    this._fcSummarySig = sig;
    this.fcSyncKind(this.mirror.ships.get(this.mirror.localPlayerId ?? '')?.kind ?? null);
    const summary: FcGroupSummary[] = this._fcGroups.map((g) => {
      const info = this._fcInfo.get(g.id);
      return {
        id: g.id,
        name: info?.name ?? (g.id === 'wing' ? 'Wing' : g.id),
        mode: g.m === 1 ? 'manual' : 'auto',
        colour: info?.colour ?? 0,
        capacity: info?.capacity ?? 1,
        locks: g.l.map((l) => (l.c === 1 ? { target: l.t, stage: l.s, blocked: true } : { target: l.t, stage: l.s })),
      };
    });
    const st = useUIStore.getState();
    st.setFcGroups(summary);
    if (st.activeGroupId === null || !summary.some((g) => g.id === st.activeGroupId)) {
      st.setActiveGroupId(summary[0]?.id ?? null);
    }
  }

  /** Turret aim for a fire-control pilot: each mount at its group's lock. Mirrors
   *  WeaponMountTicker's fire-control branch (#12/#15). */
  fcTickMountAngles(
    angles: number[], mounts: ReadonlyArray<WeaponMount>, x: number, y: number, angle: number, dtSec: number,
  ): void {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      const key = this.fcMountAimKey(mount.id, x, y, angle);
      if (key === null || !this.fcTargetPose(key, this._fcPose)) {
        angles[i] = rotateMountToward(angles[i]!, 0, mount, dtSec);
        continue;
      }
      const mx = x + (mount.localX * cosA - mount.localY * sinA);
      const my = y + (mount.localX * sinA + mount.localY * cosA);
      const bearing = Math.atan2(-(this._fcPose.x - mx), this._fcPose.y - my);
      angles[i] = rotateMountToward(angles[i]!, wrapPi(bearing - angle - mount.baseAngle), mount, dtSec);
    }
  }

  /**
   * Fire control's per-frame fire pass: every group with a LOCKED target fires
   * on its own cooldown (auto always; manual while held / Space on the active
   * group). Fixed guns wait until the target is inside their nose cone.
   */
  /**
   * May any mount of `groupId` fire at target `t`? Per mount, from its world
   * origin: the target's hit shape within the mount's own reach AND its barrel
   * bearing on it, exactly as the server's fire gate (shared `mountFiresOn`,
   * #15).
   */
  private fcGroupBears(groupId: string, sx: number, sy: number, shipAngle: number, t: FireTargetShape): boolean {
    const localId = this.mirror.localPlayerId;
    const ship = localId ? this.mirror.ships.get(localId) : undefined;
    const mounts = getShipKind(ship?.kind ?? null).mounts ?? [];
    const angles = ship?.mountAngles;
    const cosA = Math.cos(shipAngle);
    const sinA = Math.sin(shipAngle);
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i]!;
      // Not this group, or no aim (a mining laser leaves a haulable piece to the tractors, as the server).
      if (this._fcMountGroup.get(m.id) !== groupId || this.fcMountAimKey(m.id, sx, sy, shipAngle) === null) continue;
      const ox = sx + (m.localX * cosA - m.localY * sinA);
      const oy = sy + (m.localX * sinA + m.localY * cosA);
      if (mountFiresOn(m.weaponId, mountWeaponReach(m), ox, oy, shipAngle + m.baseAngle + (angles?.[i] ?? 0), t)) return true;
    }
    return false;
  }

  /** May this one mount (world origin + barrel angle) fire at its group's aim target (`mountFiresOn`)?
   *  `size`: the mount's (a mining tool's reach scales with it, `weaponIdReach`). */
  fcMountBears(mountId: string, weaponId: WeaponId, size: WeaponMount['size'], ox: number, oy: number, angle: number): boolean {
    // Capitals fire one turret at a time: only the mounts in this salvo.
    if (this._fcSalvo.size > 0 && !this._fcSalvo.has(mountId)) return false;
    const localId = this.mirror.localPlayerId;
    const ship = localId ? this.mirror.ships.get(localId) : undefined;
    const key = this.fcMountAimKey(mountId, ship?.x ?? ox, ship?.y ?? oy, ship?.angle ?? 0);
    if (key === null || !this.fcTargetPose(key, this._fcBearPose)) return false;
    return mountFiresOn(weaponId, weaponIdReach(weaponId, size), ox, oy, angle, this._fcBearPose);
  }
  private readonly _fcBearPose: FireTargetShape = newFireTargetShape();

  fcFireTick(spaceHeld: boolean): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.host.canFire()) return;
    const st = this.host.shipState(localId);
    if (!st) return;
    this.fcSyncKind(this.mirror.ships.get(localId)?.kind ?? null);
    const activeGroup = useUIStore.getState().activeGroupId;
    const nowMs = this.host.now();
    this._fcBearing.clear();
    let beamGroup: string | null = null;
    for (const g of this._fcGroups) {
      let lockedKey: string | null = null;
      for (const l of g.l) if (l.s === 2) { lockedKey = l.t; break; }
      if (lockedKey === null) continue;
      const wants = g.m === 0 || this._fcHeld === g.id || (spaceHeld && g.id === activeGroup);
      if (!wants) continue;
      const info = this._fcInfo.get(g.id);
      if (!info) continue;
      if (this._fcPerMount) {
        // Capitals: each turret fires on its own reload once it bears on its
        // own share of the group's locks (server: PlayerFireResolver per-mount).
        if (this.fcFireMounts(g.id, info, st, nowMs) && beamGroup === null && info.mode === 'hitscan') beamGroup = g.id;
        continue;
      }
      if (!this.fcTargetPose(lockedKey, this._fcPose)) continue;
      // Only when a mount of this group reaches the target's hull and its
      // barrel is on the target (fixed guns: the nose; turrets: their slewed
      // angle — a turret parked at its arc limit never is). Same rule the
      // server enforces (#15).
      if (!this.fcGroupBears(g.id, st.x, st.y, st.angle, this._fcPose)) continue;
      if (!canAfford(this.predEnergy, info.energyCost)) continue;
      // A firing hitscan group draws the continuous predicted beam (the own
      // `laser_fired` is skipped: own shots show as liveBeams).
      if (beamGroup === null && info.mode === 'hitscan') beamGroup = g.id;
      const last = this._fcLastFireMs.get(g.id);
      if (last !== undefined && nowMs - last < info.cooldownMs) continue;
      const floor = (this._fcLastFireTick.get(g.id) ?? -1e9) + info.cooldownTicks;
      const sendTick = Math.max(this.inputTick, floor);
      this._fireSlotOverride = g.id;
      try {
        this.host.sendFire(sendTick);
      } finally {
        this._fireSlotOverride = null;
      }
      this._fcLastFireMs.set(g.id, nowMs);
      this._fcLastFireTick.set(g.id, sendTick);
      this.host.fired(sendTick);
      if (info.mode === 'hitscan') this.host.hitscanFired(nowMs);
    }
    if (beamGroup !== null) {
      this._fireSlotOverride = beamGroup;
      try {
        this.host.updateLiveBeam();
      } finally {
        this._fireSlotOverride = null;
      }
    }
  }

  /**
   * Capital fire pass for one group: every mount that bears on ITS lock
   * (`fcMountAimKey`) and has reloaded joins the salvo, which goes out as one
   * group fire carrying only those mounts' ghosts. Returns true when any
   * mount of the group bears (reloaded or not), for the live beam.
   */
  private fcFireMounts(
    groupId: string, info: { energyCost: number; mode: WeaponDef['mode'] },
    st: { x: number; y: number; angle: number }, nowMs: number,
  ): boolean {
    const localId = this.mirror.localPlayerId;
    const ship = localId ? this.mirror.ships.get(localId) : undefined;
    const mounts = getShipKind(ship?.kind ?? null).mounts ?? [];
    const angles = ship?.mountAngles;
    const cosA = Math.cos(st.angle);
    const sinA = Math.sin(st.angle);
    const salvo = this._fcSalvo;
    salvo.clear();
    let bears = false;
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i]!;
      if (this._fcMountGroup.get(m.id) !== groupId) continue;
      const def = this._fcMountDef.get(m.id);
      if (!def) continue;
      const key = this.fcMountAimKey(m.id, st.x, st.y, st.angle);
      if (key === null || !this.fcTargetPose(key, this._fcPose)) continue;
      const ox = st.x + (m.localX * cosA - m.localY * sinA);
      const oy = st.y + (m.localX * sinA + m.localY * cosA);
      // In the mount's own reach of the target's hull AND on bearing (#15).
      if (!mountFiresOn(m.weaponId, def.reach, ox, oy, st.angle + m.baseAngle + (angles?.[i] ?? 0), this._fcPose)) continue;
      bears = true;
      this._fcBearing.add(m.id);
      const cd = getWeapon(m.weaponId).cooldownTicks;
      const lastMs = this._fcMountLastMs.get(m.id);
      if (lastMs !== undefined && nowMs - lastMs < (cd * 1000) / 60) continue;
      if (this.inputTick < (this._fcMountLastTick.get(m.id) ?? -1e9) + cd) continue;
      salvo.add(m.id);
    }
    if (salvo.size === 0 || !canAfford(this.predEnergy, info.energyCost)) {
      salvo.clear();
      return bears;
    }
    const sendTick = this.inputTick;
    for (const id of salvo) {
      this._fcMountLastMs.set(id, nowMs);
      this._fcMountLastTick.set(id, sendTick);
    }
    this._fireSlotOverride = groupId;
    try {
      this.host.sendFire(sendTick);
    } finally {
      this._fireSlotOverride = null;
      salvo.clear();
    }
    this._fcLastFireMs.set(groupId, nowMs);
    this._fcLastFireTick.set(groupId, sendTick);
    this.host.fired(sendTick);
    if (info.mode === 'hitscan') this.host.hitscanFired(nowMs);
    return bears;
  }

  /**
   * The lock state that names a re-keyed ship follows it (`p:<from>` →
   * `p:<to>`), as the server's `LockSubsystem.shipKeyMoved` does: the own
   * groups' lock targets (lock line, marks, turret aim, fire gate read them
   * until the next snapshot's `groups` slice, which the server already
   * re-keyed, #16), the held lock-line candidate and the last `lock_track`
   * sent (so the line neither re-sends nor lets go of the same ship).
   */
  rekeyLockState(from: string, to: string): void {
    const fromKey = this.line.shipLockKey(from);
    const toKey = this.line.shipLockKey(to);
    for (const g of this._fcGroups) {
      for (const l of g.l) if (l.t === fromKey) (l as { t: string }).t = toKey;
    }
    if (this.mirror.localLockCandidate === fromKey) this.mirror.localLockCandidate = toKey;
    if (this.line._trackKey === fromKey) this.line._trackKey = toKey;
  }
}
