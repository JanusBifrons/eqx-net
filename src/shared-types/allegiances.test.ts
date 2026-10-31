import { describe, expect, it } from 'vitest';
import {
  ALLEGIANCE_DEFS,
  NPC_ALLEGIANCE_IDS,
  isFriendly,
  isOnSightHostile,
  stanceOf,
  type AllegianceSide,
} from './allegiances.js';
import {
  GAMEPLAY_SHIP_KINDS_LIST,
  PLAYABLE_SHIP_KINDS_LIST,
  SHIP_KINDS_LIST,
  allegianceOfKind,
  isPlayableShipKindId,
} from './shipKinds.js';

const SIDES: AllegianceSide[] = ['drones', 'robots', 'traders', 'players'];

describe('allegiance stance table (plan peppy-jumping-pinwheel P0)', () => {
  it('every side is friendly to itself except players (PvP is player choice)', () => {
    for (const s of SIDES) {
      if (s === 'players') expect(stanceOf(s, s)).toBe('neutral');
      else expect(isFriendly(s, s)).toBe(true);
    }
  });

  it('truth table: who attacks whom on sight', () => {
    // Robots are the third party: hostile to players, drones AND traders.
    expect(isOnSightHostile('robots', 'players')).toBe(true);
    expect(isOnSightHostile('robots', 'drones')).toBe(true);
    expect(isOnSightHostile('robots', 'traders')).toBe(true);
    // Drones fight robots on sight, but players only via waves/retaliation.
    expect(isOnSightHostile('drones', 'robots')).toBe(true);
    expect(isOnSightHostile('drones', 'players')).toBe(false);
    expect(isOnSightHostile('drones', 'traders')).toBe(false);
    // Traders never start a fight.
    for (const s of SIDES) expect(isOnSightHostile('traders', s)).toBe(false);
    // Players' stance is never "on sight" (players choose).
    for (const s of SIDES) expect(isOnSightHostile('players', s)).toBe(false);
  });

  it('every NPC allegiance has a def', () => {
    for (const id of NPC_ALLEGIANCE_IDS) expect(ALLEGIANCE_DEFS[id].id).toBe(id);
  });
});

describe('npcOnly kinds (P0)', () => {
  it('robot-square exists, is a robot, and is npcOnly', () => {
    expect(allegianceOfKind('robot-square')).toBe('robots');
    expect(allegianceOfKind('fighter')).toBe('drones');
  });

  it('npcOnly kinds are excluded from the random drone pool and the player picker', () => {
    const npc = SHIP_KINDS_LIST.filter((k) => k.npcOnly).map((k) => k.id);
    expect(npc).toContain('robot-square');
    for (const id of npc) {
      expect(GAMEPLAY_SHIP_KINDS_LIST.some((k) => k.id === id)).toBe(false);
      expect(PLAYABLE_SHIP_KINDS_LIST.some((k) => k.id === id)).toBe(false);
      expect(isPlayableShipKindId(id)).toBe(false);
    }
  });

  it('every non-npcOnly kind stays playable (engineering kinds included)', () => {
    for (const k of SHIP_KINDS_LIST) {
      if (!k.npcOnly) expect(isPlayableShipKindId(k.id)).toBe(true);
    }
    expect(isPlayableShipKindId('not-a-kind')).toBe(false);
  });
});
