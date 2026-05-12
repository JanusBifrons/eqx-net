import { describe, it, expect, beforeEach } from 'vitest';
import {
  PlayerShipStore,
  PlayerShipRecord,
  RosterFullError,
  ROSTER_CAP,
  applyKindVersionDrift,
} from './PlayerShipStore.js';
import { SHIP_KIND_CATALOGUE_VERSION, getShipKind } from '../../shared-types/shipKinds.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

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

let nextId = 0;
function deterministicUuid(): string {
  nextId += 1;
  return `ship-${String(nextId).padStart(4, '0')}`;
}

function makeStore(sink: MockSink): PlayerShipStore {
  nextId = 0;
  return new PlayerShipStore({
    persistence: sink,
    generateShipId: deterministicUuid,
    now: () => 1_000_000,
  });
}

describe('PlayerShipStore', () => {
  let sink: MockSink;
  let store: PlayerShipStore;

  beforeEach(() => {
    sink = makeSink();
    store = makeStore(sink);
  });

  describe('create', () => {
    it('assigns a fresh shipId and indexes by player', () => {
      const rec = store.create({
        playerId: 'p1',
        userId: 'user-a',
        kind: 'fighter',
        sectorKey: 'sol-prime',
        x: 100,
        y: -50,
        health: 100,
      });
      expect(rec.shipId).toBe('ship-0001');
      expect(rec.kindVersion).toBe(SHIP_KIND_CATALOGUE_VERSION);
      expect(store.get('ship-0001')).toEqual(rec);
      expect(store.listByPlayer('p1')).toEqual([rec]);
      expect(store.count('p1')).toBe(1);
    });

    it('shadows a PLAYER_SHIP_PUT through the sink', () => {
      store.create({
        playerId: 'p1',
        userId: null,
        kind: 'scout',
        sectorKey: 'sol-prime',
        x: 0,
        y: 0,
        health: 50,
      });
      expect(sink.ops).toHaveLength(1);
      const op = sink.ops[0]!;
      expect(op.type).toBe('PLAYER_SHIP_PUT');
      if (op.type !== 'PLAYER_SHIP_PUT') throw new Error('unreachable');
      expect(op.shipId).toBe('ship-0001');
      expect(op.kind).toBe('scout');
      expect(op.health).toBe(50);
      expect(op.isActive).toBe(false);
    });

    it('rejects creation past ROSTER_CAP', () => {
      for (let i = 0; i < ROSTER_CAP; i++) {
        store.create({
          playerId: 'p1',
          userId: null,
          kind: 'fighter',
          sectorKey: 'sol-prime',
          x: 0, y: 0, health: 100,
        });
      }
      expect(store.count('p1')).toBe(ROSTER_CAP);
      expect(() => store.create({
        playerId: 'p1',
        userId: null,
        kind: 'fighter',
        sectorKey: 'sol-prime',
        x: 0, y: 0, health: 100,
      })).toThrow(RosterFullError);
    });

    it('different players have independent caps', () => {
      for (let i = 0; i < ROSTER_CAP; i++) {
        store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 'a', x: 0, y: 0, health: 100 });
      }
      // p2 still has 0/10 — should succeed.
      const rec = store.create({ playerId: 'p2', userId: null, kind: 'fighter', sectorKey: 'a', x: 0, y: 0, health: 100 });
      expect(rec).toBeDefined();
      expect(store.count('p2')).toBe(1);
    });
  });

  describe('listByPlayer', () => {
    it('returns empty for an unknown player', () => {
      expect(store.listByPlayer('nobody')).toEqual([]);
    });

    it('returns all ships for a player', () => {
      const a = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      const b = store.create({ playerId: 'p1', userId: null, kind: 'scout',   sectorKey: 's', x: 1, y: 1, health: 60 });
      const others = store.listByPlayer('p1').map((r) => r.shipId).sort();
      expect(others).toEqual([a.shipId, b.shipId].sort());
    });
  });

  describe('delete', () => {
    it('removes a ship and shadows DELETE through the sink', () => {
      const rec = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      sink.ops.length = 0;
      expect(store.delete(rec.shipId)).toBe(true);
      expect(store.get(rec.shipId)).toBeNull();
      expect(store.listByPlayer('p1')).toEqual([]);
      expect(store.count('p1')).toBe(0);
      expect(sink.ops).toHaveLength(1);
      expect(sink.ops[0]!.type).toBe('PLAYER_SHIP_DELETE');
    });

    it('returns false for an unknown shipId and does not shadow', () => {
      expect(store.delete('not-a-ship')).toBe(false);
      expect(sink.ops).toHaveLength(0);
    });

    it('frees a roster slot, allowing a fresh spawn at cap', () => {
      const ships: PlayerShipRecord[] = [];
      for (let i = 0; i < ROSTER_CAP; i++) {
        ships.push(store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 }));
      }
      expect(() => store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 })).toThrow(RosterFullError);
      store.delete(ships[0]!.shipId);
      const fresh = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      expect(fresh).toBeDefined();
      expect(store.count('p1')).toBe(ROSTER_CAP);
    });
  });

  describe('markActive / markStored', () => {
    it('markActive flips state, captures pose, and bumps expiresAt', () => {
      const rec = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      const updated = store.markActive(rec.shipId, 'galaxy-sol-prime', {
        x: 500, y: -300, vx: 1, vy: -2, angle: 0.5, angvel: 0.1, health: 80, lastFireClientTick: 99,
      });
      expect(updated).not.toBeNull();
      expect(updated!.isActive).toBe(true);
      expect(updated!.activeRoomId).toBe('galaxy-sol-prime');
      expect(updated!.lastX).toBe(500);
      expect(updated!.health).toBe(80);
      expect(updated!.lastFireClientTick).toBe(99);
      expect(updated!.expiresAt).toBeGreaterThan(0);
    });

    it('markStored flips state, freezes pose, clears expiresAt', () => {
      const rec = store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      store.markActive(rec.shipId, 'r', { x: 1, y: 1, vx: 0, vy: 0, angle: 0, angvel: 0, health: 90 });
      const stored = store.markStored(rec.shipId, {
        x: 1234, y: -567, vx: 0, vy: 0, angle: 0.2, angvel: 0, health: 90, sectorKey: 'orion-belt',
      });
      expect(stored).not.toBeNull();
      expect(stored!.isActive).toBe(false);
      expect(stored!.activeRoomId).toBeNull();
      expect(stored!.lastSectorKey).toBe('orion-belt');
      expect(stored!.expiresAt).toBe(0);
    });

    it('markActive on missing shipId returns null without throwing', () => {
      expect(store.markActive('nope', 'r', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, health: 1 })).toBeNull();
    });
  });

  describe('hydrate', () => {
    function row(over: Partial<PlayerShipRecord>): PlayerShipRecord {
      return {
        shipId: 's',
        playerId: 'p1',
        userId: null,
        kind: 'fighter',
        kindVersion: SHIP_KIND_CATALOGUE_VERSION,
        health: 100,
        lastSectorKey: 'sol-prime',
        lastX: 0, lastY: 0, lastVx: 0, lastVy: 0, lastAngle: 0, lastAngvel: 0,
        lastFireClientTick: 0,
        isActive: false,
        activeRoomId: null,
        expiresAt: 0,
        createdAt: 0,
        updatedAt: 0,
        ...over,
      };
    }

    it('seeds in-memory state without shadowing through the sink', () => {
      const r = row({ shipId: 's1', kind: 'scout', health: 42 });
      store.hydrate([r]);
      expect(store.get('s1')).toMatchObject({ kind: 'scout', health: 42 });
      expect(store.count('p1')).toBe(1);
      expect(sink.ops).toHaveLength(0); // no shadow when versions match
    });

    it('catalogue drift clamps health to current maxHealth and bumps kindVersion', () => {
      const fighter = getShipKind('fighter');
      // Simulate a row saved at an older catalogue version with health
      // exceeding the current max — should clamp down.
      const r = row({
        shipId: 's1',
        kind: 'fighter',
        kindVersion: SHIP_KIND_CATALOGUE_VERSION - 1,
        health: fighter.maxHealth + 50,
      });
      store.hydrate([r]);
      const got = store.get('s1');
      expect(got).not.toBeNull();
      expect(got!.health).toBe(fighter.maxHealth);
      expect(got!.kindVersion).toBe(SHIP_KIND_CATALOGUE_VERSION);
      // Drift correction persists the fixed row.
      expect(sink.ops.some((op) => op.type === 'PLAYER_SHIP_PUT')).toBe(true);
    });

    it('drift does not gift hull when stored health is below current maxHealth', () => {
      const fighter = getShipKind('fighter');
      const r = row({
        shipId: 's1',
        kind: 'fighter',
        kindVersion: SHIP_KIND_CATALOGUE_VERSION - 1,
        health: Math.max(1, fighter.maxHealth - 30),
      });
      store.hydrate([r]);
      expect(store.get('s1')!.health).toBe(Math.max(1, fighter.maxHealth - 30));
    });
  });

  describe('applyKindVersionDrift (pure)', () => {
    it('returns the same reference when kindVersion is current', () => {
      const r: PlayerShipRecord = {
        shipId: 's', playerId: 'p', userId: null, kind: 'fighter',
        kindVersion: SHIP_KIND_CATALOGUE_VERSION, health: 50,
        lastSectorKey: 's', lastX: 0, lastY: 0, lastVx: 0, lastVy: 0, lastAngle: 0, lastAngvel: 0,
        lastFireClientTick: 0, isActive: false, activeRoomId: null, expiresAt: 0, createdAt: 0, updatedAt: 0,
      };
      expect(applyKindVersionDrift(r)).toBe(r);
    });
  });

  describe('size', () => {
    it('reflects total rows across all players', () => {
      expect(store.size()).toBe(0);
      store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      store.create({ playerId: 'p2', userId: null, kind: 'fighter', sectorKey: 's', x: 0, y: 0, health: 100 });
      expect(store.size()).toBe(2);
    });
  });
});
