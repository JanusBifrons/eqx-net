import { describe, expect, it } from 'vitest';
import type { StructureRenderState } from '../../core/contracts/IRenderer.js';
import type { TradeHistoryEntry } from '../../shared-types/economy.js';
import { ownStorages, repFill, repLabel, summarizeHistory, toastForNotice, unseenHistory } from './tradeView.js';

function st(owner: string, built = true): StructureRenderState {
  return { powered: true, netPower: 0, connTo: [], built, buildPct: built ? 1 : 0.5, deconstructPct: 0, owner };
}

function h(over: Partial<TradeHistoryEntry>): TradeHistoryEntry {
  return { atMs: 0, dealId: 'd', outcome: 'settled', kind: 'sell', good: 'salvage', qty: 1, credits: 0, note: '', ...over };
}

describe('ownStorages', () => {
  it('lists only MY BUILT storage structures, Capital first', () => {
    const structures = new Map<number, StructureRenderState>([
      [5, st('me')], // cargo bay
      [7, st('me')], // capital
      [8, st('me')], // solar (not storage)
      [9, st('you')], // someone else's capital
      [10, st('me', false)], // my unbuilt cargo bay
    ]);
    const kinds: Record<number, string> = { 5: 'cargo_bay', 7: 'capital', 8: 'solar', 9: 'capital', 10: 'cargo_bay' };
    const list = ownStorages(structures, (id) => kinds[id], 'me');
    expect(list.map((s) => s.entityId)).toEqual([7, 5]);
    expect(list[0]!.label).toBe('Capital');
    // Labels never carry an entity id.
    for (const s of list) expect(s.label).not.toMatch(/\d{1,}$|#/);
  });

  it('numbers duplicate kinds instead of showing ids', () => {
    const structures = new Map<number, StructureRenderState>([[3, st('me')], [4, st('me')]]);
    const list = ownStorages(structures, () => 'cargo_bay', 'me');
    expect(list.map((s) => s.label)).toEqual(['Cargo Bay 1', 'Cargo Bay 2']);
    expect(ownStorages(structures, (id) => kinds[id], null)).toEqual([]);
  });
});

describe('toastForNotice', () => {
  it('danger for raids and fire (the escort prompt), good for settled, badge for outcomes', () => {
    expect(toastForNotice({ event: 'under_fire' })).toEqual({ tone: 'danger', unread: true });
    expect(toastForNotice({ event: 'raided' })).toEqual({ tone: 'danger', unread: true });
    expect(toastForNotice({ event: 'settled' })).toEqual({ tone: 'good', unread: true });
    expect(toastForNotice({ event: 'accepted' })).toEqual({ tone: 'good', unread: false });
    expect(toastForNotice({ event: 'rejected' }).unread).toBe(false);
    expect(toastForNotice({ event: 'inbound' })).toEqual({ tone: 'info', unread: false });
  });
});

describe('while-you-were-away', () => {
  it('keeps only entries newer than the watermark and summarises them', () => {
    const all = [
      h({ atMs: 50, outcome: 'settled', kind: 'sell', credits: 120 }),
      h({ atMs: 40, outcome: 'raided' }),
      h({ atMs: 30, outcome: 'settled', kind: 'buy', credits: 20 }),
      h({ atMs: 10, outcome: 'skipped' }),
    ];
    const unseen = unseenHistory(all, 20);
    expect(unseen).toHaveLength(3);
    expect(summarizeHistory(unseen)).toBe('2 deals settled · 1 hauler raided · +100 cr');
    expect(summarizeHistory([])).toBe('Nothing happened');
  });
});

describe('reputation display', () => {
  it('maps standing to a bar fill and a label', () => {
    expect(repFill(0)).toBe(0.5);
    expect(repFill(-1000)).toBe(0);
    expect(repFill(1000)).toBe(1);
    expect(repLabel(600)).toBe('Allied');
    expect(repLabel(0)).toBe('Neutral');
    expect(repLabel(-700)).toBe('Hostile');
  });
});
