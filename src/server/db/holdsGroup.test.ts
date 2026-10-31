/**
 * Hostile-review A5 (plan peppy-jumping-pinwheel P1a-1) — atomic persistence
 * groups. A value transfer (pod → ship) is ONE `GROUP` op applied inside a
 * SAVEPOINT: if any sub-op fails the WHOLE group rolls back (value stays in
 * exactly one holder), and unrelated ops in the same batch still commit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import { SyncSinkAdapter } from './SyncSinkAdapter.js';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => SqliteDb };

function put(uid: string, payload: string, type: string = 'pod'): PersistOp {
  return {
    type: 'HOLD_PUT', holderUid: uid, holderType: type as 'pod', ownerId: null, sectorKey: 's',
    x: 0, y: 0, payloadJson: payload, expiresAt: null, ts: 1,
  };
}

describe('holds persistence — atomic GROUP (A5)', () => {
  let db: SqliteDb;
  let sink: SyncSinkAdapter;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    sink = new SyncSinkAdapter(db as never);
  });

  const rows = () => db.prepare('SELECT holder_uid, payload_json FROM holds ORDER BY holder_uid').all() as Array<{ holder_uid: string; payload_json: string }>;

  it('a successful group lands every op together', () => {
    sink.enqueueCritical(put('pod-1', '{"goods":{"salvage":5},"credits":0,"blueprints":[]}'));
    sink.enqueueCritical({
      type: 'GROUP',
      ops: [put('ship-1', '{"goods":{"salvage":5},"credits":0,"blueprints":[]}', 'ship'), { type: 'HOLD_DELETE', holderUid: 'pod-1', ts: 2 }],
    });
    expect(rows().map((r) => r.holder_uid)).toEqual(['ship-1']);
  });

  it('a failing group rolls back ALONE — no half transfer, other writes survive', () => {
    sink.enqueueCritical(put('pod-1', '{"goods":{"salvage":5},"credits":0,"blueprints":[]}'));
    // Second sub-op violates NOT NULL (holder_type) → the whole group must undo,
    // including the pod delete that ran before it.
    const bad = { ...put('ship-1', 'x'), holderType: null } as unknown as PersistOp;
    sink.enqueueCritical({
      type: 'GROUP',
      ops: [{ type: 'HOLD_DELETE', holderUid: 'pod-1', ts: 2 }, bad],
    });
    sink.enqueueCritical(put('pod-2', '{"goods":{},"credits":1,"blueprints":[]}'));
    expect(sink.groupFailures).toBe(1);
    // pod-1 still holds its value (the delete rolled back); pod-2 committed.
    expect(rows().map((r) => r.holder_uid)).toEqual(['pod-1', 'pod-2']);
  });

  it('HOLD_PUT is an absolute upsert — replaying it is idempotent', () => {
    const op = put('pod-1', '{"goods":{"alloy":2},"credits":0,"blueprints":[]}');
    sink.enqueueCritical(op);
    sink.enqueueCritical(op);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.payload_json).toContain('"alloy":2');
  });
});
