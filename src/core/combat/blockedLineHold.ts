/**
 * Fire control's blocked-line hold (owner 2026-11-18): every turret swings to
 * its target ready, and a straight-line instant weapon (a beam, or the
 * railgun's slug) opens fire the moment its line to the target is clear. Once
 * the line has been blocked by another solid body CONTINUOUSLY for
 * `BLOCKED_LINE_HOLD_MS` of game time, the mount holds fire (it keeps aiming;
 * nothing is spent); a brief crossing never stops it, and fire resumes the
 * instant the line clears. Shells with a travel time and missiles that twist
 * and turn are never held.
 *
 * Which weapons: read from the catalogue's modes and kill cuts, never a list
 * of ids (`holdsOnBlockedLine`). Pure, allocation-free; the per-mount timer
 * lives with the caller (server: `BlockedLineHold`).
 * Guide: docs/architecture/fire-control.md "Blocked line hold".
 */
import { getWeapon, type WeaponId } from './WeaponCatalogue.js';

/** Game ms a straight-line weapon's line must stay blocked before it holds. */
export const BLOCKED_LINE_HOLD_MS = 500;

/** "Not blocked" for a blocked-since timer (game ms are never negative). */
export const LINE_CLEAR = -1;

/** Does a shot of this weapon pass through what it kills and through wreck
 *  pieces (a `channel` kill cut: the capital railgun's slug)? */
export function shotPassesThrough(weaponId: WeaponId): boolean {
  const cut = getWeapon(weaponId).killCut;
  return cut !== undefined && cut.kind === 'channel';
}

/** Is this a straight-line instant weapon the blocked-line hold covers: a
 *  beam (hitscan; not the tractor, which has its own line of sight) or a
 *  pass-through slug? */
export function holdsOnBlockedLine(weaponId: WeaponId): boolean {
  const w = getWeapon(weaponId);
  if (w.mode === 'hitscan') return w.tractor === undefined;
  return w.mode === 'projectile' && shotPassesThrough(weaponId);
}

/** One look at a mount's line: the new blocked-since (game ms). */
export function stepBlockedSince(since: number, blocked: boolean, nowMs: number): number {
  if (!blocked) return LINE_CLEAR;
  return since === LINE_CLEAR ? nowMs : since;
}

/** Hold fire: the line has been blocked for the whole tolerance. */
export function lineHeld(since: number, nowMs: number): boolean {
  return since !== LINE_CLEAR && nowMs - since >= BLOCKED_LINE_HOLD_MS;
}

/** One shooter's timers: blocked-since and the target each was measured on, by mount index. */
interface ShooterLines { since: Float64Array; target: string[] }

/**
 * The per-mount blocked-since store, the one timer both sides keep (server
 * `BlockedLineHold`, client `BlockedLineMirror`): each side asks its own
 * first-hit query whether the line is blocked, then steps here. A mount that
 * switches targets starts its tolerance over. Grows once per shooter (or past
 * its high-water mount count), allocation-free otherwise (#14).
 */
export class BlockedLineTimers {
  private readonly lines = new Map<string, ShooterLines>();

  /** Record one look at mount `idx` of `key` on `targetId`; true ⇒ hold fire now. */
  step(key: string, idx: number, targetId: string, blocked: boolean, nowMs: number): boolean {
    let l = this.lines.get(key);
    if (l === undefined || idx >= l.since.length) {
      if (!blocked) return false; // a clear line needs no timer
      const n = Math.max(idx + 1, 4);
      const grown: ShooterLines = { since: new Float64Array(n).fill(LINE_CLEAR), target: new Array<string>(n).fill('') };
      if (l !== undefined) { grown.since.set(l.since); for (let i = 0; i < l.target.length; i++) grown.target[i] = l.target[i]!; }
      l = grown;
      this.lines.set(key, l);
    }
    const prev = l.target[idx] === targetId ? l.since[idx]! : LINE_CLEAR;
    l.target[idx] = targetId;
    const s = stepBlockedSince(prev, blocked, nowMs);
    l.since[idx] = s;
    return lineHeld(s, nowMs);
  }

  /** Drop a shooter's timers (leave, death, eviction, hand-back). */
  forget(key: string): void {
    this.lines.delete(key);
  }

  /** A ship's key moved (playerId <-> shipInstanceId): its timers go with it. */
  moved(from: string, to: string): void {
    const l = this.lines.get(from);
    this.lines.delete(from);
    if (l !== undefined) this.lines.set(to, l);
    else this.lines.delete(to);
  }

  /** Drop every timer (the client's sector handoff). */
  clear(): void {
    this.lines.clear();
  }

  /** Shooters with timers (tests: cleanup leaves none behind). */
  get size(): number { return this.lines.size; }
}
