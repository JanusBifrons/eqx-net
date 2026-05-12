import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LimboStore,
  LIMBO_DISCONNECT_TTL_MS,
  LIMBO_TRANSIT_TTL_MS,
  type LimboPayload,
} from './LimboStore.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

function makePayload(over: Partial<LimboPayload> = {}): LimboPayload {
  return {
    x: 100,
    y: 200,
    vx: 1.5,
    vy: -0.5,
    angle: 0.3,
    angvel: 0,
    health: 75,
    lastFireClientTick: 1234,
    userId: 'user-abc',
    sectorKey: 'sol-prime',
    ...over,
  };
}

interface MockSink extends IPersistenceSink {
  ops: PersistOp[];
}

function makeSink(): MockSink {
  const ops: PersistOp[] = [];
  return {
    ops,
    enqueueCritical(op) { ops.push(op); },
    enqueueVolatile(op) { ops.push(op); },
    enqueueCriticalAwaitable(op) { ops.push(op); return Promise.resolve({}); },
    shutdown() { return Promise.resolve({ drained: 0 }); },
  };
}

describe('LimboStore', () => {
  let sink: MockSink;
  let store: LimboStore;

  beforeEach(() => {
    sink = makeSink();
    store = new LimboStore({ persistence: sink });
  });

  describe('put + take', () => {
    it('round-trips a payload via take', () => {
      const t0 = 1_000_000;
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS, t0);
      const out = store.take('p1', t0 + 1000);
      expect(out).not.toBeNull();
      expect(out!.payload.x).toBe(100);
      expect(out!.payload.health).toBe(75);
    });

    it('second take returns null', () => {
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
      expect(store.take('p1')).not.toBeNull();
      expect(store.take('p1')).toBeNull();
    });

    it('shadows put through the sink with the right shape', () => {
      const t0 = 1_000_000;
      store.put('p1', makePayload({ sectorKey: 'orion-belt', userId: 'u1' }), LIMBO_TRANSIT_TTL_MS, t0);
      expect(sink.ops).toHaveLength(1);
      const op = sink.ops[0]!;
      expect(op.type).toBe('LIMBO_PUT');
      if (op.type === 'LIMBO_PUT') {
        expect(op.playerId).toBe('p1');
        expect(op.userId).toBe('u1');
        expect(op.sectorKey).toBe('orion-belt');
        expect(op.expiresAt).toBe(t0 + LIMBO_TRANSIT_TTL_MS);
        const decoded = JSON.parse(op.payloadJson) as LimboPayload;
        expect(decoded.x).toBe(100);
      }
    });

    it('shadows take through the sink as a LIMBO_DELETE', () => {
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
      sink.ops.length = 0;
      store.take('p1');
      expect(sink.ops).toHaveLength(1);
      expect(sink.ops[0]!.type).toBe('LIMBO_DELETE');
    });

    it('overwriting via put replaces in memory; sink sees two PUTs', () => {
      store.put('p1', makePayload({ x: 1 }), LIMBO_DISCONNECT_TTL_MS);
      store.put('p1', makePayload({ x: 2 }), LIMBO_DISCONNECT_TTL_MS);
      expect(store.size()).toBe(1);
      expect(store.take('p1')!.payload.x).toBe(2);
      expect(sink.ops.filter((o) => o.type === 'LIMBO_PUT')).toHaveLength(2);
    });
  });

  describe('peek', () => {
    it('returns the entry without delete', () => {
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
      const seen = store.peek('p1');
      expect(seen).not.toBeNull();
      // Take after peek still works.
      expect(store.take('p1')).not.toBeNull();
    });

    it('peek returns null for expired entries (without deleting)', () => {
      const t0 = 1_000_000;
      store.put('p1', makePayload(), 100, t0);
      expect(store.peek('p1', t0 + 200)).toBeNull();
      expect(store.size()).toBe(1); // peek did not evict
    });

    it('peek does NOT shadow through the sink', () => {
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
      sink.ops.length = 0;
      store.peek('p1');
      expect(sink.ops).toHaveLength(0);
    });
  });

  describe('TTL semantics', () => {
    it('take returns null when TTL has elapsed', () => {
      const t0 = 1_000_000;
      store.put('p1', makePayload(), 1000, t0);
      const out = store.take('p1', t0 + 1500);
      expect(out).toBeNull();
    });

    it('disconnect TTL is much longer than transit TTL', () => {
      expect(LIMBO_DISCONNECT_TTL_MS).toBeGreaterThan(LIMBO_TRANSIT_TTL_MS);
      expect(LIMBO_DISCONNECT_TTL_MS).toBe(900_000);
      expect(LIMBO_TRANSIT_TTL_MS).toBe(30_000);
    });
  });

  describe('prune', () => {
    it('evicts only expired entries and shadows each through the sink', () => {
      const t0 = 1_000_000;
      store.put('p1', makePayload(), 1000, t0);
      store.put('p2', makePayload(), 5000, t0);
      store.put('p3', makePayload(), 10000, t0);
      sink.ops.length = 0;
      const evicted = store.prune(t0 + 2000);
      expect(evicted).toBe(1);
      expect(store.size()).toBe(2);
      expect(sink.ops).toHaveLength(1);
      expect(sink.ops[0]!.type).toBe('LIMBO_DELETE');
    });

    it('returns 0 when nothing is expired', () => {
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
      expect(store.prune()).toBe(0);
    });
  });

  describe('hydrate', () => {
    it('populates the in-memory map without firing sink ops', () => {
      const t0 = 1_000_000;
      store.hydrate([
        { playerId: 'p1', payload: makePayload(), expiresAt: t0 + 100_000, createdAt: t0 },
        { playerId: 'p2', payload: makePayload(), expiresAt: t0 + 100_000, createdAt: t0 },
      ]);
      expect(store.size()).toBe(2);
      expect(sink.ops).toHaveLength(0);
      expect(store.peek('p1', t0)).not.toBeNull();
    });
  });

  describe('delete', () => {
    it('removes an existing entry and shadows', () => {
      store.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
      sink.ops.length = 0;
      store.delete('p1');
      expect(store.size()).toBe(0);
      expect(sink.ops).toHaveLength(1);
      expect(sink.ops[0]!.type).toBe('LIMBO_DELETE');
    });

    it('is a no-op when the entry is missing — no sink op fired', () => {
      store.delete('nonexistent');
      expect(sink.ops).toHaveLength(0);
    });
  });

  describe('startPruneTimer / stopPruneTimer', () => {
    it('runs prune on the configured interval and stops cleanly', () => {
      vi.useFakeTimers();
      try {
        const t0 = Date.now();
        store.put('p1', makePayload(), 1000, t0);
        store.startPruneTimer(500);
        // First tick at +500 (entry still valid).
        vi.advanceTimersByTime(500);
        expect(store.size()).toBe(1);
        // After +1500 the entry is expired and the next tick prunes it.
        vi.advanceTimersByTime(1000);
        expect(store.size()).toBe(0);
        store.stopPruneTimer();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('works with no persistence sink (in-memory only)', () => {
    const noSink = new LimboStore({});
    noSink.put('p1', makePayload(), LIMBO_DISCONNECT_TTL_MS);
    expect(noSink.take('p1')).not.toBeNull();
  });
});
