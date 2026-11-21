/**
 * A drone kill pays its killer only when the killer is a player. The
 * 2026-11-21 log: an asteroid (`belt:1-0-asteroid-3`) rammed an elite to
 * death, was paid its bounty and looked up as a "structure owner".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { auditCombatDestruction, type CombatDestructionAuditHost } from './combatDestructionAudit.js';
import { setAuditSink } from '../audit/GameplayAuditLog.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

const credit = vi.hoisted(() => vi.fn());
vi.mock('../db/PersistenceWorker.js', () => ({ getWallet: () => ({ credit }), persistence: {} }));

const ROCK = 'belt:1-0-asteroid-3';

function host(): CombatDestructionAuditHost & { payEliteBounty: ReturnType<typeof vi.fn>; awardKillXp: ReturnType<typeof vi.fn> } {
  return {
    sectorKey: () => '1-0',
    structureRegistry: { get: () => undefined },
    recentCombatLog: { record: () => {} },
    now: () => 0,
    payEliteBounty: vi.fn(),
    awardKillXp: vi.fn(),
    swarmRegistry: { get: (id: string) => (id === ROCK ? ({ id, kind: 0 } as SwarmEntityRecord) : undefined) },
  };
}

const elite = { id: 'swarm-1', kind: SWARM_KIND_DRONE, shipKind: 'fighter', elite: { name: 'Vex', maxHealth: 400, bounty: 500 } } as unknown as SwarmEntityRecord;

describe('auditCombatDestruction kill rewards', () => {
  setAuditSink(() => {});
  afterEach(() => { credit.mockClear(); });

  it('an elite rammed to death by a rock pays no bounty, XP or wallet', () => {
    const h = host();
    auditCombatDestruction(h, elite, ROCK);
    expect(h.payEliteBounty).not.toHaveBeenCalled();
    expect(h.awardKillXp).not.toHaveBeenCalled();
    expect(credit).not.toHaveBeenCalled();
  });

  it('an elite killed by a player still pays all three', () => {
    const h = host();
    auditCombatDestruction(h, elite, 'player-1');
    expect(h.payEliteBounty).toHaveBeenCalledWith('player-1', 'Vex', 500);
    expect(h.awardKillXp).toHaveBeenCalledWith('player-1', expect.any(Number));
    expect(credit).toHaveBeenCalledWith('player-1', expect.any(Number), 'kill_bounty');
  });
});
