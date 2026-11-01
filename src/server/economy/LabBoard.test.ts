import { describe, expect, it } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { LAB_JOBS_STATE_KEY, LabBoard, type LabJobRecord } from './LabBoard.js';

function sinkCapture(): { sink: IPersistenceSink; ops: PersistOp[] } {
  const ops: PersistOp[] = [];
  const sink = { enqueueCritical: (op: PersistOp) => ops.push(op) } as unknown as IPersistenceSink;
  return { sink, ops };
}

const job = (labUid: string): LabJobRecord => ({
  labUid,
  owner: 'p1',
  sectorKey: 'sol-prime',
  spec: { kind: 'copy', uid: 'b1', runs: 3 },
  inputs: [{ uid: 'b1', product: 'hull:gunship', kind: 'bpo', runs: null, material: 2, output: 30, research: 0 }],
  pulses: 45,
  done: 0,
  seed: 7,
  startedAtMs: 1,
});

describe('LabBoard (economy v2 W3)', () => {
  it('persists the whole board as one economy-state row and hydrates it back', () => {
    const { sink, ops } = sinkCapture();
    const board = new LabBoard({ persistence: () => sink, now: () => 5 });
    board.set(job('lab-a'));
    board.advance('lab-a');
    board.advance('lab-a');
    board.persistNow();
    const put = ops[0] as Extract<PersistOp, { type: 'ECON_STATE_PUT' }>;
    expect(put.type).toBe('ECON_STATE_PUT');
    expect(put.key).toBe(LAB_JOBS_STATE_KEY);
    const back = new LabBoard({ persistence: () => null });
    back.hydrate(put.payloadJson);
    expect(back.get('lab-a')).toEqual({ ...job('lab-a'), done: 2 });
  });

  it('progress saves only when a job advanced; advance reports completion', () => {
    const { sink, ops } = sinkCapture();
    const board = new LabBoard({ persistence: () => sink });
    board.set({ ...job('lab-a'), pulses: 2 });
    board.flushProgress();
    expect(ops).toHaveLength(0);
    expect(board.advance('lab-a')).toBe(false);
    expect(board.advance('lab-a')).toBe(true);
    board.flushProgress();
    expect(ops).toHaveLength(1);
    board.flushProgress();
    expect(ops).toHaveLength(1);
  });

  it('drops corrupt rows on hydrate (bad JSON, bad spec, no inputs)', () => {
    const board = new LabBoard({ persistence: () => null });
    board.hydrate('not json');
    expect(board.all()).toEqual([]);
    board.hydrate(JSON.stringify([
      { ...job('ok') },
      { ...job('bad-spec'), spec: { kind: 'nope' } },
      { ...job('no-inputs'), inputs: [] },
      { ...job('bad-pulses'), pulses: 0 },
    ]));
    expect(board.all().map((r) => r.labUid)).toEqual(['ok']);
  });
});
