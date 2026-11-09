import { describe, it, expect } from 'vitest';
import { SceneWorkCounters, CPU_BATCH_TICKS } from './SceneWorkCounters.js';

describe('SceneWorkCounters', () => {
  it('averages the counts per tick and per snapshot', () => {
    const w = new SceneWorkCounters();
    w.active = true;
    for (let i = 0; i < 4; i++) {
      w.swarmRecords += 10; w.swarmBytes += 300; w.contacts += 1;
      if (i % 2 === 0) { w.snapshots++; w.snapshotEntities += 8; }
      w.endTick(40, 30);
    }
    const v = w.view(null);
    expect(v).toMatchObject({
      ticks: 4, bodiesPerTick: 40, aiAgentsPerTick: 30, contactsPerTick: 1,
      swarmRecordsPerTick: 10, swarmBytesPerTick: 300, snapshotsPerTick: 0.5, entitiesPerSnapshot: 8, workerElu: null,
    });
    // No CPU batch completed yet: the print-only CPU numbers say so.
    expect(v.cpuMsPerTick).toBeNull();
  });

  it('reports process CPU once a batch of ticks has run', () => {
    const w = new SceneWorkCounters();
    w.active = true;
    for (let i = 0; i < CPU_BATCH_TICKS; i++) w.endTick(1, 1);
    const v = w.view(0.25);
    expect(v.cpuMsPerTick).not.toBeNull();
    expect(v.wallMsPerTick).not.toBeNull();
    expect(v.workerElu).toBe(0.25);
  });

  it('an empty window reads zeros, never NaN', () => {
    const v = new SceneWorkCounters().view(null);
    expect(v.ticks).toBe(0);
    expect(v.bodiesPerTick).toBe(0);
    expect(v.entitiesPerSnapshot).toBe(0);
  });
});
