import { describe, expect, it, vi, beforeEach } from 'vitest';

const wallet = { balance: vi.fn(() => 0), debit: vi.fn(() => true), debitAllowingDebt: vi.fn(() => true), credit: vi.fn() };
const grantJoinCredits = vi.fn();
vi.mock('../db/PersistenceWorker.js', () => ({ getWallet: () => wallet, getPersistence: () => null }));
vi.mock('../economy/starterGrant.js', () => ({ getStarterGrantEconomy: () => null, grantJoinCredits }));
vi.mock('../economy/tradeSink.js', () => ({ getTradeSink: () => null }));

const { chargeLaunchFor, gateLaunch } = await import('./launchGate.js');
const { SANDBOX_SECTOR_KEY } = await import('./sealedSectors.js');

describe('launch gate in a sealed room (sandbox)', () => {
  beforeEach(() => { vi.clearAllMocks(); wallet.balance.mockReturnValue(0); });

  it('launches a capital free: no debit, no debt, no join credits', () => {
    const v = chargeLaunchFor(true, SANDBOX_SECTOR_KEY, 'p1', 'battleship');
    expect(v.kind).toBe('free');
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(wallet.debitAllowingDebt).not.toHaveBeenCalled();
    expect(grantJoinCredits).not.toHaveBeenCalled();
  });

  it('never downgrades a sandbox launch to a Fighter (no hull gate)', () => {
    const notice = vi.fn();
    expect(gateLaunch(true, SANDBOX_SECTOR_KEY, 'p1', 'barge', notice)).toBe('barge');
    expect(notice).not.toHaveBeenCalled();
  });

  it('a real sector still grants join credits and charges', () => {
    chargeLaunchFor(true, 'sol-prime', 'p1', 'battleship');
    expect(grantJoinCredits).toHaveBeenCalledOnce();
    expect(wallet.debitAllowingDebt.mock.calls.length + wallet.debit.mock.calls.length).toBe(1);
  });
});
