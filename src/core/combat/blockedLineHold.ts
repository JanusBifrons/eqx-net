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
