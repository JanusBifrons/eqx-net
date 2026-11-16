/**
 * Phase 6b — regression lock for the "I can't see my lingering ships at
 * all" bug (2026-05-13, two iterations in).
 *
 * The path under test:
 *
 *   server sends snapshot with `state.isActive === false` entries
 *     ↓
 *   `ColyseusGameClient.handleSnapshot` (private) keys them in the ONE
 *   ship list `mirror.ships` by shipInstanceId (RTS Part A S3), never by
 *   the playerId (which would collide with the same player's active hull)
 *     ↓
 *   the entry carries pose + ownerPlayerId + `isActive: false`; identity
 *   (kind, displayName) arrives separately via the Colyseus state diff
 *   handled by `syncMirror`, which writes to the same entry
 *     ↓
 *   the ONE ship sprite path (`shipSpriteUpdater`) draws it. Sprite
 *   caching is per key; if `ship.kind` changes after the sprite is built
 *   (the schema diff arrives after the first snapshot), it rebuilds
 *
 * The bug at first iteration: `if (!ship.kind) continue;` in the
 * renderer caused lingering hulls to be permanently invisible whenever
 * the snapshot wrote the entry before the schema diff filled in `kind`.
 * The renderer never retried because the entry's kind stayed undefined
 * until syncMirror ran (which it does, but the renderer was already
 * skipping every frame).
 *
 * The bug at second iteration (this regression lock targets it): same
 * symptom from a different cause — if the snapshot's `isActive=false`
 * entry isn't routed into the mirror at all (or is removed by an
 * over-aggressive cleanup pass), the user sees nothing.
 *
 * We test the routing in isolation by invoking the private handler via
 * a narrow structural cast. The harness covers:
 *   - First snapshot with a lingering hull → a `mirror.ships` entry under
 *     its shipInstanceId with pose + ownerPlayerId, no kind yet
 *   - Subsequent snapshot → pose updated (no body yet: snapshot pose),
 *     ownerPlayerId + kind preserved
 *   - Lingering hull disappears from the snapshot → entry removed
 *   - Active hull for the SAME playerId co-exists → never keyed as a hull
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

type Internals = {
  handleSnapshot: (snap: SnapshotMessage) => void;
};

function asInternals(c: ColyseusGameClient): Internals {
  return c as unknown as Internals;
}

/** Parked hulls in the one ship list (`isActive: false`). */
function hullCount(c: ColyseusGameClient): number {
  let n = 0;
  for (const s of c.mirror.ships.values()) if (s.isActive === false) n++;
  return n;
}

function makeSnapshot(states: SnapshotMessage['states']): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick: 100,
    states,
    ackedTick: 0,
  };
}

function lingeringEntry(playerId: string): SnapshotMessage['states'][string] {
  return {
    x: 100, y: -200,
    vx: 0, vy: 0,
    angle: 0.5, angvel: 0,
    playerId,
    isActive: false,
  };
}

function activeEntry(playerId: string): SnapshotMessage['states'][string] {
  return {
    x: 50, y: 80,
    vx: 1, vy: -2,
    angle: 0, angvel: 0,
    playerId,
    isActive: true,
  };
}

