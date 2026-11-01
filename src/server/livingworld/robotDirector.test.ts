import { describe, expect, it } from 'vitest';
import { getShipKind, isPlayableShipKindId } from '../../shared-types/shipKinds.js';
import { allegianceOfKind } from '../../shared-types/shipKinds.js';
import { SquadPool } from './director/SquadPool.js';
import { HunterBotPool } from './director/HunterBotPool.js';
import {
  ROBOT_BOT_COUNT,
  ROBOT_DIRECTOR_OPTIONS,
  ROBOT_SQUAD_LAYOUT,
  isRobotsDisabled,
  robotMemberKind,
} from './robotDirector.js';
import { isDirectorBotId, ROBOT_BOT_ID_PREFIX } from './directorBotIds.js';

describe('robot director config (Living World P1b)', () => {
  it('every robot slot is a robot-allegiance, NPC-only kind', () => {
    for (let m = 0; m < ROBOT_SQUAD_LAYOUT.squadSize; m++) {
      const kind = robotMemberKind(0, m);
      expect(allegianceOfKind(kind)).toBe('robots');
      expect(isPlayableShipKindId(kind)).toBe(false);
      expect(getShipKind(kind).id).toBe(kind); // resolves (no fallback)
    }
  });

  it('a squad is mixed-tier: one hexagon lead, two circles, the rest cubes', () => {
    const kinds = Array.from({ length: ROBOT_SQUAD_LAYOUT.squadSize }, (_, m) => robotMemberKind(0, m));
    expect(kinds).toEqual([
      'robot-hexagon',
      'robot-circle',
      'robot-circle',
      'robot-square',
      'robot-square',
      'robot-square',
    ]);
  });

  it('robots never wave and mint rbot- ids', () => {
    expect(ROBOT_DIRECTOR_OPTIONS.wavesEnabled).toBe(false);
    expect(ROBOT_DIRECTOR_OPTIONS.allegiance).toBe('robots');
    expect(ROBOT_DIRECTOR_OPTIONS.botIdPrefix).toBe(ROBOT_BOT_ID_PREFIX);
    expect(ROBOT_DIRECTOR_OPTIONS.botCount).toBe(ROBOT_BOT_COUNT);
  });

  it('the kill switch reads EQX_DISABLE_ROBOTS', () => {
    expect(isRobotsDisabled({})).toBe(false);
    expect(isRobotsDisabled({ EQX_DISABLE_ROBOTS: '1' })).toBe(true);
    expect(isRobotsDisabled({ EQX_DISABLE_ROBOTS: 'true' })).toBe(true);
    expect(isRobotsDisabled({ EQX_DISABLE_ROBOTS: '0' })).toBe(false);
  });
});

describe('director bot ids', () => {
  it('both director prefixes classify as NPC bots; players and swarm ids do not', () => {
    expect(isDirectorBotId('lwbot-3')).toBe(true);
    expect(isDirectorBotId('rbot-0')).toBe(true);
    expect(isDirectorBotId('swarm-12')).toBe(false);
    expect(isDirectorBotId('5f0c1e2a-0000-4000-8000-000000000000')).toBe(false);
  });

  it('HunterBotPool mints the configured prefix', () => {
    const pool = new HunterBotPool({
      botCount: 3,
      initialStaggerMs: 0,
      rng: () => 0,
      nowMs: () => 0,
      botIdPrefix: ROBOT_BOT_ID_PREFIX,
    });
    pool.seed('sol-prime');
    expect([...pool.values()].map((r) => r.botId)).toEqual(['rbot-0', 'rbot-1', 'rbot-2']);
  });
});

describe('SquadPool per-slot layout', () => {
  it('seeds the robot layout: rsquad- ids, 6 members, per-slot hulls', () => {
    const sp = new SquadPool();
    const ids = Array.from({ length: ROBOT_BOT_COUNT }, (_, i) => `rbot-${i}`);
    sp.seed(ids, () => 'sol-prime', () => 'robot-hexagon', ROBOT_SQUAD_LAYOUT);
    const squads = [...sp.all()];
    expect(squads.map((s) => s.squadId)).toEqual(['rsquad-0', 'rsquad-1', 'rsquad-2', 'rsquad-3']);
    expect(squads.every((s) => s.botIds.length === 6)).toBe(true);
    expect(squads[0]!.kind).toBe('robot-hexagon');
    expect(sp.memberKindOf('rbot-0')).toBe('robot-hexagon');
    expect(sp.memberKindOf('rbot-1')).toBe('robot-circle');
    expect(sp.memberKindOf('rbot-5')).toBe('robot-square');
    expect(sp.memberKindOf('rbot-6')).toBe('robot-hexagon'); // next squad's lead
  });

  it('the default layout is unchanged: homogeneous squad- squads', () => {
    const sp = new SquadPool();
    const ids = Array.from({ length: 16 }, (_, i) => `lwbot-${i}`);
    sp.seed(ids, () => 'sol-prime', () => 'fighter');
    const first = sp.get('squad-0')!;
    expect(first.botIds).toHaveLength(8);
    expect(first.kind).toBe('fighter');
    expect(sp.memberKindOf('lwbot-7')).toBe('fighter');
  });
});
