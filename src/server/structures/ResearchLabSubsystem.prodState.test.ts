/**
 * Research Lab work state on the room row (`prodState`), read by the client's
 * work glow: running while a job advances, unpowered with a job and no power,
 * blocked when a finished job has no storage to deliver into, none when idle.
 * A lab's blueprints are taken at job start, so it is never `starved`.
 */
import { describe, expect, it } from 'vitest';
import { LabBoard, type LabJobRecord } from '../economy/LabBoard.js';
import type { StorageService } from '../cargo/StorageService.js';
import { PROD_STATE } from '../../shared-types/production.js';
import { ResearchLabSubsystem, RESEARCH_LAB_KIND } from './ResearchLabSubsystem.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';

const job = (labUid: string, pulses: number): LabJobRecord => ({
  labUid,
  owner: 'p1',
  sectorKey: 'sol-prime',
  spec: { kind: 'copy', uid: 'b1', runs: 3 },
  inputs: [{ uid: 'b1', product: 'hull:gunship', kind: 'bpo', runs: null, material: 2, output: 30, research: 0 }],
  pulses,
  done: 0,
  seed: 7,
  startedAtMs: 1,
});

function rig() {
  const registry = new StructureRegistry();
  const lab = { id: 'lab', uid: 'lab-uid', kind: RESEARCH_LAB_KIND, owner: 'p1', isConstructed: true, x: 0, y: 0 } as StructureRecord;
  const store = { id: 'store', kind: 'storage', owner: 'p1', isConstructed: true, x: 0, y: 0 } as StructureRecord;
  registry.add(lab);
  const board = new LabBoard({ persistence: () => null });
  let power = true;
  let connected = true;
  const writes: number[] = [];
  const storage = {
    networkFor: () => (connected ? [store] : []),
    commitChanged: () => {},
  } as unknown as StorageService;
  const labs = new ResearchLabSubsystem({
    board: () => board,
    wallet: () => ({ debitDeferred: () => null, flush: () => {} }) as never,
    storage,
    registry,
    powered: () => power,
    sectorKey: () => 'sol-prime',
  });
  // Count real writes to the row field (rows patch on change).
  let state = lab.prodState;
  Object.defineProperty(lab, 'prodState', {
    get: () => state,
    set: (v) => { state = v; writes.push(v); },
  });
  return {
    lab, board, labs, writes,
    setPower: (v: boolean) => { power = v; },
    setConnected: (v: boolean) => { connected = v; },
  };
}

describe('Research Lab prodState (work glow)', () => {
  it('idle lab stays none (no write)', () => {
    const r = rig();
    r.labs.pulse();
    expect(r.lab.prodState ?? PROD_STATE.none).toBe(PROD_STATE.none);
    expect(r.writes).toEqual([]);
  });

  it('running while the job advances, written once', () => {
    const r = rig();
    r.board.set(job('lab-uid', 10));
    r.labs.pulse();
    r.labs.pulse();
    expect(r.lab.prodState).toBe(PROD_STATE.running);
    expect(r.writes).toEqual([PROD_STATE.running]);
  });

  it('unpowered with a job and no power; back to running on power', () => {
    const r = rig();
    r.board.set(job('lab-uid', 10));
    r.setPower(false);
    r.labs.pulse();
    expect(r.lab.prodState).toBe(PROD_STATE.unpowered);
    expect(r.board.get('lab-uid')!.done).toBe(0);
    r.setPower(true);
    r.labs.pulse();
    expect(r.lab.prodState).toBe(PROD_STATE.running);
  });

  it('none once the job finishes and delivers', () => {
    const r = rig();
    r.board.set(job('lab-uid', 2));
    r.labs.pulse();
    expect(r.lab.prodState).toBe(PROD_STATE.running);
    r.labs.pulse();
    expect(r.board.get('lab-uid')).toBeUndefined();
    expect(r.lab.prodState).toBe(PROD_STATE.none);
  });

  it('blocked while a finished job waits for storage', () => {
    const r = rig();
    r.board.set(job('lab-uid', 1));
    r.setConnected(false);
    r.labs.pulse();
    expect(r.board.get('lab-uid')).toBeDefined();
    expect(r.lab.prodState).toBe(PROD_STATE.blocked);
    r.setConnected(true);
    r.labs.pulse();
    expect(r.lab.prodState).toBe(PROD_STATE.none);
  });
});
