/**
 * Lock for `SelectionStatsSubsystem` (structures follow-up Item B5,
 * invariant #13). Drives the select → emit / deselect → stop / target-death →
 * stop / disconnect → cleanup lifecycle through injected hooks (no live room).
 */
import { describe, it, expect, vi } from 'vitest';
import { SelectionStatsSubsystem, type Selection } from './SelectionStatsSubsystem.js';
import type { EntityStatsMessage } from '../../shared-types/messages/selectionMessages.js';

function statsFor(sel: Selection, hp: number): EntityStatsMessage {
  return { type: 'entity_stats', id: sel.id, kind: sel.kind, name: 'X', hp, hpMax: 100 };
}

describe('SelectionStatsSubsystem', () => {
  it('select → tick emits entity_stats to ONLY the selecting client', () => {
    const sent: Array<{ sessionId: string; msg: EntityStatsMessage }> = [];
    const sys = new SelectionStatsSubsystem({
      resolveStats: (sel) => statsFor(sel, 75),
      sendTo: (sessionId, msg) => sent.push({ sessionId, msg }),
    });
    sys.select('sess-1', 'p1', 'ship');
    sys.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: 'sess-1', msg: { id: 'p1', kind: 'ship', hp: 75 } });
  });

  it('deselect_entity stops the emission', () => {
    const sendTo = vi.fn();
    const sys = new SelectionStatsSubsystem({ resolveStats: (s) => statsFor(s, 50), sendTo });
    sys.select('sess-1', 'p1', 'ship');
    sys.tick();
    expect(sendTo).toHaveBeenCalledTimes(1);
    sys.deselect('sess-1');
    sys.tick();
    expect(sendTo).toHaveBeenCalledTimes(1); // no further emit
    expect(sys.activeCount).toBe(0);
  });

  it('target death (resolveStats → null) stops the emission AND clears the selection', () => {
    const sendTo = vi.fn();
    let alive = true;
    const sys = new SelectionStatsSubsystem({
      resolveStats: (s) => (alive ? statsFor(s, 10) : null),
      sendTo,
    });
    sys.select('sess-1', 'swarm-9', 'structure');
    sys.tick();
    expect(sendTo).toHaveBeenCalledTimes(1);
    // Entity dies.
    alive = false;
    sys.tick();
    expect(sendTo).toHaveBeenCalledTimes(1); // the dead tick sent nothing
    expect(sys.activeCount).toBe(0); // auto-cleared — no 5 Hz leak
    sys.tick();
    expect(sendTo).toHaveBeenCalledTimes(1);
  });

  it('clearSession (disconnect / transit) removes the selection — no leak', () => {
    const sendTo = vi.fn();
    const sys = new SelectionStatsSubsystem({ resolveStats: (s) => statsFor(s, 99), sendTo });
    sys.select('sess-1', 'p1', 'ship');
    sys.select('sess-2', 'swarm-3', 'structure');
    expect(sys.activeCount).toBe(2);
    sys.clearSession('sess-1');
    expect(sys.activeCount).toBe(1);
    sys.tick();
    expect(sendTo).toHaveBeenCalledTimes(1);
    expect(sendTo).toHaveBeenCalledWith('sess-2', expect.objectContaining({ id: 'swarm-3' }));
  });

  it('re-select replaces the prior selection for the same session', () => {
    const sent: EntityStatsMessage[] = [];
    const sys = new SelectionStatsSubsystem({
      resolveStats: (s) => statsFor(s, 1),
      sendTo: (_s, msg) => sent.push(msg),
    });
    sys.select('sess-1', 'p1', 'ship');
    sys.select('sess-1', 'swarm-2', 'structure');
    expect(sys.activeCount).toBe(1);
    sys.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe('swarm-2');
  });
});
