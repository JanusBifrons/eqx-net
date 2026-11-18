/**
 * Fire control's blocked-line hold (owner 2026-11-18): which weapons it
 * covers (straight-line instant shots: beams and the railgun slug, read from
 * the catalogue's modes and kill cuts, never a list of ids) and the tolerance
 * timer (a brief crossing never stops fire; a line blocked for the whole
 * tolerance holds it; a clear line resumes at once).
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_LINE_HOLD_MS, LINE_CLEAR, holdsOnBlockedLine, lineHeld, shotPassesThrough, stepBlockedSince,
} from './blockedLineHold.js';
import { WEAPON_IDS, getWeapon } from './WeaponCatalogue.js';

describe('holdsOnBlockedLine', () => {
  it('covers every beam (hitscan) weapon but the tractor, and the pass-through slug', () => {
    for (const id of WEAPON_IDS) {
      const w = getWeapon(id);
      const beam = w.mode === 'hitscan' && w.tractor === undefined;
      const slug = w.mode === 'projectile' && w.killCut?.kind === 'channel';
      expect(holdsOnBlockedLine(id), id).toBe(beam || slug);
    }
  });

  it('shells with a travel time and missiles are not covered', () => {
    for (const id of WEAPON_IDS) {
      const w = getWeapon(id);
      if (w.mode === 'missile') expect(holdsOnBlockedLine(id), id).toBe(false);
      if (w.mode === 'projectile' && !shotPassesThrough(id)) expect(holdsOnBlockedLine(id), id).toBe(false);
    }
  });

  it('the railgun is the pass-through slug', () => {
    expect(shotPassesThrough('railgun')).toBe(true);
    expect(holdsOnBlockedLine('railgun')).toBe(true);
    expect(holdsOnBlockedLine('naval_l')).toBe(false);
    expect(holdsOnBlockedLine('heat-seeker')).toBe(false);
  });
});

describe('blocked-line tolerance', () => {
  it('holds only once the line has been blocked for the whole tolerance', () => {
    let since = LINE_CLEAR;
    since = stepBlockedSince(since, true, 1_000);
    expect(lineHeld(since, 1_000)).toBe(false);
    since = stepBlockedSince(since, true, 1_000 + BLOCKED_LINE_HOLD_MS - 1);
    expect(lineHeld(since, 1_000 + BLOCKED_LINE_HOLD_MS - 1)).toBe(false);
    since = stepBlockedSince(since, true, 1_000 + BLOCKED_LINE_HOLD_MS);
    expect(lineHeld(since, 1_000 + BLOCKED_LINE_HOLD_MS)).toBe(true);
  });

  it('a brief crossing (shorter than the tolerance) never stops fire, and a clear line resets', () => {
    let since = LINE_CLEAR;
    for (let t = 0; t < BLOCKED_LINE_HOLD_MS; t += 100) {
      since = stepBlockedSince(since, true, t);
      expect(lineHeld(since, t)).toBe(false);
    }
    since = stepBlockedSince(since, false, BLOCKED_LINE_HOLD_MS);
    expect(since).toBe(LINE_CLEAR);
    since = stepBlockedSince(since, true, BLOCKED_LINE_HOLD_MS + 100);
    expect(lineHeld(since, BLOCKED_LINE_HOLD_MS + 100)).toBe(false);
  });

  it('starts from game time 0', () => {
    const since = stepBlockedSince(LINE_CLEAR, true, 0);
    expect(lineHeld(since, BLOCKED_LINE_HOLD_MS)).toBe(true);
  });
});
