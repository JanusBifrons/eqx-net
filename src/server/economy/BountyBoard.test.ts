import { describe, expect, it } from 'vitest';
import { BountyBoard, BOUNTIES_STATE_KEY } from './BountyBoard.js';
import { Wallet } from './Wallet.js';
import { buildContracts } from '../livingworld/contractsProvider.js';
import { pvpBountyCost } from '../../shared-types/contracts.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

/** A sink that records every CRITICAL op (flattening groups). */
function recordingSink(): { sink: IPersistenceSink; groups: PersistOp[][] } {
  const groups: PersistOp[][] = [];
  const sink = {
    enqueueCritical: (op: PersistOp) => groups.push(op.type === 'GROUP' ? op.ops : [op]),
  } as unknown as IPersistenceSink;
  return { sink, groups };
}

function setup(levels: Record<string, number> = { target: 3 }) {
  const { sink, groups } = recordingSink();
  const wallet = new Wallet({ persistence: () => sink });
  let now = 1_000;
  const board = new BountyBoard(wallet, () => sink, {
    maxShipLevel: (pid) => levels[pid] ?? 0,
    nameOf: (pid) => (pid === 'target' ? 'Vex' : null),
    lastSectorOf: () => 'greenfall',
  }, () => now);
  return { board, wallet, groups, advance: (ms: number) => { now += ms; } };
}

const room = { broadcastWorldNotice: () => undefined };

describe('player bounties (P4c-2, economy v2 — the wallet)', () => {
  it('a bounty costs the amount plus a 25 % burned fee', () => {
    expect(pvpBountyCost(100)).toBe(125);
    expect(pvpBountyCost(401)).toBe(502);
  });

  it('placing debits the placer\'s wallet (amount + fee) and records the bounty in ONE group', () => {
    const t = setup();
    t.wallet.credit('placer', 1000, 'seed');
    t.groups.length = 0;
    expect(t.board.place(room, 'placer', 'target', 400).ok).toBe(true);
    expect(t.wallet.balance('placer')).toBe(1000 - 500);
    expect(t.board.amountOf('target', 'placer')).toBe(400);
    // One atomic group: the board record + the wallet debit.
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0]!.map((o) => o.type).sort()).toEqual(['ECON_STATE_PUT', 'WALLET_PUT']);
  });

  it('refuses: short wallet (nothing changes), low-level target, self, a second bounty on the same pilot', () => {
    const t = setup({ target: 3, newbie: 2 });
    t.wallet.credit('placer', 200, 'seed');
    expect(t.board.place(room, 'placer', 'target', 200).ok).toBe(false); // costs 250
    expect(t.wallet.balance('placer')).toBe(200);
    expect(t.board.place(room, 'placer', 'newbie', 100).ok).toBe(false);
    expect(t.board.place(room, 'placer', 'placer', 100).ok).toBe(false);
    expect(t.board.place(room, 'placer', 'target', 100).ok).toBe(true);
    expect(t.board.place(room, 'placer', 'target', 100).ok).toBe(false);
  });

  it('a kill pays every open bounty except the killer\'s own into the killer\'s wallet; then the pair cooldown', () => {
    const t = setup();
    t.wallet.credit('a', 1000, 'seed');
    t.wallet.credit('b', 1000, 'seed');
    t.board.place(room, 'a', 'target', 300);
    t.board.place(room, 'b', 'target', 100);
    // b kills the target: collects a's 300, not its own 100.
    expect(t.board.onPlayerKilled(room, 'target', 'b')).toBe(300);
    expect(t.wallet.balance('b')).toBe(1000 - 125 + 300);
    expect(t.board.amountOf('target', 'a')).toBe(0);
    expect(t.board.amountOf('target', 'b')).toBe(100);
    // a can't re-place on the target straight away; the cooldown lapses.
    expect(t.board.place(room, 'a', 'target', 100).ok).toBe(false);
    t.advance(24 * 60 * 60_000 + 1);
    expect(t.board.place(room, 'a', 'target', 100).ok).toBe(true);
  });

  it('survives a restart through the persisted record', () => {
    const t = setup();
    t.wallet.credit('a', 1000, 'seed');
    t.board.place(room, 'a', 'target', 300);
    const rec = t.groups.flat().filter((o) => o.type === 'ECON_STATE_PUT' && o.key === BOUNTIES_STATE_KEY).at(-1);
    const t2 = setup();
    t2.board.hydrate(rec && rec.type === 'ECON_STATE_PUT' ? rec.payloadJson : null);
    expect(t2.board.amountOf('target', 'a')).toBe(300);
  });

  it('open bounties show on the Contracts board by name, never by id', () => {
    const board = buildContracts({
      elites: () => [],
      activeEvent: () => null,
      bounties: () => [{ target: 'abc-uuid', targetName: 'Vex', credits: 900, lastSector: null }],
    });
    expect(board.contracts).toEqual([
      expect.objectContaining({ kind: 'player', title: 'Wanted: Vex', rewardCredits: 900, sectorKey: '' }),
    ]);
    expect(board.contracts[0]!.title).not.toContain('abc-uuid');
  });
});
