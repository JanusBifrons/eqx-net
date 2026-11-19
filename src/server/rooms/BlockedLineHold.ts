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
 * clears them (`clearPlayer`, `clearDrone`, `shipKeyMoved`); the store is
 * core `BlockedLineTimers`, shared with the client mirror (#15).
 */
import { BlockedLineTimers, holdsOnBlockedLine, shotPassesThrough } from '../../core/combat/blockedLineHold.js';
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
  /** The shared per-mount timers (core, the client mirror steps the same). */
  private readonly timers = new BlockedLineTimers();
  /** Running count of line queries (host-independent work count). */
  checks = 0;

  /**
   * True ⇒ this mount holds fire now: `weaponId` is a straight-line weapon
   * and its line (fx, fy) → (tx, ty) to `targetId` has been blocked for the
   * tolerance. Records this look (a clear line or a new target resets the timer).
   */
  held<R extends LineBody>(
    gate: LineQuery<R>, key: string, mountIdx: number, weaponId: WeaponId,
    fx: number, fy: number, tx: number, ty: number, skipId: string, targetId: string, nowMs: number,
  ): boolean {
    if (!holdsOnBlockedLine(weaponId)) return false;
    this.checks++;
    const blocks = shotPassesThrough(weaponId) ? slugBlocks : beamBlocks;
    const blocked = gate.firstOnLine(fx, fy, tx, ty, skipId, targetId, blocks) !== '';
    return this.timers.step(key, mountIdx, targetId, blocked, nowMs);
  }

  /** Drop a shooter's timers (leave, death, eviction, hand-back). */
  forget(key: string): void { this.timers.forget(key); }

  /** A ship's key moved (playerId <-> shipInstanceId): its timers go with it. */
  moved(from: string, to: string): void { this.timers.moved(from, to); }

  /** Shooters with timers (tests: cleanup leaves none behind). */
  get size(): number { return this.timers.size; }
}
