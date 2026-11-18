/**
 * The server half of fire control's blocked-line hold (core
 * `blockedLineHold.ts`, owner 2026-11-18): before a straight-line instant
 * weapon (beam, railgun slug) fires, the room asks the ONE line-of-fire grid
 * (`LineOfFireGate.firstOnLine`) what the shot would meet first on its line
 * from the muzzle to the target, by the shot's own skip rules: never the
 * shooter (a capital's own deck), never a loot pod, and for a pass-through
 * slug never a wreck piece. The target never blocks. A line blocked for the
 * whole tolerance holds the mount; nothing is spent.
 *
 * Every shooter goes through here: a pilot's or AI-flown hull's mount
 * (`SectorRoom.mountBearsOnLock`), an AI pilot's slot and a capital turret
 * (`npcShipLineBlocked`), a structure turret (`structureLineBlocked`).
 *
 * The per-mount blocked-since timers live beside the mount angles in
 * `WeaponMountTicker` (one instance) and are cleared on every path that
 * clears them (`clearPlayer`, `clearDrone`, `shipKeyMoved`). One array per
 * shooter, grown only past its mount count; allocation-free otherwise (#14).
 */
import { LINE_CLEAR, holdsOnBlockedLine, lineHeld, shotPassesThrough, stepBlockedSince } from '../../core/combat/blockedLineHold.js';
import type { WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { isLootPod, isWreckPiece } from '../net/SwarmEntityRegistry.js';

/** A body on a line: what the skip rules read. */
export interface LineBody { kind: number; shipKind?: string | null; id: string }

/** The grid query (`LineOfFireGate.firstOnLine`). */
export interface LineQuery<R extends LineBody> {
  firstOnLine(fx: number, fy: number, tx: number, ty: number, skipId: string, targetId: string, blocks: (rec: R) => boolean): string;
}

/** A beam stops on anything but a loot pod; a slug flies through wreck too. */
const beamBlocks = (rec: LineBody): boolean => !isLootPod(rec);
const slugBlocks = (rec: LineBody): boolean => !isLootPod(rec) && !isWreckPiece(rec);

export class BlockedLineHold {
  /** Blocked-since (game ms, `LINE_CLEAR` = clear) per shooter key, by mount index. */
  private readonly since = new Map<string, Float64Array>();
  /** Running count of line queries (host-independent work count). */
  checks = 0;

  /**
   * True ⇒ this mount holds fire now: `weaponId` is a straight-line weapon
   * and its line (fx, fy) → (tx, ty) has been blocked for the tolerance.
   * Records this look (a clear line resets the timer at once).
   */
  held<R extends LineBody>(
    gate: LineQuery<R>, key: string, mountIdx: number, weaponId: WeaponId,
    fx: number, fy: number, tx: number, ty: number, skipId: string, targetId: string, nowMs: number,
  ): boolean {
    if (!holdsOnBlockedLine(weaponId)) return false;
    this.checks++;
    const blocks = shotPassesThrough(weaponId) ? slugBlocks : beamBlocks;
    const blocked = gate.firstOnLine(fx, fy, tx, ty, skipId, targetId, blocks) !== '';
    let arr = this.since.get(key);
    if (!blocked) {
      if (arr !== undefined && mountIdx < arr.length) arr[mountIdx] = LINE_CLEAR;
      return false;
    }
    if (arr === undefined || mountIdx >= arr.length) {
      // Once per shooter (or past its high-water mount count), never per tick.
      const grown = new Float64Array(Math.max(mountIdx + 1, 4)).fill(LINE_CLEAR);
      if (arr !== undefined) grown.set(arr);
      arr = grown;
      this.since.set(key, arr);
    }
    const s = stepBlockedSince(arr[mountIdx]!, true, nowMs);
    arr[mountIdx] = s;
    return lineHeld(s, nowMs);
  }

  /** Drop a shooter's timers (leave, death, eviction, hand-back). */
  forget(key: string): void {
    this.since.delete(key);
  }

  /** A ship's key moved (playerId <-> shipInstanceId): its timers go with it. */
  moved(from: string, to: string): void {
    const arr = this.since.get(from);
    this.since.delete(from);
    if (arr !== undefined) this.since.set(to, arr);
    else this.since.delete(to);
  }

  /** Shooters with timers (tests: cleanup leaves none behind). */
  get size(): number { return this.since.size; }
}
