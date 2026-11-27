/**
 * Sandbox (docs/features/sandbox.md): a sealed room pays no real credits and
 * never joins the teleport broker. Each guard is checked sealed AND open, so
 * the galaxy is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from 'colyseus';

const credit = vi.hoisted(() => vi.fn());
const creditDeferred = vi.hoisted(() => vi.fn(() => null));
const onPlayerKilled = vi.hoisted(() => vi.fn());
const place = vi.hoisted(() => vi.fn(() => ({ ok: true, message: 'placed' })));
vi.mock('../db/PersistenceWorker.js', () => ({
  getWallet: () => ({ credit, creditDeferred, debit: () => true }), getHoldStore: () => null, persistence: {},
}));
vi.mock('../economy/BountyBoard.js', () => ({ getBountyBoard: () => ({ onPlayerKilled, place }) }));

import { SANDBOX_SECTOR_KEY, crossesSeal, paysRealCredits } from './sealedSectors.js';
import { auditCombatDestruction, claimPvpBounty, type CombatDestructionAuditHost } from './combatDestructionAudit.js';
import { registerBountyMessages, type BountyMessageHost } from './features/bountyMessages.js';
import { registerBlueprintMessages, type BlueprintMessageHost } from './features/blueprintMessages.js';
import { TeleportTolls, type TeleportTollHost } from './features/teleportTolls.js';
import { buildTeleporters, type TeleporterBuildHost } from './features/teleportMessages.js';
import { getTeleportBroker } from '../teleport/TeleportBroker.js';
import { StructureRegistry, type StructureRecord } from '../structures/StructureRegistry.js';
import { setAuditSink } from '../audit/GameplayAuditLog.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

const OPEN = 'sol-prime';
setAuditSink(() => {});
beforeEach(() => { vi.clearAllMocks(); });

describe('sealed-sector predicates', () => {
  it('crossesSeal: either end sealed, never a same-sector hop', () => {
    expect(crossesSeal(SANDBOX_SECTOR_KEY, OPEN)).toBe(true);
    expect(crossesSeal(OPEN, SANDBOX_SECTOR_KEY)).toBe(true);
    expect(crossesSeal(SANDBOX_SECTOR_KEY, SANDBOX_SECTOR_KEY)).toBe(false);
    expect(crossesSeal(OPEN, 'vega-reach')).toBe(false);
  });
  it('paysRealCredits: false only in a sealed sector', () => {
    expect(paysRealCredits(SANDBOX_SECTOR_KEY)).toBe(false);
    expect(paysRealCredits(OPEN)).toBe(true);
    expect(paysRealCredits(null)).toBe(true);
  });
});

describe('kill payouts', () => {
  const elite = { id: 'swarm-1', kind: SWARM_KIND_DRONE, shipKind: 'fighter', elite: { name: 'Vex', maxHealth: 400, bounty: 500 } } as unknown as SwarmEntityRecord;
  const host = (sectorKey: string): CombatDestructionAuditHost => ({
    sectorKey: () => sectorKey, structureRegistry: { get: () => undefined }, recentCombatLog: { record: () => {} },
    now: () => 0, payEliteBounty: vi.fn(), awardKillXp: vi.fn(), swarmRegistry: { get: () => undefined },
  });
  it('a sandbox NPC kill pays no kill_bounty and no elite bounty (XP still lands)', () => {
    const h = host(SANDBOX_SECTOR_KEY);
    auditCombatDestruction(h, elite, 'player-1');
    expect(credit).not.toHaveBeenCalled();
    expect(h.payEliteBounty).not.toHaveBeenCalled();
    expect(h.awardKillXp).toHaveBeenCalled();
  });
  it('a galaxy NPC kill still pays both', () => {
    const h = host(OPEN);
    auditCombatDestruction(h, elite, 'player-1');
    expect(credit).toHaveBeenCalledWith('player-1', expect.any(Number), 'kill_bounty');
    expect(h.payEliteBounty).toHaveBeenCalled();
  });
  it('a PvP kill claims board bounties only outside the sandbox', () => {
    claimPvpBounty({ sectorKey: () => SANDBOX_SECTOR_KEY, bountyRoom: () => ({}) }, 'victim', 'killer');
    expect(onPlayerKilled).not.toHaveBeenCalled();
    claimPvpBounty({ sectorKey: () => OPEN, bountyRoom: () => ({}) }, 'victim', 'killer');
    expect(onPlayerKilled).toHaveBeenCalledWith({}, 'victim', 'killer');
  });
});

/** Register a feature on a fake host; returns a sender and every reply. */
function wire<H>(register: (h: H) => unknown, extra: Record<string, unknown>) {
  const handlers = new Map<string, (c: Client, raw: unknown) => void>();
  const replies: Array<{ ok?: boolean; message?: string }> = [];
  register({
    onMessage: (t: string, fn: (c: Client, raw: unknown) => void) => { handlers.set(t, fn); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'p1']]),
    ...extra,
  } as unknown as H);
  const client = { sessionId: 's1', send: (_t: string, m: { ok?: boolean; message?: string }) => { replies.push(m); } } as unknown as Client;
  return { send: (t: string, raw: unknown) => handlers.get(t)!(client, raw), replies };
}