describe('ColyseusClient.handleSnapshot — Phase 6b lingering routing', () => {
  let client: ColyseusGameClient;

  beforeEach(() => {
    client = new ColyseusGameClient();
    // Welcome would normally set this. Tests that exercise the
    // self-vs-remote branching need a non-null localPlayerId.
    (client.mirror as { localPlayerId: string | null }).localPlayerId = 'local-player';
  });

  it('routes an isActive=false entry into the one ship list keyed by shipInstanceId', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    expect(client.mirror.ships).toBeDefined();
    expect(hullCount(client)).toBe(1);
    const entry = client.mirror.ships.get('ship-uuid-LINGER');
    expect(entry).toBeDefined();
    expect(entry!.x).toBe(100);
    expect(entry!.y).toBe(-200);
    expect(entry!.angle).toBe(0.5);
    expect(entry!.ownerPlayerId).toBe('player-A');
  });

  it('never keys the parked hull by its owner playerId', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    // mirror.ships shouldn't have a player-A entry — the only ship for
    // player-A in this snapshot is parked, and a parked hull is keyed by
    // its shipInstanceId.
    expect(client.mirror.ships.get('player-A')).toBeUndefined();
  });

  it('updates pose on a follow-up snapshot, preserves ownerPlayerId, keeps existing kind', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    // Simulate the schema-diff path having populated kind.
    const first = client.mirror.ships.get('ship-uuid-LINGER')!;
    (first as { kind?: string }).kind = 'interceptor';

    // Next snapshot with new pose, same id.
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': {
        ...lingeringEntry('player-A'),
        x: 999, y: 999,
      },
    }));
    const second = client.mirror.ships.get('ship-uuid-LINGER')!;
    expect(second.x).toBe(999);
    expect(second.y).toBe(999);
    expect(second.ownerPlayerId).toBe('player-A');
    expect(second.kind).toBe('interceptor');  // preserved
  });

  it('removes a lingering hull from the mirror when it disappears from the snapshot', () => {
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER': lingeringEntry('player-A'),
    }));
    expect(hullCount(client)).toBe(1);
    // Snapshot without the lingering hull (server evicted it).
    asInternals(client).handleSnapshot(makeSnapshot({}));
    expect(hullCount(client)).toBe(0);
  });

  it('active + lingering for the same playerId: the hull keys by shipInstanceId, the active ship never does', () => {
    // Note: handleSnapshot does NOT itself populate mirror.ships — that
    // is `syncMirror`'s job (from the Colyseus state diff). What we
    // verify here is that the snapshot's `isActive=false` routing only
    // keys parked hulls by shipInstanceId and never accidentally keys an
    // active hull that way.
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER':   lingeringEntry('player-A'),
      'ship-uuid-FRESH':    activeEntry('player-A'),
    }));
    // The parked hull keys by its shipInstanceId.
    expect(client.mirror.ships.get('ship-uuid-LINGER')).toBeDefined();
    // The active hull is never keyed by its shipInstanceId.
    expect(client.mirror.ships.get('ship-uuid-FRESH')).toBeUndefined();
    expect(hullCount(client)).toBe(1);
  });

  it('handles multiple lingering hulls for the same player simultaneously', () => {
    // Phase 6b's whole point: a player can have N lingering hulls in
    // the same sector. Parked hulls are keyed by shipInstanceId
    // so they don't overwrite each other.
    asInternals(client).handleSnapshot(makeSnapshot({
      'ship-uuid-LINGER-1': lingeringEntry('player-A'),
      'ship-uuid-LINGER-2': { ...lingeringEntry('player-A'), x: 200 },
      'ship-uuid-LINGER-3': { ...lingeringEntry('player-A'), x: 300 },
    }));
    expect(hullCount(client)).toBe(3);
    expect(client.mirror.ships.get('ship-uuid-LINGER-1')!.x).toBe(100);
    expect(client.mirror.ships.get('ship-uuid-LINGER-2')!.x).toBe(200);
    expect(client.mirror.ships.get('ship-uuid-LINGER-3')!.x).toBe(300);
  });

  it('regression: lingering hull stays visible across many follow-up snapshots (the original bug)', () => {
    // The "I can't see my lingering ships at all" symptom would manifest
    // here as the entry being absent after the first iteration of the
    // cleanup loop. Run several snapshots in a row and assert the entry
    // is still there.
    for (let i = 0; i < 10; i++) {
      asInternals(client).handleSnapshot(makeSnapshot({
        'ship-uuid-LINGER': {
          ...lingeringEntry('player-A'),
          x: i * 10,
        },
      }));
    }
    expect(hullCount(client)).toBe(1);
    const entry = client.mirror.ships.get('ship-uuid-LINGER')!;
    expect(entry.x).toBe(90);  // last snapshot's pose
    expect(entry.ownerPlayerId).toBe('player-A');
  });
});