describe('bounty placing', () => {
  it('is refused in the sandbox and works in the galaxy', () => {
    const sealed = wire<BountyMessageHost>(registerBountyMessages, { sectorKey: () => SANDBOX_SECTOR_KEY, bountyRoom: {} });
    sealed.send('place_bounty', { type: 'place_bounty', targetPlayerId: 'p2', amount: 1000 });
    expect(place).not.toHaveBeenCalled();
    expect(sealed.replies[0]?.ok).toBe(false);
    const open = wire<BountyMessageHost>(registerBountyMessages, { sectorKey: () => OPEN, bountyRoom: {} });
    open.send('place_bounty', { type: 'place_bounty', targetPlayerId: 'p2', amount: 1000 });
    expect(place).toHaveBeenCalled();
  });
});

describe('blueprint market', () => {
  const host = (sectorKey: string) => ({
    sectorKey: () => sectorKey, swarmRegistry: { getByEntityId: () => undefined }, structureRegistry: { get: () => undefined },
  });
  it('bp_sell / bp_buy are refused in the sandbox (no real credits, no real board)', () => {
    const t = wire<BlueprintMessageHost>(registerBlueprintMessages, host(SANDBOX_SECTOR_KEY));
    t.send('bp_sell', { type: 'bp_sell', networkEntityId: 7, uid: 'bp-1' });
    t.send('bp_buy', { type: 'bp_buy', networkEntityId: 7, offerId: 'o-1' });
    expect(t.replies.map((r) => r.message)).toEqual(['No traders deal in the sandbox.', 'No traders deal in the sandbox.']);
    expect(creditDeferred).not.toHaveBeenCalled();
  });
  it('the galaxy reaches the normal sell path', () => {
    const t = wire<BlueprintMessageHost>(registerBlueprintMessages, host(OPEN));
    t.send('bp_sell', { type: 'bp_sell', networkEntityId: 7, uid: 'bp-1' });
    expect(t.replies[0]?.message).toBe('Pick one of your storage structures.');
  });
});

describe('teleport tolls', () => {
  const pad = { id: 'tp', kind: 'teleporter', owner: 'p1', x: 0, y: 0, tpToll: { per1000: 50 } } as unknown as StructureRecord;
  it('a sandbox pad asks no toll', () => {
    const teleporters = vi.fn();
    new TeleportTolls({ sectorKey: () => SANDBOX_SECTOR_KEY, teleporters } as unknown as TeleportTollHost).offerToll(pad);
    expect(teleporters).not.toHaveBeenCalled();
  });
  it('a galaxy pad works out its toll', () => {
    const teleporters = vi.fn(() => ({ required: () => 0 }));
    new TeleportTolls({ sectorKey: () => OPEN, teleporters } as unknown as TeleportTollHost).offerToll(pad);
    expect(teleporters).toHaveBeenCalled();
  });
});

describe('teleport broker', () => {
  const build = (sectorKey: string) => buildTeleporters({
    structureRegistry: new StructureRegistry(), storage: () => ({}), sectorKey: () => sectorKey, testCycleScale: undefined,
    powered: () => true, padRiders: {}, tolls: {}, forceFields: {}, rebuildStructuresSlice: () => {}, postToWorker: () => {},
  } as unknown as TeleporterBuildHost);
  it('a sandbox room never registers, so no pad elsewhere can reach it', () => {
    const { teleportRoom } = build(SANDBOX_SECTOR_KEY);
    expect(getTeleportBroker().room(SANDBOX_SECTOR_KEY)).toBeNull();
    getTeleportBroker().unregister(teleportRoom);
  });
  it('a galaxy room registers', () => {
    const { teleportRoom } = build(OPEN);
    expect(getTeleportBroker().room(OPEN)).toBe(teleportRoom);
    getTeleportBroker().unregister(teleportRoom);
  });
});
